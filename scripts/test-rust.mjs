import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRustToolchain } from './rust-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'crates', 'openview-wasm', 'Cargo.toml');
const TARGET_DIR = path.join(ROOT, 'target');

function main() {
  const { toolchain, cargoPrefix } = resolveRustToolchain(ROOT);
  if (toolchain) {
    console.log(`[test-rust] Using Rust toolchain ${toolchain} (self-contained linker).`);
  }
  execFileSync(
    'cargo',
    [...cargoPrefix, 'test', '--manifest-path', MANIFEST, '--target-dir', TARGET_DIR],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
}

main();
