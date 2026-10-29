import type { ArtifactCatalog, ArtifactKindName } from "../services/modelFiles";

/** A file a model needs for a feature: the vision projector, a draft model or an n-gram table. */
export interface ModelCompanion { kind: Extract<ArtifactKindName, "mmproj" | "mtp" | "ngram">; path: string; installed: boolean; }

const key = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const folder = (path: string) => key(path).replace(/\\[^\\]*$/, "");
const name = (path: string) => key(path).replace(/^.*\\/, "");
/** `mmproj-Qwen3.8-Flash-Next-BF16.gguf` → `qwen3.8-flash-next`: the model family a projector is made for. */
const projectorFamily = (path: string) => name(path).replace(/\.gguf$/, "").replace(/^mmproj[-_.]?/, "").replace(/[-_.]?mmproj$/, "").replace(/[-_.](bf16|f16|fp16|f32|q8_0)$/, "");

/**
 * Companions of the model file at `path`: linked to it through a profile, or kept in
 * its own folder (a folder with no other model in it). A projector kept higher up (Strata
 * keeps one `mmproj-<family>.gguf` for every quantization) counts when its file names the
 * model's family. Other loose files in a shared folder are not guessed to belong to one model.
 */
export function modelCompanions(catalog: ArtifactCatalog, path: string): ModelCompanion[] {
  const wanted = key(path);
  const primary = catalog.artifacts.find(artifact => (artifact.kind === "primaryModel" || artifact.kind === "otherModel") && artifact.files.some(file => key(file.path) === wanted));
  if (!primary) return [];
  const home = folder(path);
  const ownFolder = !catalog.artifacts.some(artifact => artifact.id !== primary.id && (artifact.kind === "primaryModel" || artifact.kind === "otherModel") && artifact.files.some(file => folder(file.path) === home));
  const result: ModelCompanion[] = [];
  for (const artifact of catalog.artifacts) {
    if (artifact.kind !== "mmproj" && artifact.kind !== "mtp" && artifact.kind !== "ngram") continue;
    const linked = artifact.dependencyIds.includes(primary.id);
    // A projector fetched later for this model lands in `<model folder>\aplot-vision-<id>`.
    const beside = ownFolder && artifact.files.every(file => folder(file.path) === home || /^aplot-vision-[^\\]+$/.test(folder(file.path).slice(home.length + 1)) && folder(file.path).startsWith(`${home}\\`));
    const family = artifact.kind === "mmproj" ? projectorFamily(artifact.files[0]?.path ?? "") : "";
    const named = family.length >= 6 && name(path).includes(family) && artifact.files.every(file => home === folder(file.path) || home.startsWith(`${folder(file.path)}\\`));
    if (!linked && !beside && !named) continue;
    const file = artifact.files[0];
    if (file) result.push({ kind: artifact.kind, path: file.path, installed: artifact.files.every(item => item.state === "complete") });
  }
  return result;
}
