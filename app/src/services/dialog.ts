import { open, save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./tauri";

export async function pickExecutable(label = "llama-server"): Promise<string | null> {
  if (!isTauri()) return null;
  const value = await open({ multiple: false, directory: false, filters: [{ name: label, extensions: ["exe"] }] });
  return typeof value === "string" ? value : null;
}

export async function pickGguf(): Promise<string | null> {
  if (!isTauri()) return null;
  const value = await open({ multiple: false, directory: false, filters: [{ name: "GGUF models", extensions: ["gguf"] }] });
  return typeof value === "string" ? value : null;
}

export async function pickAnyFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const value = await open({ multiple: false, directory: false });
  return typeof value === "string" ? value : null;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const value = await open({ multiple: false, directory: true });
  return typeof value === "string" ? value : null;
}

export async function pickProfileJson(): Promise<string | null> {
  if (!isTauri()) return null;
  const value = await open({ multiple: false, directory: false, filters: [{ name: "Aplot Control LLM profile", extensions: ["json"] }] });
  return typeof value === "string" ? value : null;
}

export async function chooseProfileExportPath(profileName: string): Promise<string | null> {
  if (!isTauri()) return null;
  const safe = profileName.replace(/[<>:"/\|?*]+/g, "-").trim() || "llama-profile";
  const value = await save({ defaultPath: `${safe}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  return typeof value === "string" ? value : null;
}
