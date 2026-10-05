import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isLlamaModel } from "../../lib/engineModels";
import { isPrimaryModelFile, modelDisplayName, modelLaunchMetadata } from "../../lib/models";
import { pickAnyFile, pickGguf } from "../../services/dialog";
import { isParameterAvailable, isParameterValueAvailable, PARAMETER_REGISTRY, type ParameterCategory } from "../../lib/parameters";
import { validateConfig } from "../../lib/validation";
import { useControlStore } from "../../store/control";
import type { LlamaDevice } from "../../types/app";
import type { LlamaCapabilities, KvCacheType, LaunchConfig } from "../../types/config";
import { Button, Input, Select, Switch } from "../ui/Primitives";

const tabs: ParameterCategory[] = ["model", "hardware", "context", "server", "sampling", "advanced"];
const categoryKeys: Record<ParameterCategory, string> = {
  model: "config.tabs.model",
  hardware: "config.tabs.hardware",
  context: "config.tabs.context",
  server: "config.tabs.server",
  sampling: "config.tabs.sampling",
  advanced: "config.tabs.advanced",
};
type ParameterDefinition = (typeof PARAMETER_REGISTRY)[number];
type ConfigIssue = ReturnType<typeof validateConfig>[number];

export function ConfigEditor({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { config, capabilities, devices } = useControlStore();
  const [tab, setTab] = useState<ParameterCategory>(compact ? "hardware" : "model");
  const issues = useMemo(() => validateConfig(config, capabilities), [config, capabilities]);
  const definitions = PARAMETER_REGISTRY.filter(def => def.category === tab && isParameterAvailable(def, capabilities));
  const groups = tab === "hardware"
    ? ["config.groups.hardware", "config.groups.memoryKv", "config.groups.multiGpu"].map(groupKey => ({ groupKey, fields: definitions.filter(def => def.groupKey === groupKey) }))
    : [{ groupKey: undefined, fields: definitions }];

  return <div className={compact ? "configEditor compact" : "configEditor"}>
    <div className="tabs">{tabs.map(item => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{t(categoryKeys[item])}</button>)}</div>
    <div className="configFields">{groups.map(group => group.fields.length > 0 && <section className="parameterGroup" key={group.groupKey ?? tab}>
      {group.groupKey && <h4>{t(group.groupKey)}</h4>}
      {group.fields.map(def => <ParameterField key={String(def.key)} def={def} config={config} capabilities={capabilities} devices={devices} issues={issues}/>)}</section>)}</div>
    {!!issues.length && <div className="validationList">{issues.slice(0, 5).map((issue, index) => <div key={`${issue.field}-${index}`} className={issue.severity}><b>{issue.severity === "error" ? "!" : "△"}</b><span>{t(issue.messageKey)}</span></div>)}</div>}
  </div>;
}

function ParameterField({ def, config, capabilities, devices, issues }: {
  def: ParameterDefinition;
  config: LaunchConfig;
  capabilities: LlamaCapabilities;
  devices: LlamaDevice[];
  issues: ConfigIssue[];
}) {
  const { t } = useTranslation();
  const updateConfig = useControlStore(state => state.updateConfig);
  const models = useControlStore(state => state.models);
  const replaceConfig = useControlStore(state => state.replaceConfig);
  const key = def.key;
  const value = config[key] as unknown;
  const available = isParameterValueAvailable(def, config, capabilities);
  const enabled = (def.enabled ? def.enabled(config) : true) && available;
  const issue = issues.find(item => item.field === key);
  const set = (nextValue: unknown) => updateConfig(key as keyof LaunchConfig, nextValue as never);
  let control: React.ReactNode;

  if (key === "device") {
    control = devices.length
      ? <Select disabled={!enabled} value={String(value)} onChange={event => set(event.target.value)}><option value="none">none</option>{devices.map(device => <option key={device.id} value={device.id}>{device.id} — {device.name}{device.memoryMiB ? ` (${Math.round(device.memoryMiB / 1024)} GB)` : ""}</option>)}</Select>
      : <Input disabled={!enabled} value={String(value ?? "")} onChange={event => set(event.target.value)} placeholder="CUDA0"/>;
  } else if (key === "gpuLayers") {
    control = <div className="segmented">
      <button disabled={!enabled} className={value === "auto" ? "active" : ""} onClick={() => set("auto")}>{t("common.auto")}</button>
      <button disabled={!enabled} className={value === "all" ? "active" : ""} onClick={() => set("all")}>{t("common.all")}</button>
      <button disabled={!enabled} className={typeof value === "number" ? "active" : ""} onClick={() => set(48)}>{t("common.custom")}</button>
      {typeof value === "number" && <Input disabled={!enabled} type="number" value={String(value)} onChange={event => set(Number(event.target.value))}/>}
    </div>;
  } else if (key === "cacheTypeK" || key === "cacheTypeV") {
    control = <Select disabled={!enabled} value={String(value)} onChange={event => set(event.target.value as KvCacheType)}>{capabilities.kvCacheTypes.map(type => <option key={type}>{type}</option>)}</Select>;
  } else if (def.kind === "boolean") {
    control = <Switch checked={Boolean(value)} disabled={!enabled} onChange={set}/>;
  } else if (def.options) {
    control = <Select disabled={!enabled} value={String(value ?? "")} onChange={event => set(event.target.value)}>{def.options.map(option => <option key={option} value={option}>{option}</option>)}</Select>;
  } else if (def.kind === "number") {
    control = <Input disabled={!enabled} type="number" min={def.min} max={def.max} step={def.step} value={value == null ? "" : String(value)} onChange={event => set(event.target.value === "" ? undefined : Number(event.target.value))}/>;
  } else if (key === "loraPaths") {
    control = <textarea disabled={!enabled} className="uiTextarea mono" rows={4} value={(value as string[]).join("\n")} onChange={event => set(event.target.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean))}/>;
  } else if (key === "extraArgs") {
    control = <textarea className="uiTextarea mono" rows={5} value={String(value ?? "")} onChange={event => set(event.target.value)} placeholder="--some-new-option value"/>;
  } else if (key === "modelPath") {
    control = <div className="libraryModelPicker"><Select disabled={!enabled} aria-label={t("config.chooseLibraryModel")} value={models.some(model => model.path === value) ? String(value) : ""} onChange={event => { const model = models.find(candidate => candidate.path === event.target.value); if (model) replaceConfig({ ...config, modelPath: model.path, modelBytes: model.sizeBytes, modelAlias: modelDisplayName(model), ...modelLaunchMetadata(model) }); }}><option value="">{t("config.chooseLibraryModel")}</option>{models.filter(isLlamaModel).map(model => <option key={model.id} value={model.path}>{modelDisplayName(model)}{model.quantization ? ` · ${model.quantization}` : ""}</option>)}</Select><div className="pathControl"><Input disabled={!enabled} value={String(value ?? "")} onChange={event => set(event.target.value)}/><Button disabled={!enabled} onClick={async () => { const picked = await pickGguf(); if (picked) set(picked); }}>{t("actions.browse")}</Button></div></div>;
  } else if (def.kind === "path") {
    control = <div className="pathControl"><Input disabled={!enabled} value={String(value ?? "")} onChange={event => set(event.target.value)}/><Button disabled={!enabled} onClick={async () => { const picked = await pickAnyFile(); if (picked) set(picked); }}>{t("actions.browse")}</Button></div>;
  } else {
    control = <Input disabled={!enabled} type={key === "apiKey" ? "password" : "text"} value={String(value ?? "")} onChange={event => set(event.target.value)}/>;
  }

  return <div className={`parameterRow ${issue ? issue.severity : ""}`}>
    <div className="parameterLabel"><span>{t(def.labelKey)}</span>{def.cli && <code>{def.cli}</code>}<button type="button" className="parameterHelp" aria-label={t(def.helpKey)} data-tooltip={t(def.helpKey)}><span aria-hidden="true">ⓘ</span></button></div>
    <div className="parameterControl">
      {control}
      {!enabled && <small className="disabledReason">{!available ? t("capability.optionUnsupported") : key === "fitTargetMiB" || key === "fitContextMin" ? t("dependency.fitRequired") : t("dependency.splitMode")}</small>}
      {issue && <small className="issueText">{t(issue.messageKey, { name: issue.labelKey ? t(issue.labelKey) : "", minimum: issue.minimum, maximum: issue.maximum })}</small>}
    </div>
  </div>;
}
