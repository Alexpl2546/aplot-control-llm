import { Check, CircleAlert, Cpu, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { saveStrataConfig, strataConfigDetails, type StrataConfigDetails } from "../../services/strataConfig";
import { isTauri } from "../../services/tauri";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { Button, Input, Panel, Switch } from "../ui/Primitives";

const KV_MODES = ["int8", "q4_0", "k8v4", "fp16"] as const;
const CONTEXT_STEPS = [32768, 65536, 131072, 225280, 262144];

/** Strata's engine settings by hand: context, memory format and the draft layer, plus the files the config needs. */
export function StrataModelCard() {
  const { t } = useTranslation();
  const { settings, runtime, notify, updateSettings, rescanModels } = useControlStore();
  const [details, setDetails] = useState<StrataConfigDetails>();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ maxContext: 0, kv: "int8", mtp: false, spec: 4 });
  const [saving, setSaving] = useState(false);
  const configName = settings.strataConfigPath.split(/[\\/]/).pop() || t("settings.strataNoModels");
  useEffect(() => {
    setDetails(undefined); setError("");
    if (!isTauri() || !settings.strataRootPath || !settings.strataConfigPath) return;
    let live = true;
    strataConfigDetails(settings.strataRootPath, settings.strataConfigPath).then(next => {
      if (!live) return;
      setDetails(next);
      setDraft({ maxContext: next.maxContext ?? 32768, kv: next.kv ?? "int8", mtp: next.mtp, spec: next.spec ?? 4 });
    }, failure => { if (live) setError(String(failure)); });
    return () => { live = false; };
  }, [settings.strataRootPath, settings.strataConfigPath]);
  const changed = !!details && (draft.maxContext !== (details.maxContext ?? 32768) || draft.kv !== (details.kv ?? "int8") || draft.mtp !== details.mtp || (draft.mtp && draft.spec !== (details.spec ?? 4)));
  const save = async () => {
    setSaving(true);
    try {
      const path = await saveStrataConfig(settings.strataRootPath, settings.strataConfigPath, { maxContext: draft.maxContext, kv: draft.kv, mtp: draft.mtp, spec: draft.mtp ? draft.spec : undefined });
      await updateSettings({ strataConfigPath: path });
      await rescanModels();
      notify("success", t("strataEditor.saved", { name: path.split(/[\\/]/).pop() }));
    } catch (failure) { notify("error", t(`strataEditor.error.${String(failure)}`, { defaultValue: String(failure) })); }
    finally { setSaving(false); }
  };
  return <Panel className="strataModelCard strataEditor">
    <header>
      <div className="modelGlyph" aria-hidden="true"><Cpu size={28}/></div>
      <div>
        <h3>{t("config.strataTitle")}</h3>
        <p>{details?.modelName || runtime.modelName || configName}</p>
        <p className="mono subtle">{configName}</p>
      </div>
    </header>
    {error && <p className="strataEditorError" role="alert">{error}</p>}
    {details && <>
      <div className="strataEditorFields">
        <label><span>{t("strataEditor.context")}</span>
          <Input type="number" min={4096} max={1048576} step={1024} value={draft.maxContext} onChange={event => setDraft(d => ({ ...d, maxContext: Number(event.target.value) || 0 }))}/>
          <small className="strataEditorPresets">{CONTEXT_STEPS.map(step => <button type="button" key={step} aria-pressed={draft.maxContext === step} onClick={() => setDraft(d => ({ ...d, maxContext: step }))}>{Math.round(step / 1024)}K</button>)}</small>
        </label>
        <label><span>{t("strataEditor.kv")}</span>
          <ChoiceSelect label={t("strataEditor.kv")} value={draft.kv} onChange={kv => setDraft(d => ({ ...d, kv }))} options={KV_MODES.map(mode => ({ value: mode, label: t(`strataEditor.kvMode.${mode}`) }))}/>
        </label>
        <div className="strataEditorToggle"><span><b>{t("strataEditor.mtp")}</b><small>{t(details.mtpAvailable ? "strataEditor.mtpHint" : "strataEditor.mtpMissing")}</small></span>
          <Switch aria-label={t("strataEditor.mtp")} checked={draft.mtp} disabled={!details.mtpAvailable} onChange={mtp => setDraft(d => ({ ...d, mtp }))}/></div>
        {draft.mtp && <label><span>{t("strataEditor.spec")}</span>
          <Input type="number" min={1} max={8} value={draft.spec} onChange={event => setDraft(d => ({ ...d, spec: Math.max(1, Math.min(8, Number(event.target.value) || 1)) }))}/></label>}
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
    {!details && !error && <p className="subtle">{t("config.strataText")}</p>}
  </Panel>;
}
