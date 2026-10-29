import type { EngineModel } from "./engineModels";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const UUID_TAIL = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const flat = (repo: string) => repo.replace("/", "-").toLowerCase();

/**
 * The Hugging Face repository a model came from, to fetch a missing projector from the
 * same place: the GGUF's own source tag, else the `<owner>-<repo>-<id>` folder the
 * downloader made, matched against known sources. Empty when it cannot be told.
 */
export function modelSourceRepo(model: EngineModel, known: readonly string[]): string {
  const metadata = model.sources.llama_cpp?.metadata ?? {};
  for (const key of ["general.source.huggingface.repository", "general.source.repository", "general.repo_url", "general.source.url"]) {
    const value = String(metadata[key] ?? "").trim().replace(/^https?:\/\/huggingface\.co\//i, "").replace(/\/+$/, "");
    if (REPO.test(value)) return value;
  }
  const folders = (model.sources.strata?.modelPath || model.path).replace(/^\\\\\?\\/, "").split(/[\\/]/).slice(0, -1);
  for (const folder of folders.reverse()) {
    const name = folder.replace(UUID_TAIL, "").toLowerCase();
    const match = known.find(repo => REPO.test(repo) && flat(repo) === name);
    if (match) return match;
  }
  return "";
}

/** The folder holding the model file: a projector fetched later goes inside it. */
export const modelFolder = (model: EngineModel) => (model.sources.strata?.modelPath || model.path).replace(/[\\/][^\\/]*$/, "");
