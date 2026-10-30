import { profileSelectOption } from '../components/ui/selectOptions';
import { Select } from '../components/ui/Primitives';
import { RotateCw, Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CliPreview } from "../components/config/CliPreview";
import { ConfigEditor } from "../components/config/ConfigEditor";
import { ResourceEstimator } from "../components/config/ResourceEstimator";
import { StrataModelCard } from "../components/config/StrataModelCard";
import { SaveAsDialog } from "../components/config/SaveAsDialog";
import { Button, Input, SectionTitle } from "../components/ui/Primitives";
import { useControlStore } from "../store/control";
import { EngineProfileControls } from "../features/launches/EngineProfileControls";
import { ResourcePlanPanel } from "../features/resources/ResourcePlanPanel";
import { captureEngineOptions, profileRunId } from "../features/launches/profiles";
import { createRunStartRequest } from "../services/tauri";
import type { StartRunRequest } from "../types/runtime";
import { SmartTaskDesk } from "../features/smartTasks/SmartTaskDesk";
import { PickCheck, PickDone, PickSteps, usePickStep } from "../features/navigation/PickWizard";

function ResourcePlanPreview() {
  const config = useControlStore(state => state.config);
  const settings = useControlStore(state => state.settings);
  const profiles = useControlStore(state => state.profiles);
  const capabilities = useControlStore(state => state.capabilities);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const input = useMemo(() => ({ config: captureEngineOptions(config, settings), settings, profiles, capabilities, runId: selectedRunId ?? profileRunId(config.profileId), preview: true }), [config, settings, profiles, capabilities, selectedRunId]);
  const [prepared, setPrepared] = useState<{ input: typeof input; request: StartRunRequest | null; error?: string }>();
  useEffect(() => {
    let active = true;
    void createRunStartRequest(input)
      .then(request => { if (active) setPrepared({ input, request }); })
      .catch(error => { if (active) setPrepared({ input, request: null, error: String(error) }); });
    return () => { active = false; };
  }, [input]);
  const current = prepared?.input === input ? prepared : undefined;
  return <>{current?.error && <p role="alert">{current.error}</p>}<ResourcePlanPanel request={current?.request ?? null}/></>;
}

function EngineConfigurationView() {
  const { t } = useTranslation();
  const [saveAs, setSaveAs] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const { dirty, saveCurrentProfile, config, savedConfig, replaceConfig, profiles, selectProfile, updateConfig, settings, setView, notify, busy, optimizerRunning } = useControlStore();
  const disabled = busy || optimizerRunning || pending;
  const runAction = async (action: () => Promise<unknown>) => {
    if (busy || optimizerRunning || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { await action(); }
    catch (error) { notify("error", String(error)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  if (!settings.serverEngine) return <div className="page"><SectionTitle title={t("nav.configuration")} description={t("config.pageDescription")} action={<EngineProfileControls/>}/><div className="serverHeroNotice" role="status"><p>{settings.legacyEngineId ? t("profiles.unsupportedEngine", { engine: settings.legacyEngineId }) : t("engines.none")}</p><Button onClick={() => setView("settings")}>{t("nav.settings")}</Button></div></div>;
  if (settings.serverEngine === "strata") return <div className="page">
    <SectionTitle title={t("nav.configuration")} description={t("config.pageDescription")} action={<EngineProfileControls/>}/>
    <div className="configPageGrid">
      <StrataModelCard />
      <aside><ResourcePlanPreview/><CliPreview /></aside>
    </div>
  </div>;
  return (
    <div className="page">
      <div className="configurationHeader"><SectionTitle
        title={t("nav.configuration")}
        description={t("config.pageDescription")}
        action={<div className="toolbar">
          <Select searchable disabled={disabled} aria-label={t("profiles.profile")} className="uiSelect" value={config.profileId} onChange={e => void runAction(() => selectProfile(e.target.value))}>
            {profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp").map(profile => <option value={profile.id} key={profile.id} data-description={profileSelectOption(profile).description}>{profile.name}</option>)}
          </Select>
          <Input className="profileNameInput" disabled={disabled} aria-label={t("profiles.profileName")} value={config.profileName} onChange={e => updateConfig("profileName", e.target.value)}/>
          <Button disabled={!dirty || disabled} onClick={() => replaceConfig(savedConfig, true)}><Undo2 size={14}/>{t("actions.discard")}</Button>
          <Button disabled={disabled} onClick={() => void runAction(saveCurrentProfile)}><Save size={14}/>{t("actions.save")}</Button>
          <Button disabled={disabled} onClick={() => setSaveAs(true)}>{t("actions.saveAs")}</Button>
          <Button className="primary" disabled={disabled} onClick={() => void runAction(async () => { await saveCurrentProfile(); setView("dashboard"); })}><RotateCw size={14}/>{t("actions.saveAndHome")}</Button>
        </div>}
      /></div>
      <div className="configPageGrid">
        <section className="panel configPagePanel"><ConfigEditor/></section>
        <aside><ResourceEstimator/><ResourcePlanPreview/><CliPreview/></aside>
      </div>
      <SaveAsDialog open={saveAs} onClose={() => setSaveAs(false)}/>
    </div>
  );
}

/** «Подобрать»: one screen — the wizard steps, the sliders, and the exact parameters folded below them. */
export function ConfigurationView() {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const taskScope = useControlStore(state => state.selectedRunId ?? state.config.profileId);
  const { step, setStep } = usePickStep();
  return <>
    <PickSteps step={step} onStep={setStep}/>
    {step === 'task' && <>
      <div className="page taskPage"><SmartTaskDesk key={taskScope} onSaved={() => setStep('check')}/></div>
      <details className="pickAdvanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
        <summary>{t('smart.tabs.engine')}</summary>
        {advanced && <EngineConfigurationView/>}
      </details>
    </>}
    {step === 'check' && <PickCheck onNext={() => setStep('done')}/>}
    {step === 'done' && <PickDone onBack={setStep}/>}
  </>;
}
