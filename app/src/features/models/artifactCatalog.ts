import type { ProfileLaunchConfig } from "../profiles/profileAdapters";

export type ArtifactKind = "primaryModel" | "mmproj" | "ngram" | "mtp" | "otherModel";
export type ArtifactState = "complete" | "incomplete" | "missing";

export interface ArtifactConsumer {
  id: string;
  kind: string;
  path: string;
  active: boolean;
}

export interface ArtifactFile {
  path: string;
  relativePath: string;
  role: string;
  state: ArtifactState;
  sizeBytes: number;
  fileIdentity: string | null;
  hardlinkAliases: string[];
  consumerIds: string[];
}

export interface ModelArtifact {
  id: string;
  displayName: string;
  kind: ArtifactKind;
  state: ArtifactState;
  files: ArtifactFile[];
  dependencyIds: string[];
  consumerIds: string[];
  logicalBytes: number;
  uniquePhysicalBytes: number;
  identityConfidence: "filesystemObject" | "pathOnly" | string;
}

export interface MissingArtifactReference {
  path: string;
  consumerId: string;
  consumerKind: string;
}

export interface ArtifactCatalog {
  scannedAt: string;
  roots: string[];
  logicalBytes: number;
  uniquePhysicalBytes: number;
  artifacts: ModelArtifact[];
  missingReferences: MissingArtifactReference[];
  issues: string[];
}

export interface RemovalPreviewFile {
  path: string;
  sizeBytes: number;
  candidateIfConfirmed: boolean;
  protectedBy: string[];
}

export interface ArtifactRemovalPreview {
  artifactId: string;
  files: RemovalPreviewFile[];
  protectedFileCount: number;
  candidateFileCount: number;
  previewOnly: true;
  message: string;
}

export interface ArtifactProfileInput {
  id: string;
  config: ProfileLaunchConfig | Record<string, unknown>;
}

/** Flatten legacy path fields into explicit consumer references for the scanner. */
export function artifactConsumersFromProfiles(
  profiles: readonly ArtifactProfileInput[],
  activeProfileIds: ReadonlySet<string> = new Set(),
): ArtifactConsumer[] {
  const consumers: ArtifactConsumer[] = [];
  for (const profile of profiles) {
    const config = profile.config as Record<string, unknown>;
    const engineOptions = objectValue(config.engineOptions);
    const optionMaps = "values" in engineOptions
      ? [objectValue(engineOptions.values)]
      : Object.values(engineOptions).map(objectValue);
    const sources = [config, ...optionMaps];
    const paths = new Map<string, string>();
    for (const key of ["modelPath", "mmprojPath", "ngramPath", "mtpPath"] as const) {
      for (const source of sources) addPath(paths, source[key]);
    }
    for (const key of ["loraPaths"] as const) {
      for (const source of sources) {
        for (const value of arrayValue(source[key])) addPath(paths, value);
      }
    }
    for (const [path, kind] of paths) {
      consumers.push({
        id: profile.id,
        kind,
        path,
        active: activeProfileIds.has(profile.id),
      });
    }
  }
  return consumers;
}

export function removalPreviewSummary(preview: ArtifactRemovalPreview): {
  canRemoveAnyFiles: boolean;
  protectedFileCount: number;
  candidateFileCount: number;
} {
  return {
    canRemoveAnyFiles: false,
    protectedFileCount: preview.protectedFileCount,
    candidateFileCount: preview.candidateFileCount,
  };
}

function addPath(paths: Map<string, string>, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  const normalized = value.trim();
  const lower = normalized.replaceAll("/", "\\").toLowerCase();
  const kind = /ngram/i.test(normalized)
    ? "ngram"
    : /mmproj/i.test(normalized)
      ? "mmproj"
      : /(mtp|dflash|draft|speculative)/i.test(normalized)
        ? "mtp"
        : "model";
  if (![...paths.keys()].some((path) => path.replaceAll("/", "\\").toLowerCase() === lower)) {
    paths.set(normalized, kind);
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
