import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { ExecutionAirlock, type LiveOrderRequest, type SebiComplianceState } from '@openview/broker-sdk';
import { findSymbolById, searchCatalog } from '@openview/datafeed-sdk';
import {
  parseWsClientMessage,
  type MarketCategory,
  type Resolution,
  type WsServerMessage,
} from '@openview/protocol';
import { AlertEngine, type AlertRule } from './alerts/alert-engine.ts';
import { MarketDataRouter, SUPPORTED_PROVIDERS, type ProviderId } from './providers/market-router.ts';
import { MultiMarketScreener, type ScreenerQuery } from './screener/screener-service.ts';
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
  staticDistDir?: string;
}

export interface RunningBridgeServer {
  app: FastifyInstance;
  wss: WebSocketServer;
  db: DbWorkerClient;
  vault: CredentialVault;
  router: MarketDataRouter;
  alerts: AlertEngine;
  screener: MultiMarketScreener;
  airlock: ExecutionAirlock;
  sessionGuard: SessionGuard;
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

const VALID_PROVIDER_IDS = new Set<string>(SUPPORTED_PROVIDERS.map((p) => p.id));

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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

  const sealer = options.sealer ?? defaultSealer();
  const dataDir = path.resolve(process.cwd(), '.data');
  const dbPath = options.dbPath ?? path.join(dataDir, 'openview.sqlite');
  const vaultKeyPath =
    options.vaultKeyPath ?? path.join(dataDir, `vault.master.${sealer.mode}.bin`);

  const policy = options.securityPolicy ?? createDefaultSecurityPolicy(port, webPort);
  const sessionGuard = new SessionGuard();
  const vault = new CredentialVault(vaultKeyPath, sealer);
  vault.unlockOrInitialize();

  const db = new DbWorkerClient(dbPath);
  await db.ping();
  const router = new MarketDataRouter(db, vault);
  const alerts = new AlertEngine();
  const screener = new MultiMarketScreener(router);
  const airlock = new ExecutionAirlock();

  // Hydrate persisted 24/7 alerts from SQLite WAL on boot
  const storedAlerts = await db.listAlerts();
  const hydratedRules: AlertRule[] = [];
  for (const row of storedAlerts) {
    try {
      hydratedRules.push(JSON.parse(row.rule_json) as AlertRule);
    } catch {
      // ignore corrupted row
    }
  }
  alerts.loadRules(hydratedRules);

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
      version: '0.3.0',
      bridgeMode,
      vaultMode: vault.mode,
      vaultUnlocked: vault.isUnlocked(),
      executionMode: airlock.getMode(),
      activeAlerts: alerts.listRules().filter((r) => r.enabled).length,
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

  // ── Phase 8: 24/7 Alerts Engine CRUD & Audit Log ─────────────────────────
  app.get('/api/v1/alerts', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return { ok: true, alerts: alerts.listRules() };
  });

  app.post('/api/v1/alerts', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as Partial<AlertRule> | null;
    if (!body || typeof body.symbol !== 'string' || typeof body.operator !== 'string') {
      return reply.code(400).send({ error: 'invalid_alert_rule' });
    }
    const rule: AlertRule = {
      id: body.id ?? `alrt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: body.name ?? `${body.symbol} Alert`,
      symbol: body.symbol,
      resolution: body.resolution ?? '15',
      kind: body.kind ?? 'price',
      operator: body.operator,
      frequency: body.frequency ?? 'only_once',
      enabled: body.enabled ?? true,
      ...(body.targetPrice !== undefined ? { targetPrice: Number(body.targetPrice) } : {}),
      ...(body.lineAnchors ? { lineAnchors: body.lineAnchors } : {}),
      ...(body.indicatorExpr ? { indicatorExpr: body.indicatorExpr } : {}),
      ...(body.indicatorThreshold !== undefined ? { indicatorThreshold: Number(body.indicatorThreshold) } : {}),
      ...(body.webhookUrl ? { webhookUrl: body.webhookUrl } : {}),
      ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
      ...(body.webhookFormat ? { webhookFormat: body.webhookFormat } : {}),
      ...(body.telegramChatId ? { telegramChatId: body.telegramChatId } : {}),
      message: body.message ?? `${body.symbol} condition triggered`,
      createdAt: body.createdAt ?? Date.now(),
      triggerCount: 0,
    };
    alerts.upsertRule(rule);
    await db.upsertAlert(rule.id, rule.symbol, JSON.stringify(rule), rule.enabled, rule.createdAt);
    return { ok: true, alert: rule };
  });

  app.delete('/api/v1/alerts/:id', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    alerts.deleteRule(id);
    await db.deleteAlert(id);
    return { ok: true, id };
  });

  app.get('/api/v1/alerts/events', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const rows = await db.listAlertEvents(50);
    const persisted = rows.map((r) => JSON.parse(r.event_json));
    return { ok: true, events: persisted.length > 0 ? persisted : alerts.listEvents(50) };
  });

  // ── Phase 8: Tiered Multi-Market WASM Screener ───────────────────────────
  app.get('/api/v1/screener', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const q = request.query as Record<string, string | undefined>;
    const query: ScreenerQuery = {
      ...(q.market ? { market: q.market as MarketCategory | 'all' } : {}),
      ...(q.minRsi !== undefined && q.minRsi !== '' ? { minRsi: Number(q.minRsi) } : {}),
      ...(q.maxRsi !== undefined && q.maxRsi !== '' ? { maxRsi: Number(q.maxRsi) } : {}),
      ...(q.emaSignal ? { emaSignal: q.emaSignal as 'bullish' | 'bearish' | 'all' } : {}),
      ...(q.supertrend ? { supertrend: q.supertrend as 'bullish' | 'bearish' | 'all' } : {}),
      ...(q.sortBy ? { sortBy: q.sortBy as NonNullable<ScreenerQuery['sortBy']> } : {}),
      ...(q.sortDir ? { sortDir: q.sortDir as 'asc' | 'desc' } : {}),
      ...(q.search ? { search: q.search } : {}),
    };
    const res = await screener.scan(query, q.refresh === '1' || q.refresh === 'true');
    return { ok: true, ...res };
  });

  // ── Phase 8: Execution Airlock & SEBI April 2026 Compliance Guard ────────
  app.get('/api/v1/execution/status', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return {
      ok: true,
      mode: airlock.getMode(),
      riskLimits: airlock.getRiskLimits(),
      sebiCompliance: airlock.getSebiCompliance(),
    };
  });

  app.post('/api/v1/execution/arm', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as { phrase?: string; riskLimits?: Partial<ReturnType<ExecutionAirlock['getRiskLimits']>> } | null;
    const res = airlock.armLiveMode(body?.phrase ?? '', body?.riskLimits);
    if (!res.armed) return reply.code(400).send({ ok: false, error: res.reason });
    return { ok: true, mode: airlock.getMode(), riskLimits: airlock.getRiskLimits() };
  });

  app.post('/api/v1/execution/disarm', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    airlock.disarmToPaper();
    return { ok: true, mode: airlock.getMode() };
  });

  app.post('/api/v1/execution/sebi-compliance', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as SebiComplianceState | null;
    if (!body) return reply.code(400).send({ error: 'invalid_sebi_payload' });
    airlock.updateSebiCompliance(body);
    return { ok: true, sebiCompliance: airlock.getSebiCompliance() };
  });

  app.post('/api/v1/execution/validate-order', async (request, reply) => {
    if (!sessionGuard.verifyHttpAuth(request.headers)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = request.body as {
      brokerId: LiveOrderRequest['brokerId'];
      symbol: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      quantity: number;
      refPrice: number;
      limitPrice?: number;
    } | null;
    const sym = body?.symbol ? findSymbolById(body.symbol) : null;
    if (!body || !sym) return reply.code(400).send({ error: 'unknown_symbol' });
    const result = airlock.validateAndPrepareLiveOrder({
      brokerId: body.brokerId,
      symbolInfo: sym,
      side: body.side,
      type: body.type,
      quantity: body.quantity,
      refPrice: body.refPrice,
      ...(body.limitPrice !== undefined ? { limitPrice: body.limitPrice } : {}),
    });
    return { ok: result.allowed, ...result };
  });

  // Optional static Web UI serving for single-container Docker self-hosted deployments
  const distDir = options.staticDistDir ?? path.resolve(process.cwd(), 'apps/web/dist');
  if (bridgeMode === 'self_hosted' && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.get('/*', async (request, reply) => {
      const reqPath = (request.url.split('?')[0] ?? '/').replace(/^\/+/, '');
      if (reqPath.startsWith('api/')) return reply.code(404).send({ error: 'not_found' });
      const resolved = path.resolve(distDir, reqPath || 'index.html');
      if (!resolved.startsWith(distDir)) return reply.code(403).send({ error: 'forbidden' });
      const targetFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(distDir, 'index.html');
      const ext = path.extname(targetFile).toLowerCase();
      reply.type(MIME_BY_EXT[ext] ?? 'application/octet-stream');
      return fs.readFileSync(targetFile);
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  // Broadcast triggered alerts to all connected clients & persist SQLite audit log
  alerts.onTrigger((ev) => {
    void db.appendAlertEvent(ev.id, ev.alertId, ev.symbol, JSON.stringify(ev), ev.triggeredAt);
    const rule = alerts.listRules().find((r) => r.id === ev.alertId);
    if (rule) {
      void db.upsertAlert(rule.id, rule.symbol, JSON.stringify(rule), rule.enabled, rule.createdAt);
    }
    for (const client of wss.clients) {
      sendWs(client, {
        type: 'alert.triggered',
        alertId: ev.alertId,
        alertName: ev.alertName,
        symbol: ev.symbol,
        price: ev.price,
        thresholdPrice: ev.thresholdPrice,
        message: ev.message,
        triggeredAt: ev.triggeredAt,
      });
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const chartUnsubs = new Map<string, () => void>();
    const chartMeta = new Map<string, { symbol: string; resolution: Resolution }>();
    let quoteUnsub: (() => void) | null = null;

    sendWs(ws, {
      type: 'hello',
      serverVersion: '0.3.0',
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
              void alerts.evaluateBar(msg.symbol, bar);
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
    alerts,
    screener,
    airlock,
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
