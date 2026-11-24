import { execFileSync } from 'node:child_process';

/**
 * Resolves the best installed Rust toolchain on this host.
 * On Windows without Visual Studio's link.exe on PATH, proc-macros/build scripts fail under
 * the msvc host toolchain even when targeting wasm32-unknown-unknown. If a *-pc-windows-gnu
 * toolchain is installed (which ships a self-contained linker), prefer it automatically.
 */
export function resolveRustToolchain(cwd) {
  if (process.platform !== 'win32') {
    return { toolchain: null, cargoPrefix: [], rustupArgs: [] };
  }

  let hasMsvcLink = false;
  try {
    execFileSync('where', ['link.exe'], { stdio: 'ignore' });
    hasMsvcLink = true;
  } catch {
    hasMsvcLink = false;
  }

  if (hasMsvcLink) {
    return { toolchain: null, cargoPrefix: [], rustupArgs: [] };
  }

  try {
    const toolchains = execFileSync('rustup', ['toolchain', 'list'], {
      cwd,
      encoding: 'utf8',
    });
    const gnu = toolchains
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .find((t) => t && t.includes('pc-windows-gnu'));

    if (gnu) {
      return {
        toolchain: gnu,
        cargoPrefix: [`+${gnu}`],
        rustupArgs: ['--toolchain', gnu],
      };
    }
  } catch {
    // Fall back to default active toolchain
  }

  return { toolchain: null, cargoPrefix: [], rustupArgs: [] };
}
