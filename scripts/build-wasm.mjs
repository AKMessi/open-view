import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_BINDGEN_BIN, WASM_BINDGEN_VERSION } from './bootstrap-wasm.mjs';
import { resolveRustToolchain } from './rust-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'crates', 'openview-wasm', 'Cargo.toml');
const TARGET_DIR = path.join(ROOT, 'target');
const WASM_OUTPUT = path.join(TARGET_DIR, 'wasm32-unknown-unknown', 'release', 'openview_wasm.wasm');
const WEB_OUT_DIR = path.join(ROOT, 'packages', 'script-runtime', 'src', 'wasm-pkg');
const NODE_OUT_DIR = path.join(ROOT, 'apps', 'server', 'src', 'wasm-pkg');

function main() {
  if (!fs.existsSync(WASM_BINDGEN_BIN)) {
    console.log('[build-wasm] wasm-bindgen not found locally, running bootstrap...');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bootstrap-wasm.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  const ver = execFileSync(WASM_BINDGEN_BIN, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (!ver.includes(WASM_BINDGEN_VERSION)) {
    throw new Error(`wasm-bindgen version mismatch: expected ${WASM_BINDGEN_VERSION}, got "${ver}". Run npm run bootstrap:wasm.`);
  }

  const { toolchain, cargoPrefix } = resolveRustToolchain(ROOT);
  if (toolchain) {
    console.log(`[build-wasm] Using Rust toolchain ${toolchain} (self-contained linker).`);
  }
  console.log('[build-wasm] Compiling openview-wasm (wasm32-unknown-unknown --release)...');
  execFileSync(
    'cargo',
    [
      ...cargoPrefix,
      'build',
      '--manifest-path',
      MANIFEST,
      '--target',
      'wasm32-unknown-unknown',
      '--release',
      '--target-dir',
      TARGET_DIR,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );

  if (!fs.existsSync(WASM_OUTPUT)) {
    throw new Error(`WASM binary missing at ${WASM_OUTPUT}`);
  }

  fs.mkdirSync(WEB_OUT_DIR, { recursive: true });
  fs.mkdirSync(NODE_OUT_DIR, { recursive: true });

  console.log('[build-wasm] Generating web ESM bindings -> packages/script-runtime/src/wasm-pkg');
  execFileSync(
    WASM_BINDGEN_BIN,
    ['--target', 'web', '--out-dir', WEB_OUT_DIR, WASM_OUTPUT],
    { cwd: ROOT, stdio: 'inherit' },
  );

  console.log('[build-wasm] Generating Node bindings -> apps/server/src/wasm-pkg');
  execFileSync(
    WASM_BINDGEN_BIN,
    ['--target', 'nodejs', '--out-dir', NODE_OUT_DIR, WASM_OUTPUT],
    { cwd: ROOT, stdio: 'inherit' },
  );
  // Ensure Node treats wasm-bindgen's CJS output cleanly inside an "type": "module" workspace
  fs.writeFileSync(path.join(NODE_OUT_DIR, 'package.json'), '{"type":"commonjs"}\n', 'utf8');

  const wasmSizeKb = (fs.statSync(path.join(WEB_OUT_DIR, 'openview_wasm_bg.wasm')).size / 1024).toFixed(1);
  console.log(`[build-wasm] Done! openview_wasm_bg.wasm = ${wasmSizeKb} KB`);
}

main();
