export type DownloadFileRole = "model" | "shard" | "mmproj";
export interface DownloadSearchResult {
  repoId: string;
  publisher: string;
  repositoryUrl: string;
  downloads: number;
  likes: number;
  tags: string[];
  pipelineTag?: string;
  lastModified?: string;
  gated: boolean;
  parameterCount?: number;
  contextLength?: number;
  sizeBytes?: number;
  architecture?: string;
  baseModel?: string;
  license?: string;
  description?: string;
}
export interface DownloadSearchPage { items: DownloadSearchResult[]; nextCursor?: string | null; }
export interface ModelSearchOptions { cursor?: string; sort?: 'downloads' | 'lastModified' | 'likes'; allGguf?: boolean; }
export type DownloadState =
  | "queued"
  | "resolving"
  | "downloading"
  | "verifying"
  | "installing"
  | "completed"
  | "pausing"
  | "paused"
  | "retry_wait"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface DownloadFile {
  path: string;
  sizeBytes: number;
  sha256?: string;
  localSha256?: string;
  role: DownloadFileRole;
  quantization?: string;
}

export interface DownloadVariant {
  id: string;
  label: string;
  files: string[];
  totalBytes: number;
  complete: boolean;
}

export interface ResolvedDownload {
  source: string;
  repoId: string;
  revision: string;
  publisher: string;
  repositoryUrl: string;
  licenseUrl?: string;
  files: DownloadFile[];
  variants: DownloadVariant[];
  suggestedFile?: string;
}

export interface DownloadPlan {
  planId: string;
  source: string;
  repoId: string;
  revision: string;
  files: DownloadFile[];
  destination: string;
  finalPath: string;
  totalBytes: number;
  availableBytes: number;
  warnings: string[];
}

export interface DownloadTaskError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DownloadTask {
  id: string;
  sequence: number;
  state: DownloadState;
  plan: DownloadPlan;
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  currentFile?: string;
  error?: DownloadTaskError;
  createdAt: string;
  updatedAt: string;
  installedPath?: string;
  verification?: string;
}

export interface DownloadSelection {
  source: string;
  revision: string;
  files: string[];
  /** Only the projector, placed in the installed model's folder. */
  visionOnly?: boolean;
}
