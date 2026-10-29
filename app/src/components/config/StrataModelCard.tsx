import { Check, CircleAlert, Cpu, Download, Save, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { saveStrataConfig, strataConfigDetails, type StrataConfigDetails } from "../../services/strataConfig";
import { discoverStrataModels, isTauri } from "../../services/tauri";
import type { StrataModelOption } from "../../types/app";
import { sameFilePath } from "../../lib/filePaths";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { Button, Input, Panel, Switch } from "../ui/Primitives";

const KV_MODES = ["int8", "q4_0", "k8v4", "fp16"] as const;
const CONTEXT_STEPS = [32768, 65536, 131072, 262144, 524288, 1048576];
/** Past the trained length Strata stretches RoPE with YaRN (factor = context / 256K). */
export const STRATA_TRAINED_CONTEXT = 262144;
const contextLabel = (tokens: number) => tokens >= 1048576 ? `${tokens / 1048576}M` : `${Math.round(tokens / 1024)}K`;

interface Draft { maxContext: number; kv: string; mtp: boolean; spec: number; vision: boolean; visionGpu: boolean }
const draftOf = (details: StrataConfigDetails): Draft => ({ maxContext: details.maxContext ?? 32768, kv: details.kv ?? "int8", mtp: details.mtp, spec: details.spec ?? 4, vision: details.vision, visionGpu: details.visionGpu });

/** Strata's engine settings by hand: which prepared config, context, memory format, draft layer and pictures. */
export function StrataModelCard() {
  const { t } = useTranslation();
  const { settings, notify, updateSettings, rescanModels, setView } = useControlStore();
  const [configs, setConfigs] = useState<StrataModelOption[]>();
  const [details, setDetails] = useState<StrataConfigDetails>();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft>({ maxContext: 0, kv: "int8", mtp: false, spec: 4, vision: false, visionGpu: false });
  const [saving, setSaving] = useState(false);
  const desktop = isTauri();
  useEffect(() => {
    if (!desktop || !settings.strataRootPath) { setConfigs([]); return; }
    let live = true;
    discoverStrataModels(settings.strataRootPath).then(found => { if (live) setConfigs(found); }, () => { if (live) setConfigs([]); });
    return () => { live = false; };
  }, [desktop, settings.strataRootPath, settings.strataConfigPath]);
  useEffect(() => {
    setDetails(undefined); setError("");
    if (!desktop || !settings.strataRootPath || !settings.strataConfigPath) return;
    let live = true;
    strataConfigDetails(settings.strataRootPath, settings.strataConfigPath).then(next => {
      if (!live) return;
      setDetails(next);
      setDraft(draftOf(next));
    }, failure => { if (live) setError(String(failure)); });
    return () => { live = false; };
  }, [desktop, settings.strataRootPath, settings.strataConfigPath]);
  const saved = details && draftOf(details);
  const changed = !!saved && (draft.maxContext !== saved.maxContext || draft.kv !== saved.kv || draft.mtp !== saved.mtp || (draft.mtp && draft.spec !== saved.spec) || draft.vision !== saved.vision || (draft.vision && draft.visionGpu !== saved.visionGpu));
  const choose = (configPath: string) => void updateSettings({ strataConfigPath: configPath }).catch(failure => notify("error", String(failure)));
  const save = async () => {
    setSaving(true);
    try {
      const path = await saveStrataConfig(settings.strataRootPath, settings.strataConfigPath, { maxContext: draft.maxContext, kv: draft.kv, mtp: draft.mtp, spec: draft.mtp ? draft.spec : undefined, vision: draft.vision, visionGpu: draft.vision ? draft.visionGpu : undefined });
      await updateSettings({ strataConfigPath: path });
      await rescanModels();
      notify("success", t("strataEditor.saved", { name: path.split(/[\\/]/).pop() }));
    } catch (failure) { notify("error", t(`strataEditor.error.${String(failure)}`, { defaultValue: String(failure) })); }
    finally { setSaving(false); }
  };
  const selected = configs?.find(option => sameFilePath(option.configPath, settings.strataConfigPath));
  const options = (configs ?? []).map(option => ({ value: option.configPath, label: option.modelName, description: `${option.configPath.split(/[\\/]/).pop()} · ${option.contextLength ? contextLabel(option.contextLength) : "—"}` }));
  if (settings.strataConfigPath && !selected) options.unshift({ value: settings.strataConfigPath, label: settings.strataConfigPath.split(/[\\/]/).pop() ?? settings.strataConfigPath, description: t("strataEditor.configUnlisted") });
  const yarn = draft.maxContext > STRATA_TRAINED_CONTEXT;
  return <Panel className="strataModelCard strataEditor">
    <header>
      <div className="modelGlyph" aria-hidden="true"><Cpu size={28}/></div>
      <div><h3>{t("config.strataTitle")}</h3><p>{details?.modelName || selected?.modelName || t("strataEditor.pickConfig")}</p></div>
    </header>
    {!desktop && <p className="subtle">{t("strataEditor.desktopOnly")}</p>}
    {desktop && configs && !configs.length && !settings.strataConfigPath && <div className="strataEditorEmpty">
      <p>{t("strataEditor.noConfigs")}</p>
      <Button className="primary" onClick={() => setView("models")}><Download size={14}/>{t("strataEditor.openModels")}</Button>
    </div>}
    {desktop && options.length > 0 && <label className="strataEditorConfig"><span>{t("strataEditor.config")}</span>
      <ChoiceSelect label={t("strataEditor.config")} value={settings.strataConfigPath} placeholder={t("strataEditor.pickConfig")} onChange={choose} options={options}/>
    </label>}
    {error && <p className="strataEditorError" role="alert">{error}</p>}
    {details && <>
      <div className="strataEditorFields">
        <label><span>{t("strataEditor.context")}</span>
          <Input type="number" min={4096} max={1048576} step={1024} value={draft.maxContext} onChange={event => setDraft(d => ({ ...d, maxContext: Number(event.target.value) || 0 }))}/>
          <small className="strataEditorPresets">{CONTEXT_STEPS.map(step => <button type="button" key={step} aria-pressed={draft.maxContext === step} onClick={() => setDraft(d => ({ ...d, maxContext: step }))}>{contextLabel(step)}</button>)}</small>
        </label>
        <label><span>{t("strataEditor.kv")}</span>
          <ChoiceSelect label={t("strataEditor.kv")} value={draft.kv} onChange={kv => setDraft(d => ({ ...d, kv }))} options={KV_MODES.map(mode => ({ value: mode, label: t(`strataEditor.kvMode.${mode}`) }))}/>
        </label>
        {yarn && <p className="strataEditorWarning" role="note"><TriangleAlert size={15}/><span>{t("strataEditor.yarnWarning", { factor: Math.round(draft.maxContext / STRATA_TRAINED_CONTEXT * 100) / 100 })}</span></p>}
        <div className="strataEditorToggle"><span><b>{t("strataEditor.mtp")}</b><small>{t(details.mtpAvailable ? "strataEditor.mtpHint" : "strataEditor.mtpMissing")}</small></span>
          <Switch aria-label={t("strataEditor.mtp")} checked={draft.mtp} disabled={!details.mtpAvailable} onChange={mtp => setDraft(d => ({ ...d, mtp }))}/></div>
        {draft.mtp && <label><span>{t("strataEditor.spec")}</span>
          <Input type="number" min={1} max={8} value={draft.spec} onChange={event => setDraft(d => ({ ...d, spec: Math.max(1, Math.min(8, Number(event.target.value) || 1)) }))}/></label>}
        <div className="strataEditorToggle"><span><b>{t("strataEditor.vision")}</b><small>{t(details.visionAvailable ? "strataEditor.visionHint" : "strataEditor.visionMissing")}</small></span>
          <Switch aria-label={t("strataEditor.vision")} checked={draft.vision} disabled={!details.visionAvailable && !draft.vision} onChange={vision => setDraft(d => ({ ...d, vision }))}/></div>
        {draft.vision && <div className="strataEditorDevice"><span>{t("strataEditor.visionDevice")}</span>
          <div className="engineSegmented" role="radiogroup" aria-label={t("strataEditor.visionDevice")}>
            {([false, true] as const).map(gpu => <button type="button" role="radio" key={String(gpu)} aria-checked={draft.visionGpu === gpu} onClick={() => setDraft(d => ({ ...d, visionGpu: gpu }))}>{t(gpu ? "strataEditor.visionGpu" : "strataEditor.visionCpu")}</button>)}
          </div>
          <small>{t(draft.visionGpu ? "strataEditor.visionGpuHint" : "strataEditor.visionCpuHint")}</small>
        </div>}
      </div>
      <div className="strataEditorFiles"><span className="modelSectionLabel">{t("strataEditor.files")}</span>
        <ul>{details.files.map(file => <li key={file.flag + file.path} className={file.exists ? "isInstalled" : "isMissing"} title={file.path}>
          {file.exists ? <Check size={14}/> : <CircleAlert size={14}/>}<span>{t(`strataEditor.file.${file.flag.replace(/^--/, "")}`, { defaultValue: file.flag })}</span><small>{t(file.exists ? "models.files.installed" : "models.files.missing")}</small>
        </li>)}</ul>
      </div>
      <footer>
        <p className="subtle">{t(details.aplotCopy ? "strataEditor.overwriteHint" : "strataEditor.copyHint")}</p>
        <Button className="primary" disabled={!changed || saving || draft.maxContext < 4096} onClick={() => void save()}><Save size={14}/>{t("strataEditor.save")}</Button>
      </footer>
    </>}
  </Panel>;
}
