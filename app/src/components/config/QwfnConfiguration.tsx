import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import { useControlStore } from "../../store/control";
import type { QwfnSettings } from "../../types/app";
import { pickExecutable, pickGguf } from "../../services/dialog";
import { Button, Input, Panel, Select, Switch } from "../ui/Primitives";
import { SettingRow as Setting } from "./SettingRow";

export function QwfnConfiguration() {
  const { t } = useTranslation();
  const settings = useControlStore(s => s.settings.qwfn);
  const busy = useControlStore(s => s.busy);
  const updateSettings = useControlStore(s => s.updateSettings);
  const notify = useControlStore(s => s.notify);
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const field = <K extends keyof QwfnSettings>(key: K, value: QwfnSettings[K]) => setDraft(s => ({ ...s, [key]: value }));
  const save = async () => {
    if (![draft.context, draft.threads, draft.reserveMb, draft.port].every(Number.isInteger)
      || draft.context < 1024 || draft.context > 262144 || draft.threads < 1 || draft.threads > 512
      || draft.reserveMb < 0 || draft.reserveMb > 65536 || draft.port < 1 || draft.port > 65535 || !draft.host.trim()
      || [draft.ramGb, draft.vramGb, draft.prefixCacheGb].some(v => !Number.isFinite(v) || v < 0 || v > 4096)) {
      notify("error", t("qwfn.invalid")); return;
    }
    if (draft.mtpPath.trim() && draft.prefixCacheGb > 0) { notify("error", t("qwfn.cacheConflict")); return; }
    try { await updateSettings({ qwfn: { ...draft, binaryPath: draft.binaryPath.trim(), modelPath: draft.modelPath.trim(), mtpPath: draft.mtpPath.trim(), host: draft.host.trim() } }); notify("success", t("qwfn.saved")); }
    catch (error) { notify("error", String(error)); }
  };
  const path = (key: "binaryPath" | "modelPath" | "mtpPath") => <div className="pathControl"><Input aria-label={t(key === "binaryPath" ? "qwfn.binary" : key === "modelPath" ? "qwfn.model" : "qwfn.mtp")} value={draft[key]} onChange={e => field(key, e.target.value)}/><Button onClick={async () => { const p = key === "binaryPath" ? await pickExecutable("qwfn-server") : await pickGguf(); if (p) field(key, p); }}>{t("actions.browse")}</Button></div>;
  return <Panel className="settingsSection">
    <h3>QwFNfer</h3><p className="subtle">{t("qwfn.description")}</p>
    <Setting label={t("qwfn.binary")}>{path("binaryPath")}</Setting>
    <Setting label={t("qwfn.model")} help={t("qwfn.modelHelp")}>{path("modelPath")}</Setting>
    {([
      ["context", "parameters.ctxSize", 1024, 262144, 1024], ["ramGb", "qwfn.ram", 0, 4096, 1],
      ["vramGb", "qwfn.vram", 0, 4096, 0.5], ["reserveMb", "qwfn.reserve", 0, 65536, 128],
      ["threads", "parameters.threads", 1, 512, 1],
    ] as const).map(([key, label, min, max, step]) => <Setting key={key} label={t(label)} help={key === "ramGb" ? t("qwfn.memoryHelp") : undefined}><Input aria-label={t(label)} type="number" min={min} max={max} step={step} value={draft[key]} onChange={e => field(key, Number(e.target.value))}/></Setting>)}
    <Setting label={t("qwfn.kv")}><Select aria-label={t("qwfn.kv")} value={draft.kv} onChange={e => field("kv", e.target.value as QwfnSettings["kv"])}><option value="q8_0">q8_0</option><option value="f16">f16</option></Select></Setting>
    <Setting label={t("qwfn.asyncIo")} help={t("qwfn.asyncIoHelp")}><Switch aria-label={t("qwfn.asyncIo")} checked={draft.asyncIo} onChange={v => field("asyncIo", v)}/></Setting>
    <Setting label={t("qwfn.mtp")} help={t("qwfn.mtpHelp")}>{path("mtpPath")}</Setting>
    <Setting label={t("qwfn.mtpGpu")} help={t("qwfn.mtpGpuHelp")}><Switch aria-label={t("qwfn.mtpGpu")} checked={draft.mtpGpu} onChange={v => field("mtpGpu", v)}/></Setting>
    <Setting label={t("qwfn.prefixCache")} help={t("qwfn.cacheConflict")}><Input aria-label={t("qwfn.prefixCache")} type="number" min={0} step={0.5} value={draft.prefixCacheGb} onChange={e => field("prefixCacheGb", Number(e.target.value))}/></Setting>
    <Setting label={t("router.host")}><Input aria-label={t("router.host")} value={draft.host} onChange={e => field("host", e.target.value)}/></Setting>
    <Setting label={t("qwfn.port")}><Input aria-label={t("qwfn.port")} type="number" min={1} max={65535} value={draft.port} onChange={e => field("port", Number(e.target.value))}/></Setting>
    <p className="subtle">{t("qwfn.restartNeeded")}</p><Button className="primary" disabled={busy} onClick={() => void save()}><Save size={14}/>{t("actions.save")}</Button>
  </Panel>;
}
