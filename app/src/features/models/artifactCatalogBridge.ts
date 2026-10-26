import { invoke } from "@tauri-apps/api/core";
import type { ArtifactCatalog } from "./artifactCatalog";

/** Native metadata scan. Browser previews have no filesystem access. */
export async function loadArtifactCatalog(): Promise<ArtifactCatalog> {
  return invoke<ArtifactCatalog>("model_catalog");
}
