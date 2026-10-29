import { Copy, Cpu, Database, Download, Edit3, HardDrive, Layers3, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Badge, Button, EmptyState, Panel, SectionTitle } from "../components/ui/Primitives";
import { isSupportedProfileEngine } from "../features/launches/profiles";
import { ProfileCard, type ProfileSpec } from "../components/models/ProfileCard";
import { relativeDate } from "../lib/format";
import { routerModelId } from "../lib/router";
import { profileContextSize } from "../lib/serverContext";
import { chooseProfileExportPath, pickProfileJson } from "../services/dialog";
import { revealItem } from "../services/desktop";
import { useControlStore } from "../store/control";
import type { LibraryEngineFilter } from "./ModelsView";

const fileName = (path: string) => path.split(/[\\/]/).pop() || "";
const contextLabel = (context: number) => context > 0 ? `${Number((context / 1024).toFixed(1))}K` : "—";

export function ProfilesView({ embedded = false, engineFilter = "all", search = "" }: { embedded?: boolean; engineFilter?: LibraryEngineFilter; search?: string }) {
  const { t, i18n } = useTranslation();
  const { profiles, strataModels, selectProfile, setView, duplicateProfile, deleteProfile, importProfile, exportProfile, busy: storeBusy, optimizerRunning, settings, notify } = useControlStore();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const busy = storeBusy || optimizerRunning || pending;
  const [deleteId, setDeleteId] = useState<string | undefined>(undefined);
  const deleteTarget = profiles.find(profile => profile.id === deleteId);
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleProfiles = profiles.filter(profile => (engineFilter === "all" || (profile.config.engine ?? "llama_cpp") === engineFilter) && matches(`${profile.name} ${profile.description ?? ""} ${profile.config.modelPath} ${profile.config.engineModel ?? ""}`));
  const hasCards = visibleProfiles.length > 0;

  const runAction = async (action: () => Promise<unknown>) => {
    if (storeBusy || optimizerRunning || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { await action(); } catch (error) { notify("error", String(error)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  const importFromJson = () => runAction(async () => { const path = await pickProfileJson(); if (path) await importProfile(path); });
  const exportToJson = (id: string, name: string) => runAction(async () => { const path = await chooseProfileExportPath(name); if (path) await exportProfile(id, path); });
  const reveal = (path: string) => void revealItem(path).catch(error => notify("error", String(error)));
  const contextSpec = (context: number): ProfileSpec => ({ label: t("parameters.ctxSize"), value: contextLabel(context), icon: Database, tone: "Blue" });
  const content = <>
    {!embedded && <SectionTitle title={t("nav.library")} description={t("profiles.description")} action={<div className="toolbar">
      <Button disabled={busy} onClick={() => void importFromJson()}><Upload size={14}/>{t("actions.import")}</Button><Button className="primary" disabled={busy} onClick={() => void runAction(() => duplicateProfile(t("profiles.newName")))}><Plus size={14}/>{t("profiles.new")}</Button>
    </div>}/>}
    {!hasCards && <EmptyState title={t(search.trim() ? "library.noMatches" : "profiles.emptyTitle")} text={t(search.trim() ? "library.trySearch" : "profiles.emptyText")}/>}
    <div className="profilesGrid">
      {visibleProfiles.map(profile => {
        const engine = profile.config.engine ?? "llama_cpp";
        if (!isSupportedProfileEngine(engine)) return <Panel key={profile.id} className="profileCard">
          <h3>{profile.name}</h3><Badge tone="orange">{engine}</Badge>
          <p>{t("profiles.unsupportedEngine", { engine })}</p>
          <div className="toolbar"><Button disabled>{t("profiles.select")}</Button>
            <Button disabled={busy} onClick={() => void exportToJson(profile.id, profile.name)}><Download size={16}/>{t("actions.export")}</Button>
            <Button disabled={busy} className="dangerGhost" onClick={() => setDeleteId(profile.id)}><Trash2 size={16}/>{t("actions.delete")}</Button>
          </div>
        </Panel>;
        const modelName = profile.config.engineModel || fileName(profile.config.modelPath) || t("model.none");
        const description = profile.description && !profile.description.startsWith("Imported from ") && profile.description !== modelName ? profile.description : undefined;
        const specs: ProfileSpec[] = [contextSpec(profileContextSize(profile.config, strataModels))];
        if (engine === "llama_cpp") specs.push(
          { label: "KV", value: `${profile.config.cacheTypeK} / ${profile.config.cacheTypeV}`, icon: HardDrive, tone: "Violet" },
          { label: t("parameters.parallel"), value: String(profile.config.parallel), icon: Layers3, tone: "Green" },
          { label: "GPU", value: String(profile.config.gpuLayers), icon: Cpu, tone: "Gold" },
        );
        const routerId = settings.serverMode === "router" && engine === "llama_cpp";
        return <ProfileCard key={profile.id} name={profile.name} modelName={modelName} engine={engine} path={profile.config.modelPath || undefined}
          description={description} specs={specs} busy={busy}
          badges={profile.lastKnownGood ? <Badge tone="green">{t("profiles.knownGood")}</Badge> : undefined}
          metadata={routerId || profile.lastUsedAt ? <>{routerId && <div className="profileRouterId"><span>{t("profiles.routerModelId")}</span><code>{routerModelId(profile, profiles)}</code></div>}{profile.lastUsedAt && <p>{t("profiles.lastUsed")}: {relativeDate(profile.lastUsedAt, i18n.language)}</p>}</> : undefined}
          onSelect={() => void runAction(async () => { await selectProfile(profile.id); setView("dashboard"); })}
          onReveal={profile.config.modelPath ? () => reveal(profile.config.modelPath) : undefined}
          actions={<>
            <Button className="profileEdit" disabled={busy} onClick={() => void runAction(async () => { await selectProfile(profile.id); setView("configuration"); })}><Edit3 size={16}/>{t("actions.edit")}</Button>
            <Button title={t("actions.duplicate")} aria-label={t("actions.duplicate")} disabled={busy} onClick={() => void runAction(async () => { await selectProfile(profile.id); await duplicateProfile(`${profile.name} ${t("profiles.copySuffix")}`); })}><Copy size={16}/></Button>
            <Button title={t("actions.export")} aria-label={t("actions.export")} disabled={busy} onClick={() => void exportToJson(profile.id, profile.name)}><Download size={16}/></Button>
            <Button title={t("actions.delete")} aria-label={t("actions.delete")} disabled={busy} className="dangerGhost" onClick={() => setDeleteId(profile.id)}><Trash2 size={16}/></Button>
          </>}/>;
      })}
    </div>
    <ConfirmDialog open={Boolean(deleteTarget)} title={t("profiles.deleteTitle")} text={t("profiles.deleteText", { name: deleteTarget?.name ?? "" })} confirmLabel={t("actions.delete")} dangerous busy={busy} onCancel={() => { if (!busy && !pendingRef.current) setDeleteId(undefined); }} onConfirm={() => runAction(async () => { if (deleteTarget) await deleteProfile(deleteTarget.id); setDeleteId(undefined); })}/>
  </>;
  return embedded ? content : <div className="page">{content}</div>;
}
