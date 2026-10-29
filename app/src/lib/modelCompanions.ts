import type { ArtifactCatalog, ArtifactKindName } from "../services/modelFiles";

/** A file a model needs for a feature: the vision projector, a draft model or an n-gram table. */
export interface ModelCompanion { kind: Extract<ArtifactKindName, "mmproj" | "mtp" | "ngram">; path: string; installed: boolean; }

const key = (path: string) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const folder = (path: string) => key(path).replace(/\\[^\\]*$/, "");

/**
 * Companions of the model file at `path`: linked to it through a profile, or kept in
 * its own folder (a folder with no other model in it). Loose files in a shared folder
 * are not guessed to belong to any one model.
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
    const beside = ownFolder && artifact.files.every(file => folder(file.path) === home);
    if (!linked && !beside) continue;
    const file = artifact.files[0];
    if (file) result.push({ kind: artifact.kind, path: file.path, installed: artifact.files.every(item => item.state === "complete") });
  }
  return result;
}
