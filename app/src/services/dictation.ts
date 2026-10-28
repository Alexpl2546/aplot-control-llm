import { invoke } from "@tauri-apps/api/core";

/** Chat dictation runs Hermes' recorder and local Whisper outside any agent session. */
export const startDictation = (language: string) => invoke<{ status: string }>("dictation_start", { language });
export const dictationLevel = () => invoke<{ rms?: number }>("dictation_level");
export const stopDictation = () => invoke<string>("dictation_stop");
export const cancelDictation = () => invoke<void>("dictation_cancel");
