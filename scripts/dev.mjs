import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];

function launch(name, args) {
  const child = spawn(NPM, args, {
    cwd: ROOT,
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
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] Starting OpenView Bridge (127.0.0.1:4001) + Web Workbench (127.0.0.1:5173)...');
launch('server', ['--workspace', '@openview/server', 'run', 'dev']);
launch('web', ['--workspace', '@openview/web', 'run', 'dev']);
