import type { BenchmarkProgress, BenchmarkResult } from "./app";

export interface JobInfo {
  jobId: string;
  runId: string;
  generation: number;
  engine: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  benchmarkId?: string | null;
  error?: string | null;
  evidence: Record<string, unknown>;
}

export interface BenchmarkJobProgressEvent {
  jobId: string;
  runId: string;
  generation: number;
  progress: BenchmarkProgress;
}

export interface BenchmarkJobCallbacks {
  onStarted?: (job: JobInfo) => void;
  onState?: (job: JobInfo) => void;
  onProgress?: (event: BenchmarkJobProgressEvent) => void;
}

export type BenchmarkJobResult = BenchmarkResult;

export class BenchmarkJobCancelledError extends Error {
  constructor() {
    super("Benchmark job was cancelled.");
    this.name = "BenchmarkJobCancelledError";
  }
}
