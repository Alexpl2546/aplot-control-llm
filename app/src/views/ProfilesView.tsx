import { Copy, Cpu, Database, Download, Edit3, HardDrive, Layers3, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Badge, Button, EmptyState, SectionTitle } from "../components/ui/Primitives";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { ProfileCard, type ProfileSpec } from "../components/models/ProfileCard";
import { relativeDate } from "../lib/format";
import { chooseProfileExportPath, pickProfileJson } from "../services/dialog";
import { discoverStrataModels } from "../services/tauri";
import { revealItem } from "../services/desktop";
import { useControlStore } from "../store/control";
import type { StrataModelOption } from "../types/app";
import type { LibraryEngineFilter } from "./ModelsView";

const fileName = (path: string) => path.split(/[\\/]/).pop() || "";
const contextLabel = (context: number) => context > 0 ? `${Number((context / 1024).toFixed(1))}K` : "—";

export function ProfilesView({ embedded = false, engineFilter = "all", search = "" }: { embedded?: boolean; engineFilter?: LibraryEngineFilter; search?: string }) {
  const { t, i18n } = useTranslation();
  const { profiles, selectProfile, setView, duplicateProfile, deleteProfile, importProfile, exportProfile, busy, settings, updateSettings, notify } = useControlStore();
  const [deleteId, setDeleteId] = useState<string | undefined>(undefined);
  const [strataProfiles, setStrataProfiles] = useState<StrataModelOption[]>([]);
  const [strataError, setStrataError] = useState("");
  const deleteTarget = profiles.find(profile => profile.id === deleteId);
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleProfiles = profiles.filter(profile => (engineFilter === "all" || (profile.config.engine ?? "llama_cpp") === engineFilter) && matches(`${profile.name} ${profile.description ?? ""} ${profile.config.modelPath} ${profile.config.engineModel ?? ""}`));
  const visibleStrata = strataProfiles.filter(profile => matches(`${profile.modelName} ${profile.configPath}`));
  const showStrata = engineFilter === "all" || engineFilter === "strata";
  const showQwfn = (engineFilter === "all" || engineFilter === "qwfnfer") && Boolean(settings.qwfn.modelPath) && matches(settings.qwfn.modelPath);
  const hasCards = visibleProfiles.length > 0 || (showStrata && visibleStrata.length > 0) || showQwfn;

  useEffect(() => {
    setStrataError("");
    if (!settings.strataRootPath || !showStrata) { setStrataProfiles([]); return; }
    let active = true;
    void discoverStrataModels(settings.strataRootPath).then(models => {
      if (active) { setStrataProfiles(models); setStrataError(""); }
    }).catch(error => { if (active) { setStrataProfiles([]); setStrataError(String(error)); } });
    return () => { active = false; };
  }, [settings.strataRootPath, showStrata]);

  const importFromJson = async () => { const path = await pickProfileJson(); if (path) await importProfile(path); };
  const exportToJson = async (id: string, name: string) => { const path = await chooseProfileExportPath(name); if (path) await exportProfile(id, path); };
  const reveal = (path: string) => void revealItem(path).catch(error => notify("error", String(error)));
  const contextSpec = (context: number): ProfileSpec => ({ label: t("parameters.ctxSize"), value: contextLabel(context), icon: Database, tone: "Blue" });
  const selectStrata = async (profile: StrataModelOption) => {
    await updateSettings({ serverEngine: "strata", strataConfigPath: profile.configPath });
    setView("dashboard");
  };

  const content = <>
    {!embedded && <SectionTitle title={t("nav.library")} description={t("profiles.description")} action={<div className="toolbar">
      {!["strata", "qwfnfer"].includes(engineFilter) && <><Button disabled={busy} onClick={() => void importFromJson()}><Upload size={14}/>{t("actions.import")}</Button><Button className="primary" disabled={busy} onClick={() => void duplicateProfile(t("profiles.newName"))}><Plus size={14}/>{t("profiles.new")}</Button></>}
    </div>}/>}
    {!hasCards && !strataError && <EmptyState title={t(search.trim() ? "library.noMatches" : engineFilter === "strata" ? "profiles.strataEmptyTitle" : "profiles.emptyTitle")} text={t(search.trim() ? "library.trySearch" : engineFilter === "strata" ? "profiles.strataEmptyText" : "profiles.emptyText")}/>}
    <div className="profilesGrid">
      {visibleProfiles.map(profile => {
        const engine = profile.config.engine ?? "llama_cpp";
        const modelName = profile.config.engineModel || fileName(profile.config.modelPath) || t("model.none");
        const description = profile.description && !profile.description.startsWith("Imported from ") && profile.description !== modelName ? profile.description : undefined;
        const specs: ProfileSpec[] = [contextSpec(profile.config.ctxSize)];
        if (engine !== "ollama") specs.push(
          { label: "KV", value: `${profile.config.cacheTypeK} / ${profile.config.cacheTypeV}`, icon: HardDrive, tone: "Violet" },
          { label: t("parameters.parallel"), value: String(profile.config.parallel), icon: Layers3, tone: "Green" },
          { label: "GPU", value: String(profile.config.gpuLayers), icon: Cpu, tone: "Gold" },
        );
        const routerId = settings.serverMode === "router" && engine === "llama_cpp";
        return <ProfileCard key={profile.id} name={profile.name} modelName={modelName} engine={engine} path={profile.config.modelPath || undefined}
          description={description} specs={specs} busy={busy}
          badges={profile.lastKnownGood ? <Badge tone="green">{t("profiles.knownGood")}</Badge> : undefined}
          metadata={routerId || profile.lastUsedAt ? <>{routerId && <div className="profileRouterId"><span>{t("profiles.routerModelId")}</span><code>{profile.name}</code></div>}{profile.lastUsedAt && <p>{t("profiles.lastUsed")}: {relativeDate(profile.lastUsedAt, i18n.language)}</p>}</> : undefined}
          onSelect={() => void (async () => { await selectProfile(profile.id); setView("dashboard"); })()}
          onReveal={profile.config.modelPath ? () => reveal(profile.config.modelPath) : undefined}
          actions={<>
            <Button className="profileEdit" disabled={busy} onClick={async () => { await selectProfile(profile.id); setView("configuration"); }}><Edit3 size={16}/>{t("actions.edit")}</Button>
            <Button title={t("actions.duplicate")} aria-label={t("actions.duplicate")} disabled={busy} onClick={async () => { await selectProfile(profile.id); await duplicateProfile(`${profile.name} ${t("profiles.copySuffix")}`); }}><Copy size={16}/></Button>
            <Button title={t("actions.export")} aria-label={t("actions.export")} disabled={busy} onClick={() => void exportToJson(profile.id, profile.name)}><Download size={16}/></Button>
            <Button title={t("actions.delete")} aria-label={t("actions.delete")} disabled={busy} className="dangerGhost" onClick={() => setDeleteId(profile.id)}><Trash2 size={16}/></Button>
          </>}/>;
      })}
      {showQwfn && <ProfileCard name={fileName(settings.qwfn.modelPath)} modelName={fileName(settings.qwfn.modelPath)} engine="qwfnfer" path={settings.qwfn.modelPath}
        description={t("qwfn.profileHelp")} specs={[contextSpec(settings.qwfn.context), { label: "KV", value: settings.qwfn.kv, icon: HardDrive, tone: "Violet" }, { label: "RAM", value: `${settings.qwfn.ramGb} GB`, icon: Cpu, tone: "Green" }]} busy={busy}
        onSelect={() => void (async () => { await updateSettings({ serverEngine: "qwfnfer" }); setView("dashboard"); })()}
        onReveal={() => reveal(settings.qwfn.modelPath)}
        actions={<Button className="profileEdit" disabled={busy} onClick={async () => { await updateSettings({ serverEngine: "qwfnfer" }); setView("configuration"); }}><Edit3 size={16}/>{t("actions.edit")}</Button>}/>}
      {showStrata && visibleStrata.length > 0 && <>
        {engineFilter === "all" && <div className="librarySectionHeading"><h3>{t("profiles.strataSection")}</h3></div>}
        {visibleStrata.map(profile => <ProfileCard key={profile.configPath} name={profile.modelName} modelName={fileName(profile.modelPath ?? "") || profile.modelName} engine="strata" path={profile.configPath}
          description={t("profiles.strataConfigHelp")} specs={[contextSpec(profile.contextLength)]} busy={busy}
          onSelect={() => void selectStrata(profile)} onReveal={() => reveal(profile.configPath)}/>)}
      </>}
    </div>
    {strataError && <FriendlyInlineError error={strataError}/>}
    <ConfirmDialog open={Boolean(deleteTarget)} title={t("profiles.deleteTitle")} text={t("profiles.deleteText", { name: deleteTarget?.name ?? "" })} confirmLabel={t("actions.delete")} dangerous busy={busy} onCancel={() => setDeleteId(undefined)} onConfirm={async () => { if (deleteTarget) await deleteProfile(deleteTarget.id); setDeleteId(undefined); }}/>
  </>;
  return embedded ? content : <div className="page">{content}</div>;
}
