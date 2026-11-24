import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { searchCatalog } from '@openview/datafeed-sdk';
import {
  parseWsClientMessage,
  type MarketCategory,
  type Resolution,
  type WsServerMessage,
} from '@openview/protocol';
import { MarketDataRouter, SUPPORTED_PROVIDERS, type ProviderId } from './providers/market-router.ts';
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
  router: MarketDataRouter;
  sessionGuard: SessionGuard;
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

const VALID_PROVIDER_IDS = new Set<string>(SUPPORTED_PROVIDERS.map((p) => p.id));

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
  const router = new MarketDataRouter(db, vault);

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
      version: '0.2.0',
      bridgeMode,
      vaultMode: vault.mode,
      vaultUnlocked: vault.isUnlocked(),
      sqliteOffMainThread: !stats.isMainThread,
      stats,
      serverTs: Date.now(),
    };
  });

  app.post('/api/v1/auth/session', async (request, reply) => {
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

  // Symbol search across all 4 markets
  app.get('/api/v1/symbols/search', async (request) => {
    const q = request.query as { q?: string; market?: string; limit?: string };
    const market = (q.market ?? 'all') as MarketCategory | 'all';
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 40)));
    return { ok: true, symbols: searchCatalog(q.q ?? '', market, limit) };
  });

  // Historical OHLCV endpoint
  app.get('/api/v1/history', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const q = request.query as { symbol?: string; resolution?: string; count?: string; beforeTime?: string };
    if (!q.symbol) {
      return reply.code(400).send({ error: 'missing_symbol' });
    }
    const resolution = (q.resolution ?? '15') as Resolution;
    const count = Math.min(2000, Math.max(10, Number(q.count ?? 300)));
    const beforeTime = q.beforeTime ? Number(q.beforeTime) : undefined;
    const result = await router.getHistory(q.symbol, resolution, count, beforeTime);
    return { ok: true, ...result };
  });

  // Encrypted Provider Vault CRUD (never returns raw secrets back to browser!)
  app.get('/api/v1/vault/providers', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Valid session required' });
    }
    const saved = await db.listVaultProviders();
    const savedMap = new Map(saved.map((r) => [r.provider, r.updated_at]));
    return {
      ok: true,
      vaultMode: vault.mode,
      providers: SUPPORTED_PROVIDERS.map((p) => ({
        ...p,
        configured: savedMap.has(p.id),
        updatedAt: savedMap.get(p.id) ?? null,
      })),
    };
  });

  app.put('/api/v1/vault/providers/:provider', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { provider } = request.params as { provider: string };
    if (!VALID_PROVIDER_IDS.has(provider)) {
      return reply.code(400).send({ error: 'unknown_provider' });
    }
    const body = request.body as Record<string, string> | null;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'invalid_credentials_payload' });
    }
    const sealed = vault.encryptSecret(provider as ProviderId, JSON.stringify(body));
    await db.putVaultSecret(provider, JSON.stringify(sealed));
    return { ok: true, provider, configured: true, updatedAt: Date.now() };
  });

  app.delete('/api/v1/vault/providers/:provider', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { provider } = request.params as { provider: string };
    await db.deleteVaultSecret(provider);
    return { ok: true, provider, configured: false };
  });

  // Workspace Persistence CRUD (off-main-thread SQLite WAL)
  app.get('/api/v1/workspaces', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return { ok: true, workspaces: await db.listWorkspaces() };
  });

  app.get('/api/v1/workspaces/:id', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    const ws = await db.loadWorkspace(id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, workspace: JSON.parse(ws.snapshot_json) };
  });

  app.put('/api/v1/workspaces/:id', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; revision?: number } | null;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'invalid_workspace' });
    }
    await db.saveWorkspace(
      id,
      body.name ?? 'Default Workspace',
      Number(body.revision ?? 1),
      JSON.stringify(body),
    );
    return { ok: true, id };
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws: WebSocket) => {
    const chartUnsubs = new Map<string, () => void>();
    const chartMeta = new Map<string, { symbol: string; resolution: Resolution }>();
    let quoteUnsub: (() => void) | null = null;

    sendWs(ws, {
      type: 'hello',
      serverVersion: '0.2.0',
      bridgeMode,
      serverTs: Date.now(),
    });

    ws.on('close', () => {
      for (const unsub of chartUnsubs.values()) unsub();
      chartUnsubs.clear();
      quoteUnsub?.();
      quoteUnsub = null;
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

      if (msg.type === 'chart.subscribe') {
        chartUnsubs.get(msg.sessionId)?.();
        chartUnsubs.delete(msg.sessionId);
        chartMeta.set(msg.sessionId, { symbol: msg.symbol, resolution: msg.resolution });

        void router
          .getHistory(msg.symbol, msg.resolution, 500)
          .then((res) => {
            if (ws.readyState !== ws.OPEN) return;
            sendWs(ws, {
              type: 'chart.snapshot',
              sessionId: msg.sessionId,
              symbolInfo: res.symbolInfo,
              resolution: msg.resolution,
              bars: res.bars,
              noMoreHistory: res.noMoreHistory,
            });
            const unsub = router.subscribeLiveBars(msg.symbol, msg.resolution, (bar, quality) => {
              sendWs(ws, {
                type: 'chart.bar_update',
                sessionId: msg.sessionId,
                bar,
                feedQuality: quality,
              });
            });
            chartUnsubs.set(msg.sessionId, unsub);
          })
          .catch((err: unknown) => {
            sendWs(ws, {
              type: 'error',
              code: 'history_failed',
              sessionId: msg.sessionId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }

      if (msg.type === 'chart.unsubscribe') {
        chartUnsubs.get(msg.sessionId)?.();
        chartUnsubs.delete(msg.sessionId);
        chartMeta.delete(msg.sessionId);
        return;
      }

      if (msg.type === 'chart.history') {
        const meta = chartMeta.get(msg.sessionId);
        if (!meta) return;
        void router
          .getHistory(meta.symbol, meta.resolution, msg.count, msg.beforeTime)
          .then((res) => {
            sendWs(ws, {
              type: 'chart.history_result',
              requestId: msg.requestId,
              sessionId: msg.sessionId,
              bars: res.bars,
              noMoreHistory: res.noMoreHistory,
            });
          })
          .catch(() => {
            sendWs(ws, {
              type: 'chart.history_result',
              requestId: msg.requestId,
              sessionId: msg.sessionId,
              bars: [],
              noMoreHistory: true,
            });
          });
        return;
      }

      if (msg.type === 'quote.subscribe') {
        quoteUnsub?.();
        quoteUnsub = router.subscribeLiveQuotes(msg.symbols, (quote) => {
          sendWs(ws, { type: 'quote.update', quote });
        });
        return;
      }

      if (msg.type === 'quote.unsubscribe') {
        quoteUnsub?.();
        quoteUnsub = null;
      }
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
    router,
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
