import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

export type ArtifactKindName = "primaryModel" | "mmproj" | "ngram" | "mtp" | "otherModel";
export interface CatalogFile { path: string; role: string; state: "complete" | "incomplete" | "missing"; sizeBytes: number; }
export interface CatalogArtifact { id: string; kind: ArtifactKindName; files: CatalogFile[]; dependencyIds: string[]; }
export interface ArtifactCatalog { artifacts: CatalogArtifact[]; }
export interface ModelRemovalPlan { files: { path: string; role: string; sizeBytes: number }[]; totalBytes: number; active: string[]; profiles: string[]; shared: string[]; }

export async function modelArtifactCatalog(): Promise<ArtifactCatalog> {
  if (!isTauri()) return { artifacts: [] };
  return invoke("model_catalog");
}
export const modelRemovalPlan = (path: string) => invoke<ModelRemovalPlan>("model_removal_plan", { path });
export const removeModel = (path: string) => invoke<ModelRemovalPlan>("remove_model", { path });
