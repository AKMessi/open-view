import { createBridgeServer } from './app.ts';

const host = process.env.OPENVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.OPENVIEW_PORT ?? '4001');
const webPort = Number(process.env.OPENVIEW_WEB_PORT ?? '5173');

const bridge = await createBridgeServer({ host, port, webPort });

console.log(
  `[openview-bridge] Listening on ${bridge.url} (WS: ${bridge.wsUrl}, vault: ${bridge.vault.mode})`,
);

const shutdown = async () => {
  console.log('[openview-bridge] Shutting down cleanly...');
  await bridge.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
