import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createBridgeServer, type RunningBridgeServer } from '../app.ts';
import { CSRF_HEADER_NAME } from './guard.ts';
import { isBlockedIp, resolveAndValidateWebhookUrl } from './ssrf.ts';
import { CredentialVault, PassphraseRamSealer, WindowsDpapiSealer } from './vault.ts';

describe('P0 Security Layer & Off-Main-Thread SQLite Bridge', () => {
  let tmpDir: string;
  let bridge: RunningBridgeServer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openview-p0-'));
    bridge = await createBridgeServer({
      host: '127.0.0.1',
      port: 0,
      webPort: 5173,
      dbPath: path.join(tmpDir, 'test.sqlite'),
      vaultKeyPath: path.join(tmpDir, 'vault.master.bin'),
      sealer: new PassphraseRamSealer('test-passphrase-strong-123', Buffer.from('test-salt')),
    });
  });

  afterAll(async () => {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs node:sqlite strictly off the main thread in WAL mode', async () => {
    const res = await fetch(`${bridge.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sqliteOffMainThread: boolean;
      vaultUnlocked: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.sqliteOffMainThread).toBe(true);
    expect(body.vaultUnlocked).toBe(true);
  });

  it('rejects DNS-rebinding Host headers with 403', async () => {
    const response = await bridge.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.attacker.example' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects disallowed Origin headers on HTTP with 403', async () => {
    const res = await fetch(`${bridge.url}/api/v1/auth/session`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin WebSocket upgrade (CSWSH) with HTTP 403 before upgrade', async () => {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${bridge.wsUrl}?ticket=fake`, {
        headers: { Origin: 'https://evil.example' },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        reject(new Error('Cross-origin WS upgrade should never succeed'));
      });
      ws.on('error', () => {});
    });
    expect(statusCode).toBe(403);
  });

  it('rejects missing or invalid WS tickets with HTTP 401 before upgrade', async () => {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(bridge.wsUrl, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        reject(new Error('Unauthenticated WS upgrade should never succeed'));
      });
      ws.on('error', () => {});
    });
    expect(statusCode).toBe(401);
  });

  it('authenticates session -> single-use WS ticket -> hello + ping/pong and rejects ticket replay', async () => {
    const sessionRes = await fetch(`${bridge.url}/api/v1/auth/session`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(sessionRes.status).toBe(200);
    const { token } = (await sessionRes.json()) as { token: string };

    const ticketRes = await fetch(`${bridge.url}/api/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        [CSRF_HEADER_NAME]: token,
      },
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const messages = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const collected: Array<Record<string, unknown>> = [];
      const ws = new WebSocket(`${bridge.wsUrl}?ticket=${encodeURIComponent(ticket)}`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'ping', id: 7, ts: 123456 }));
      });
      ws.on('message', (data) => {
        collected.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
        if (collected.length === 2) {
          ws.close();
          resolve(collected);
        }
      });
      ws.on('error', reject);
    });

    expect(messages[0]?.type).toBe('hello');
    expect(messages[1]?.type).toBe('pong');
    expect(messages[1]?.id).toBe(7);

    // Replaying the same single-use ticket must be rejected with 401
    const replayStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${bridge.wsUrl}?ticket=${encodeURIComponent(ticket)}`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    expect(replayStatus).toBe(401);
  });

  it('encrypts secrets with AES-256-GCM + provider-bound AAD and rejects tampering', () => {
    const secret = JSON.stringify({ apiKey: 'upstox-key', apiSecret: 'top-secret' });
    const sealed = bridge.vault.encryptSecret('upstox', secret);
    expect(bridge.vault.decryptSecret(sealed)).toBe(secret);

    // Provider AAD mismatch must throw
    expect(() =>
      bridge.vault.decryptSecret({ ...sealed, provider: 'fyers' }),
    ).toThrow();

    // Ciphertext tamper must throw
    const tampered = Buffer.from(sealed.ciphertextB64, 'base64');
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() =>
      bridge.vault.decryptSecret({ ...sealed, ciphertextB64: tampered.toString('base64') }),
    ).toThrow();
  });

  it.skipIf(process.platform !== 'win32')(
    'seals and unseals master key natively via Windows DPAPI over stdin without C++ addons',
    () => {
      const dpapiKeyFile = path.join(tmpDir, 'dpapi.master.bin');
      const v1 = new CredentialVault(dpapiKeyFile, new WindowsDpapiSealer());
      v1.unlockOrInitialize();
      const record = v1.encryptSecret('tiingo', '{"token":"abc123"}');
      v1.lock();

      // Re-open with a fresh CredentialVault instance reading the DPAPI-sealed file from disk
      const v2 = new CredentialVault(dpapiKeyFile, new WindowsDpapiSealer());
      v2.unlockOrInitialize();
      expect(v2.decryptSecret(record)).toBe('{"token":"abc123"}');
      v2.lock();
    },
  );

  it('blocks private, loopback, metadata, CGNAT, and IPv4-mapped IPv6 SSRF targets', async () => {
    for (const blocked of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.5.9',
      '192.168.1.50',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      'fe80::1',
      'fc00::1',
    ]) {
      expect(isBlockedIp(blocked), `expected ${blocked} blocked`).toBe(true);
    }

    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);

    // Multi-A-record DNS rebinding check: one public + one private IP -> must reject!
    await expect(
      resolveAndValidateWebhookUrl('https://rebind.example/hook', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    ).rejects.toThrow(/SSRF blocked/);

    // Clean public DNS record passes
    const ok = await resolveAndValidateWebhookUrl('https://hooks.example/alert', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(ok.resolvedIp).toBe('93.184.216.34');
  });
});
