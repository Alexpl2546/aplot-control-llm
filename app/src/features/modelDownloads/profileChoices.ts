import { pathKey, supportsEngine, type EngineModel } from "../../lib/engineModels";
import type { DownloadTask } from "./types";
import type { ServerEngine } from "../../types/app";

const ENGINES: readonly ServerEngine[] = ["llama_cpp", "strata"];

function normalizedPath(path: string) {
  return pathKey(path).replace(/\/+$/, "");
}

function isWithin(path: string, root: string) {
  const candidate = normalizedPath(path);
  const directory = normalizedPath(root);
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

export function modelsForDownload(task: DownloadTask, models: readonly EngineModel[]) {
  const roots = [task.installedPath, task.plan.finalPath].filter((path): path is string => Boolean(path?.trim()));
  if (!roots.length) return [];

  return models.filter(model => {
    const paths = [
      model.path,
      model.sources.llama_cpp?.path,
      model.sources.strata?.modelPath,
      model.sources.strata?.configPath,
    ].filter((path): path is string => Boolean(path?.trim()));
    return paths.some(path => roots.some(root => isWithin(path, root)));
  });
}

export function profileEnginesForModel(model: EngineModel, installed: readonly ServerEngine[]) {
  return ENGINES.filter(engine => installed.includes(engine) && supportsEngine(model, engine));
}
