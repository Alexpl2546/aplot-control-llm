export type ModelImportRequest = { path: string; resolve: (path?: string) => void };
export function chooseModelLocation(path: string): Promise<string | undefined> {
  return new Promise(resolve => window.dispatchEvent(new CustomEvent<ModelImportRequest>("aplot-model-import", { detail: { path, resolve } })));
}
