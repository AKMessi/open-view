import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseWsClientMessage, type WsServerMessage } from '@openview/protocol';
import {
  CSRF_HEADER_NAME,
  createDefaultSecurityPolicy,
  SessionGuard,
  validateHostHeader,
  validateOriginHeader,
  type SecurityPolicy,
} from './security/guard.ts';
import {
  CredentialVault,
  PassphraseRamSealer,
  WindowsDpapiSealer,
  type IMasterKeySealer,
} from './security/vault.ts';
import { DbWorkerClient } from './workers/db-client.ts';

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  webPort?: number;
  dbPath?: string;
  vaultKeyPath?: string;
  sealer?: IMasterKeySealer;
  securityPolicy?: SecurityPolicy;
  bridgeMode?: 'local' | 'self_hosted';
}

export interface RunningBridgeServer {
  app: FastifyInstance;
  wss: WebSocketServer;
  db: DbWorkerClient;
  vault: CredentialVault;
  sessionGuard: SessionGuard;
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

function defaultSealer(): IMasterKeySealer {
  if (process.platform === 'win32' && !process.env.OPENVIEW_VAULT_PASSPHRASE) {
    return new WindowsDpapiSealer();
  }
  const pass =
    process.env.OPENVIEW_VAULT_PASSPHRASE ??
    crypto.randomBytes(24).toString('base64url');
  return new PassphraseRamSealer(pass, Buffer.from('openview-salt-v1', 'utf8'));
}

function sendWs(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function rejectUpgrade(socket: Duplex, statusCode: 401 | 403 | 404, message: string): void {
  const statusText =
    statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Not Found';
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
      message,
  );
  socket.destroy();
}

export async function createBridgeServer(
  options: BridgeServerOptions = {},
): Promise<RunningBridgeServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4001;
  const webPort = options.webPort ?? 5173;
  const bridgeMode = options.bridgeMode ?? 'local';

  const dataDir = path.resolve(process.cwd(), '.data');
  const dbPath = options.dbPath ?? path.join(dataDir, 'openview.sqlite');
  const vaultKeyPath = options.vaultKeyPath ?? path.join(dataDir, 'vault.master.bin');

  const policy = options.securityPolicy ?? createDefaultSecurityPolicy(port, webPort);
  const sessionGuard = new SessionGuard();
  const vault = new CredentialVault(vaultKeyPath, options.sealer ?? defaultSealer());
  vault.unlockOrInitialize();

  const db = new DbWorkerClient(dbPath);
  await db.ping();

  const app = Fastify({
    logger: false,
    trustProxy: false,
  });

  // P0 Security Gate: Host allowlist (anti-DNS-rebinding) + strict Origin validation
  app.addHook('onRequest', async (request, reply) => {
    const hostCheck = validateHostHeader(request.headers.host, policy);
    if (!hostCheck.ok) {
      return reply.code(403).send({ error: 'forbidden_host', message: hostCheck.reason });
    }

    const origin = request.headers.origin;
    if (origin !== undefined) {
      const originCheck = validateOriginHeader(origin, policy, true);
      if (!originCheck.ok) {
        return reply.code(403).send({ error: 'forbidden_origin', message: originCheck.reason });
      }
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', `Content-Type, ${CSRF_HEADER_NAME}`);
      reply.header('Vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  app.get('/api/health', async () => {
    const stats = await db.stats();
    return {
      ok: true,
      service: 'openview-bridge',
      version: '0.1.0',
      bridgeMode,
      vaultMode: vault.mode,
      vaultUnlocked: vault.isUnlocked(),
      sqliteOffMainThread: !stats.isMainThread,
      stats,
      serverTs: Date.now(),
    };
  });

  app.post('/api/v1/auth/session', async (request, reply) => {
    // Only allow session bootstrap from allowlisted browser origins or direct local requests
    const originCheck = validateOriginHeader(request.headers.origin, policy, false);
    if (!originCheck.ok) {
      return reply.code(403).send({ error: 'forbidden_origin', message: originCheck.reason });
    }
    reply.header('Set-Cookie', sessionGuard.buildSetCookieHeader());
    return {
      ok: true,
      token: sessionGuard.getToken(),
      bridgeMode,
      vaultMode: vault.mode,
    };
  });

  app.post('/api/v1/auth/ws-ticket', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Valid session required' });
    }
    const { ticket, expiresAt } = sessionGuard.issueWsTicket();
    return { ok: true, ticket, expiresAt };
  });

  app.get('/api/v1/vault/providers', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Valid session required' });
    }
    const providers = await db.listVaultProviders();
    return { ok: true, vaultMode: vault.mode, providers };
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws: WebSocket) => {
    sendWs(ws, {
      type: 'hello',
      serverVersion: '0.1.0',
      bridgeMode,
      serverTs: Date.now(),
    });

    ws.on('message', (rawBuf) => {
      const msg = parseWsClientMessage(rawBuf.toString('utf8'));
      if (!msg) {
        sendWs(ws, { type: 'error', code: 'invalid_frame', message: 'Malformed WS message' });
        return;
      }
      if (msg.type === 'ping') {
        sendWs(ws, {
          type: 'pong',
          id: msg.id,
          clientTs: msg.ts,
          serverTs: Date.now(),
        });
        return;
      }
      sendWs(ws, {
        type: 'error',
        code: 'not_implemented_phase0',
        message: `Operation ${msg.type} will be enabled in Phase 2`,
      });
    });
  });

  // Strict pre-upgrade CSWSH + Host + Ticket validation
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (reqUrl.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Unknown WebSocket endpoint');
      return;
    }

    const hostCheck = validateHostHeader(req.headers.host, policy);
    if (!hostCheck.ok) {
      rejectUpgrade(socket, 403, hostCheck.reason ?? 'Forbidden host');
      return;
    }

    // Origin is MANDATORY on WebSocket upgrades to defeat CSWSH
    const originCheck = validateOriginHeader(req.headers.origin, policy, true);
    if (!originCheck.ok) {
      rejectUpgrade(socket, 403, originCheck.reason ?? 'Forbidden origin');
      return;
    }

    const ticket = reqUrl.searchParams.get('ticket');
    if (!sessionGuard.consumeWsTicket(ticket)) {
      rejectUpgrade(socket, 401, 'Missing, expired, or already used WebSocket ticket');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const address = await app.listen({ host, port });
  const parsedAddr = new URL(address);
  // Ensure ephemeral test ports (port: 0) are registered in policy allowlist
  policy.allowedHosts.add(`${parsedAddr.hostname}:${parsedAddr.port}`);
  policy.allowedHosts.add(`localhost:${parsedAddr.port}`);
  policy.allowedHosts.add(`127.0.0.1:${parsedAddr.port}`);
  policy.allowedOrigins.add(`http://127.0.0.1:${parsedAddr.port}`);
  policy.allowedOrigins.add(`http://localhost:${parsedAddr.port}`);

  return {
    app,
    wss,
    db,
    vault,
    sessionGuard,
    url: address,
    wsUrl: address.replace(/^http/, 'ws') + '/ws',
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      await app.close();
      await db.close();
      vault.lock();
    },
  };
}
