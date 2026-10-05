import { RotateCw, Save, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CliPreview } from "../components/config/CliPreview";
import { ConfigEditor } from "../components/config/ConfigEditor";
import { ResourceEstimator } from "../components/config/ResourceEstimator";
import { OllamaConfiguration } from "../components/config/OllamaConfiguration";
import { StrataModelCard } from "../components/config/StrataModelCard";
import { QwfnConfiguration } from "../components/config/QwfnConfiguration";
import { SaveAsDialog } from "../components/config/SaveAsDialog";
import { Button, Input, SectionTitle } from "../components/ui/Primitives";
import { useControlStore } from "../store/control";

export function ConfigurationView() {
  const { t } = useTranslation();
  const [saveAs, setSaveAs] = useState(false);
  const { dirty, saveCurrentProfile, config, savedConfig, replaceConfig, profiles, selectProfile, updateConfig, settings, setView, notify } = useControlStore();
  if (settings.serverEngine === "qwfnfer") return <div className="page"><SectionTitle title={t("nav.configuration")} description={t("config.pageDescription")}/><div className="configPageGrid"><QwfnConfiguration/><aside><CliPreview/></aside></div></div>;
  if (settings.serverEngine === "ollama") return <div className="page"><SectionTitle title={t("nav.configuration")} description={t("config.pageDescription")}/><OllamaConfiguration/></div>;
  if (settings.serverEngine === "strata") return <div className="page">
    <SectionTitle title={t("nav.configuration")} description={t("config.pageDescription")} />
    <div className="configPageGrid">
      <StrataModelCard />
      <aside><CliPreview /></aside>
    </div>
  </div>;
  return (
    <div className="page">
      <div className="configurationHeader"><SectionTitle
        title={t("nav.configuration")}
        description={t("config.pageDescription")}
        action={<div className="toolbar">
          <select className="uiSelect" value={config.profileId} onChange={e => selectProfile(e.target.value)}>
            {profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp").map(profile => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
          </select>
          <Input className="profileNameInput" aria-label={t("profiles.profileName")} value={config.profileName} onChange={e => updateConfig("profileName", e.target.value)}/>
          <Button disabled={!dirty} onClick={() => replaceConfig(savedConfig, true)}><Undo2 size={14}/>{t("actions.discard")}</Button>
          <Button onClick={() => void saveCurrentProfile()}><Save size={14}/>{t("actions.save")}</Button>
          <Button onClick={() => setSaveAs(true)}>{t("actions.saveAs")}</Button>
          <Button className="primary" onClick={() => { void saveCurrentProfile().then(() => setView("dashboard")).catch(error => notify("error", String(error))); }}><RotateCw size={14}/>{t("actions.saveAndHome")}</Button>
        </div>}
      /></div>
      <div className="configPageGrid">
        <section className="panel configPagePanel"><ConfigEditor/></section>
        <aside><ResourceEstimator/><CliPreview/></aside>
      </div>
      <SaveAsDialog open={saveAs} onClose={() => setSaveAs(false)}/>
    </div>
  );
}
