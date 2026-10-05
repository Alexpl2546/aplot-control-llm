import { invoke } from "@tauri-apps/api/core";
import type { ModelInfo, BenchmarkRequest, BenchmarkResult } from "../types/app";
import type { RuntimeSnapshot } from "../types/runtime";
import { isTauri } from "./tauri";

export interface OllamaModel {
  name: string;
  capabilities?: string[];
  ggufModel?: ModelInfo;
  sourcePath?: string;
  size: number;
  size_vram?: number;
  context_length?: number;
  remote_host?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}
export interface OllamaStatus { version: string; models: OllamaModel[]; running: OllamaModel[]; managed: boolean }
export interface OllamaAnswer { response?: string; thinking?: string; eval_count?: number; eval_duration?: number; prompt_eval_count?: number; prompt_eval_duration?: number; total_duration?: number }
export function ollamaStatus(endpoint: string): Promise<OllamaStatus> {
  if (!isTauri()) return Promise.reject(new Error("Ollama connection requires the desktop application."));
  return invoke("ollama_status", { endpointValue: endpoint });
}
export function ollamaAction(endpoint: string, model: string, action: "load" | "unload" | "generate", context: number, prompt = ""): Promise<OllamaAnswer> {
  return invoke("ollama_model_action", { endpointValue: endpoint, model, action, context, prompt });
}
export function startOllama(endpoint: string, binaryPath: string): Promise<void> { return invoke("start_ollama", { endpointValue: endpoint, binaryPath }); }
export function stopOllama(): Promise<void> { return invoke("stop_ollama"); }

export function ollamaLibrary(endpoint: string): Promise<OllamaModel[]> { return invoke("ollama_library", { endpointValue: endpoint }); }
export function ollamaCachedLibrary(endpoint: string): Promise<OllamaModel[]> { return invoke("ollama_cached_library", { endpointValue: endpoint }); }
export function ollamaRuntime(endpoint: string, model: string): Promise<RuntimeSnapshot> { return invoke("ollama_runtime", { endpointValue: endpoint, model }); }
export function importOllama(endpoint: string, binaryPath: string, path: string, model: string): Promise<void> { return invoke("ollama_import", { endpointValue: endpoint, binaryPath, path, model }); }
export function pullOllama(endpoint: string, model: string): Promise<void> { return invoke("ollama_pull", { endpointValue: endpoint, model }); }
export function benchmarkOllama(endpoint: string, model: string, context: number, request: BenchmarkRequest, profileName: string): Promise<BenchmarkResult> { return invoke("ollama_benchmark", { endpointValue: endpoint, model, context, request, profileName }); }
