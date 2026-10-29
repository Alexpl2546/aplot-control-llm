import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { modelConfigurationEngine, modelStoragePath, needsStrataPreparation, supportsEngine, type EngineModel } from "../lib/engineModels";
import { isTauri } from "../services/tauri";
import { revealItem } from "../services/desktop";
import { useControlStore } from "../store/control";
import type { ServerEngine } from "../types/app";
import { Button, EmptyState } from "../components/ui/Primitives";
import { ModelCard } from "../components/models/ModelCard";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { modelCompanions } from "../lib/modelCompanions";
import { modelArtifactCatalog, modelRemovalPlan, removeModel, type ArtifactCatalog, type ModelRemovalPlan } from "../services/modelFiles";
import { formatModelSize } from "../lib/models";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { modelCardDetails } from "../lib/modelCard";
import type { ModelCapability, ModelUse } from "../lib/modelCatalog";
import { modelFolder, modelSourceRepo } from "../lib/modelSource";
import { MODEL_RECIPES } from "../features/modelDownloads/recipes";
import { DownloadModelDialog } from "../features/modelDownloads/DownloadModelDialog";

export type LibraryEngineFilter = "all" | ServerEngine;
export function ModelsView({ embedded = false, engineFilter = "all", search = "", favoritesOnly = false, capabilities = [], application = "all", onPrepareStrata }: { embedded?: boolean; engineFilter?: LibraryEngineFilter; search?: string; favoritesOnly?: boolean; capabilities?: ModelCapability[]; application?: ModelUse | "all"; onPrepareStrata?: () => void }) {
  const { t } = useTranslation();
  const { libraryModels, availableEngines, libraryErrors, settings, busy, optimizerRunning, selectLibraryModel, setView, notify, updateSettings } = useControlStore();
  const [savingFavorite, setSavingFavorite] = useState(false);
  const profiles = useControlStore(state => state.profiles);
  const [catalog, setCatalog] = useState<ArtifactCatalog>({ artifacts: [] });
  const [removal, setRemoval] = useState<{ model: EngineModel; plan: ModelRemovalPlan }>();
  const [removing, setRemoving] = useState(false);
  const [visionFor, setVisionFor] = useState<EngineModel>();
  // The file catalogue knows which projector and draft files sit with each model.
  useEffect(() => { let live = true; void modelArtifactCatalog().then(next => { if (live) setCatalog(next); }, () => undefined); return () => { live = false; }; }, [libraryModels]);
  const askRemove = async (model: EngineModel) => {
    try {
      const plan = await modelRemovalPlan(model.path);
      if (plan.active.length) { notify("error", t("models.remove.inUse", { name: model.name })); return; }
      setRemoval({ model, plan });
    } catch (error) { notify("error", String(error)); }
  };
  const confirmRemove = async () => {
    if (!removal) return;
    setRemoving(true);
    try {
      await removeModel(removal.model.path);
      notify("success", t("models.remove.done", { name: removal.model.name, size: formatModelSize(removal.plan.totalBytes) }));
      setRemoval(undefined);
      await useControlStore.getState().rescanModels();
    } finally { setRemoving(false); }
  };
  const removalText = removal ? [
    t("models.remove.files", { count: removal.plan.files.length, size: formatModelSize(removal.plan.totalBytes) }),
    removal.plan.files.slice(0, 4).map(file => `• ${file.path.split(/[\\/]/).pop()}`).join("\n") + (removal.plan.files.length > 4 ? `\n• …${t("models.remove.more", { count: removal.plan.files.length - 4 })}` : ""),
    removal.plan.profiles.length ? t("models.remove.profiles", { names: removal.plan.profiles.map(id => profiles.find(profile => profile.id === id)?.name ?? id).join(", ") }) : t("models.remove.noProfiles"),
  ].join("\n\n") : "";
  const favorites = new Set(settings.favoriteModelIds ?? []);
  const toggleFavorite = async (id: string) => {
    if (savingFavorite) return;
    setSavingFavorite(true);
    try {
      const ids = useControlStore.getState().settings.favoriteModelIds ?? [];
      await updateSettings({ favoriteModelIds: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] });
    } catch (error) { notify("error", String(error)); }
    finally { setSavingFavorite(false); }
  };
  const visible = libraryModels.filter(model => { const details = modelCardDetails(model); return (!favoritesOnly || favorites.has(model.id)) && capabilities.every(capability => details[capability]) && (application === "all" || details.catalog?.uses.includes(application)); }).filter(model => (engineFilter === "all" || supportsEngine(model, engineFilter) || (engineFilter === "strata" && needsStrataPreparation(model))) && `${model.name} ${model.path} ${model.architecture ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
  const choose = async (id: string, engine: ServerEngine | undefined) => {
    if (!engine) return;
    try { if (await selectLibraryModel(id, engine)) setView("configuration"); }
    catch (error) { notify("error", String(error)); }
  };
  const content = <div className="libraryPane">
    {visible.map(model => <ModelCard key={model.id} model={model} favorite={favorites.has(model.id)}
      favoriteDisabled={savingFavorite || busy || optimizerRunning}
      configureDisabled={busy || !modelConfigurationEngine(model, settings.serverEngine, engineFilter, availableEngines)}
      onFavorite={() => void toggleFavorite(model.id)}
      onConfigure={() => void choose(model.id, modelConfigurationEngine(model, settings.serverEngine, engineFilter, availableEngines))}
      onPrepareStrata={onPrepareStrata}
      companions={modelCompanions(catalog, model.path)}
      onRemove={isTauri() ? () => void askRemove(model) : undefined} removeDisabled={busy || optimizerRunning || removing}
      onDownloadVision={() => setVisionFor(model)}
      onReveal={() => void revealItem(modelStoragePath(model) || "").catch(error => notify("error", String(error)))}/>)}
    {!visible.length && <EmptyState title={t((search.trim() || favoritesOnly || capabilities.length || application !== "all" || engineFilter !== "all") ? "library.noMatches" : "models.emptyTitle")} text={t((search.trim() || favoritesOnly || capabilities.length || application !== "all" || engineFilter !== "all") ? "library.trySearch" : "models.emptyText")}/>}
    {libraryErrors.map(error => <FriendlyInlineError key={error} error={error}/>)}
    <ConfirmDialog open={Boolean(removal)} title={t("models.remove.title", { name: removal?.model.name ?? "" })} text={removalText} confirmLabel={t("models.remove.confirm")} dangerous busy={removing}
      onCancel={() => { if (!removing) setRemoval(undefined); }} onConfirm={confirmRemove}/>
    <DownloadModelDialog open={Boolean(visionFor)} visionOnly onClose={() => setVisionFor(undefined)} onQueued={() => notify("success", t("models.files.queued"))}
      initialSource={visionFor ? modelSourceRepo(visionFor, MODEL_RECIPES.map(recipe => recipe.source ?? "")) : ""} initialDestination={visionFor ? modelFolder(visionFor) : ""}/>
  </div>;
  return embedded ? content : <div className="page">{content}</div>;
}
