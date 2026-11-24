import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRustToolchain } from './rust-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WASM_BINDGEN_VERSION = '0.2.130';

const TOOLS_BIN = path.join(ROOT, '.tools', 'bin');
const EXE_EXT = process.platform === 'win32' ? '.exe' : '';
export const WASM_BINDGEN_BIN = path.join(TOOLS_BIN, `wasm-bindgen${EXE_EXT}`);

function resolveTargetTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'x86_64-pc-windows-msvc';
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'x86_64-apple-darwin';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'x86_64-unknown-linux-musl';
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'aarch64-unknown-linux-musl';
  }
  throw new Error(`Unsupported platform/arch for prebuilt wasm-bindgen: ${process.platform}/${process.arch}`);
}

function ensureWasm32Target() {
  const { toolchain, rustupArgs } = resolveRustToolchain(ROOT);
  if (toolchain) {
    console.log(`[bootstrap-wasm] MSVC link.exe not on PATH; using self-contained GNU toolchain (${toolchain}).`);
  }
  const installed = execFileSync('rustup', ['target', 'list', '--installed', ...rustupArgs], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (!installed.split(/\r?\n/).some((line) => line.trim() === 'wasm32-unknown-unknown')) {
    console.log('[bootstrap-wasm] Adding rustup target wasm32-unknown-unknown...');
    execFileSync('rustup', ['target', 'add', 'wasm32-unknown-unknown', ...rustupArgs], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  } else {
    console.log('[bootstrap-wasm] rustup target wasm32-unknown-unknown already installed.');
  }
}

function checkExistingBindgen() {
  if (!fs.existsSync(WASM_BINDGEN_BIN)) return false;
  try {
    const out = execFileSync(WASM_BINDGEN_BIN, ['--version'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (out.includes(WASM_BINDGEN_VERSION)) {
      console.log(`[bootstrap-wasm] ${out} already present at .tools/bin.`);
      return true;
    }
    console.log(`[bootstrap-wasm] Found mismatched version (${out}), replacing with ${WASM_BINDGEN_VERSION}...`);
  } catch {
    return false;
  }
  return false;
}

async function downloadAndVerifyBindgen() {
  const triple = resolveTargetTriple();
  const baseName = `wasm-bindgen-${WASM_BINDGEN_VERSION}-${triple}`;
  const archiveName = `${baseName}.tar.gz`;
  const baseUrl = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}`;

  fs.mkdirSync(TOOLS_BIN, { recursive: true });
  const tmpDir = path.join(ROOT, '.tools', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, archiveName);

  console.log(`[bootstrap-wasm] Downloading ${archiveName}...`);
  const [archiveRes, shaRes] = await Promise.all([
    fetch(`${baseUrl}/${archiveName}`),
    fetch(`${baseUrl}/${archiveName}.sha256sum`),
  ]);

  if (!archiveRes.ok) {
    throw new Error(`Failed to download ${archiveName}: HTTP ${archiveRes.status}`);
  }
  const archiveBytes = Buffer.from(await archiveRes.arrayBuffer());

  if (shaRes.ok) {
    const expectedLine = (await shaRes.text()).trim();
    const expectedHash = expectedLine.split(/\s+/)[0]?.toLowerCase();
    const actualHash = createHash('sha256').update(archiveBytes).digest('hex').toLowerCase();
    if (expectedHash && actualHash !== expectedHash) {
      throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expectedHash}, got ${actualHash}`);
    }
    console.log(`[bootstrap-wasm] Verified SHA-256 (${actualHash.slice(0, 12)}...).`);
  }

  fs.writeFileSync(archivePath, archiveBytes);

  // Use system tar (built into Windows 10/11, macOS, Linux) with argument array (100% space-safe)
  execFileSync('tar', ['-xzf', archivePath, '-C', tmpDir], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const extractedBin = path.join(tmpDir, baseName, `wasm-bindgen${EXE_EXT}`);
  if (!fs.existsSync(extractedBin)) {
    throw new Error(`Expected extracted binary at ${extractedBin}`);
  }
  fs.copyFileSync(extractedBin, WASM_BINDGEN_BIN);
  if (process.platform !== 'win32') {
    fs.chmodSync(WASM_BINDGEN_BIN, 0o755);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const ver = execFileSync(WASM_BINDGEN_BIN, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  console.log(`[bootstrap-wasm] Ready: ${ver}`);
}

async function main() {
  ensureWasm32Target();
  if (!checkExistingBindgen()) {
    await downloadAndVerifyBindgen();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error('[bootstrap-wasm] ERROR:', err);
    process.exit(1);
  });
}
