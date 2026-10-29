import { invoke } from "@tauri-apps/api/core";

export interface StrataConfigFile { flag: string; path: string; exists: boolean; }
export interface StrataConfigDetails { modelName: string; maxContext?: number; kv?: string; mtp: boolean; mtpAvailable: boolean; spec?: number; vision: boolean; visionAvailable: boolean; visionGpu: boolean; ropeScaling?: string; files: StrataConfigFile[]; aplotCopy: boolean; }
export interface StrataConfigEdits { maxContext: number; kv: string; mtp: boolean; spec?: number; vision?: boolean; visionGpu?: boolean; }

export const strataConfigDetails = (rootValue: string, configValue: string) => invoke<StrataConfigDetails>("strata_config_details", { rootValue, configValue });
/** Saves the edits to Aplot's own `strata-aplot-*.json` copy and returns its path; the prepared config is never changed. */
export const saveStrataConfig = (rootValue: string, configValue: string, edits: StrataConfigEdits) => invoke<string>("save_strata_config", { rootValue, configValue, edits });
