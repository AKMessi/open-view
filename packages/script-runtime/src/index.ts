export interface WasmRuntimeStatus {
  loaded: boolean;
  version: string;
}

export async function loadBrowserWasm(): Promise<WasmRuntimeStatus> {
  // Generated into ./wasm-pkg by `npm run build:wasm`
  const mod = await import('./wasm-pkg/openview_wasm.js');
  await mod.default();
  return {
    loaded: true,
    version: mod.openview_wasm_version(),
  };
}
