import { useState } from "react";
import { useTranslation } from "react-i18next";
import { modelConfigurationEngine, modelStoragePath, supportsEngine } from "../lib/engineModels";
import { revealItem } from "../services/desktop";
import { useControlStore } from "../store/control";
import type { ServerEngine } from "../types/app";
import { Button, EmptyState } from "../components/ui/Primitives";
import { ModelCard } from "../components/models/ModelCard";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { modelCardDetails } from "../lib/modelCard";
import type { ModelCapability, ModelUse } from "../lib/modelCatalog";
import { startOllama } from "../services/ollama";

export type LibraryEngineFilter = "all" | ServerEngine;
export function ModelsView({ embedded = false, engineFilter = "all", search = "", favoritesOnly = false, capabilities = [], application = "all" }: { embedded?: boolean; engineFilter?: LibraryEngineFilter; search?: string; favoritesOnly?: boolean; capabilities?: ModelCapability[]; application?: ModelUse | "all" }) {
  const { t } = useTranslation();
  const { libraryModels, libraryErrors, ollamaConnectionError, settings, busy, optimizerRunning, selectLibraryModel, setView, notify, rescanModels, updateSettings } = useControlStore();
  const [savingFavorite, setSavingFavorite] = useState(false);
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
  const connectOllama = async () => {
    useControlStore.setState({ busy: true });
    try { await startOllama(settings.ollamaEndpoint, settings.ollamaBinaryPath); await rescanModels(); }
    catch (error) { notify("error", String(error)); }
    finally { useControlStore.setState({ busy: false }); }
  };
  const visible = libraryModels.filter(model => { const details = modelCardDetails(model); return (!favoritesOnly || favorites.has(model.id)) && capabilities.every(capability => details[capability]) && (application === "all" || details.catalog?.uses.includes(application)); }).filter(model => (engineFilter === "all" || supportsEngine(model, engineFilter)) && `${model.name} ${model.path} ${model.architecture ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
  const choose = async (id: string, engine: ServerEngine | undefined) => {
    if (!engine) return;
    try { if (await selectLibraryModel(id, engine)) setView("configuration"); }
    catch (error) { notify("error", String(error)); }
  };
  const content = <div className="libraryPane">
    {engineFilter === "ollama" && ollamaConnectionError && <div role="status"><p>{t("models.ollamaStopped")}</p><Button disabled={busy} onClick={() => void connectOllama()}>{t("models.ollamaConnect")}</Button></div>}
    {visible.map(model => <ModelCard key={model.id} model={model} favorite={favorites.has(model.id)}
      favoriteDisabled={savingFavorite || busy || optimizerRunning}
      configureDisabled={busy || !modelConfigurationEngine(model, settings.serverEngine, engineFilter)}
      onFavorite={() => void toggleFavorite(model.id)}
      onConfigure={() => void choose(model.id, modelConfigurationEngine(model, settings.serverEngine, engineFilter))}
      onReveal={() => void revealItem(modelStoragePath(model) || "").catch(error => notify("error", String(error)))}/>)}
    {!visible.length && <EmptyState title={t((search.trim() || favoritesOnly || capabilities.length || application !== "all" || engineFilter !== "all") ? "library.noMatches" : "models.emptyTitle")} text={t((search.trim() || favoritesOnly || capabilities.length || application !== "all" || engineFilter !== "all") ? "library.trySearch" : "models.emptyText")}/>}
    {libraryErrors.map(error => <FriendlyInlineError key={error} error={error}/>)}
  </div>;
  return embedded ? content : <div className="page">{content}</div>;
}
