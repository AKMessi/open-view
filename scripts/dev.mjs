import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const SERVER_ENTRY = path.join(ROOT, 'apps', 'server', 'src', 'index.ts');

function resolveViteBin() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  const req = createRequire(import.meta.url);
  return req.resolve('vite/bin/vite.js');
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function pickAvailablePort(preferred, maxOffsets = 25) {
  for (let offset = 0; offset <= maxOffsets; offset++) {
    const candidate = preferred + offset;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`No free port found near ${preferred}`);
}

const children = [];

function launch(name, args, cwd, env) {
  // Spawn Node directly (process.execPath) — avoids Windows .cmd EINVAL (CVE-2024-27980)
  // and handles spaces in workspace paths safely without a shell wrapper.
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
  });
  child.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const preferredBridgePort = Number(process.env.OPENVIEW_PORT ?? '4001');
const preferredWebPort = Number(process.env.OPENVIEW_WEB_PORT ?? '5173');

const bridgePort = await pickAvailablePort(preferredBridgePort);
const webPort = await pickAvailablePort(preferredWebPort);

if (bridgePort !== preferredBridgePort) {
  console.log(`[dev] Port ${preferredBridgePort} is busy; using Bridge port ${bridgePort}.`);
}
if (webPort !== preferredWebPort) {
  console.log(`[dev] Port ${preferredWebPort} is busy; using Web port ${webPort}.`);
}

const sharedEnv = {
  ...process.env,
  OPENVIEW_HOST: '127.0.0.1',
  OPENVIEW_PORT: String(bridgePort),
  OPENVIEW_WEB_PORT: String(webPort),
  VITE_BRIDGE_PORT: String(bridgePort),
};

const viteBin = resolveViteBin();
console.log(
  `[dev] Starting OpenView Bridge (http://127.0.0.1:${bridgePort}) + Web Workbench (http://127.0.0.1:${webPort})...`,
);
launch('server', ['--watch-path', path.join(ROOT, 'apps', 'server', 'src'), SERVER_ENTRY], ROOT, sharedEnv);
launch('web', [viteBin, '--host', '127.0.0.1', '--port', String(webPort)], WEB_DIR, sharedEnv);
