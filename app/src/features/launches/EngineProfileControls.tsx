import { profileSelectOption } from '../../components/ui/selectOptions';
import { Copy, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Button, Input, Select } from "../../components/ui/Primitives";

export function EngineProfileControls() {
  const { t } = useTranslation();
  const profiles = useControlStore(state => state.profiles);
  const config = useControlStore(state => state.config);
  const settings = useControlStore(state => state.settings);
  const busy = useControlStore(state => state.busy);
  const updateConfig = useControlStore(state => state.updateConfig);
  const selectProfile = useControlStore(state => state.selectProfile);
  const saveCurrentProfile = useControlStore(state => state.saveCurrentProfile);
  const duplicateProfile = useControlStore(state => state.duplicateProfile);
  const notify = useControlStore(state => state.notify);
  const engineProfiles = profiles.filter(profile => (profile.config.engine ?? "llama_cpp") === settings.serverEngine);
  const runAction = async (action: () => Promise<void>) => {
    try { await action(); }
    catch (error) { notify("error", String(error)); }
  };
  return <div className="toolbar engineProfileControls">
    <Select searchable aria-label={t("launches.profile")} value={engineProfiles.some(profile => profile.id === config.profileId) ? config.profileId : ""} onChange={event => void runAction(() => selectProfile(event.target.value))}>
      {!engineProfiles.length && <option value="">{t("launches.noProfiles")}</option>}
      {engineProfiles.map(profile => <option key={profile.id} value={profile.id} data-description={profileSelectOption(profile).description}>{profile.name}</option>)}
    </Select>
    <Input className="profileNameInput" aria-label={t("profiles.profileName")} value={config.profileName} onChange={event => updateConfig("profileName", event.target.value)}/>
    <Button disabled={busy} onClick={() => void runAction(saveCurrentProfile)}><Save size={14}/>{t("actions.save")}</Button>
    <Button disabled={busy} onClick={() => void runAction(() => duplicateProfile())}><Copy size={14}/>{t("actions.saveAs")}</Button>
  </div>;
}
