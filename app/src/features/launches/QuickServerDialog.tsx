import { profileSelectOption } from '../../components/ui/selectOptions';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { ENGINE_NAMES } from '../../lib/engineModels';
import { profileContextSize } from '../../lib/serverContext';
import type { ServerEngine } from '../../types/app';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { RestartDialog } from '../../components/config/RestartDialog';
import { WorkspaceDialog } from '../agent/WorkspacePanels';
import { restoreEngineOptions, profileRunId } from './profiles';
import { launchBlocker } from './readiness';
import { useLaunchAction } from './useLaunchAction';
import { useLaunchUi } from './ui';
import { isSupportedProfileEngine } from './profiles';
import { LaunchFit } from '../resources/LaunchFit';

export function QuickServerDialog() {
  const open=useLaunchUi(s=>s.quickAdd),preferredProfileId=useLaunchUi(s=>s.preferredProfileId),close=()=>useLaunchUi.getState().setQuickAdd(false);
  const {pendingLaunch,confirming,confirmLaunch,cancelLaunch,requestLaunch}=useLaunchAction();
  return <>{open&&<QuickServerForm preferredProfileId={preferredProfileId} onClose={close} onLaunch={async()=>{close();await requestLaunch('start',useControlStore.getState().selectedRunId);}}/>}<RestartDialog open={!!pendingLaunch} running={pendingLaunch?.action==='restart'} profileName={pendingLaunch?.profileName??''} pending={confirming} onConfirm={confirmLaunch} onClose={cancelLaunch}/></>;
}
function QuickServerForm({onClose,onLaunch,preferredProfileId}:{onClose:()=>void;onLaunch:()=>Promise<void>;preferredProfileId?:string}) {
  const {t}=useTranslation(),{profiles,settings,strataModels,runs,selectProfile,setView,selectRun,notify,availableEngines,refreshAvailableEngines}=useControlStore();
  const preferred=profiles.find(p=>p.id===preferredProfileId);
  const preferredEngine = preferred?.config.engine ?? (preferred ? 'llama_cpp' : settings.serverEngine);
  const [engine,setEngine]=useState<ServerEngine | ''>(isSupportedProfileEngine(preferredEngine) ? preferredEngine : ''),[chosen,setChosen]=useState(preferred?.id??''),[busy,setBusy]=useState(false);
  useEffect(()=>{void refreshAvailableEngines().catch(error=>notify('error',String(error)));},[refreshAvailableEngines,notify]);
  useEffect(()=>{if(engine&&!availableEngines.includes(engine)){setEngine('');setChosen('');}},[availableEngines,engine]);
  const installed=Boolean(engine)&&availableEngines.includes(engine as ServerEngine);
  const available=profiles.filter(p=>!p.unsupportedEngine&&isSupportedProfileEngine(p.config.engine??'llama_cpp')&&(p.config.engine??'llama_cpp')===engine);
  const profile=available.find(p=>p.id===chosen)??available[0];
  const existing=runs.find(r=>r.info.runId===profileRunId(profile?.id??'')&&!['stopped','crashed'].includes(r.info.state));
  const blocker=profile?launchBlocker(profile.config,restoreEngineOptions(profile.config,settings)):undefined;
  const launch=async()=>{
    if(!installed||!profile||busy||blocker)return;setBusy(true);
    try {if(existing){selectRun(existing.info.runId);onClose();return;}await selectProfile(profile.id);await onLaunch();}
    catch(e){notify('error',String(e));}finally{setBusy(false);}
  };
  return <WorkspaceDialog title={t('desk.server.new')} onClose={()=>{if(!busy)onClose();}}><form className="deskQuickForm" onSubmit={e=>{e.preventDefault();void launch();}}>
    <p>{t('presets.serverQuickHint')}</p>
    <label>{t('settings.engine')}<ChoiceSelect label={t('settings.engine')} disabled={busy} value={engine} options={availableEngines.map(value=>({value,label:ENGINE_NAMES[value]}))} onChange={value=>{setEngine(isSupportedProfileEngine(value)?value:'');setChosen('');}}/></label>
    <label>{t('dashboard.chooseProfile')}<ChoiceSelect variant="model" label={t('dashboard.chooseProfile')} disabled={busy||!available.length} value={profile?.id??''} options={available.map(item=>profileSelectOption(item,profileContextSize(item.config,strataModels)))} onChange={setChosen}/></label>
    {!availableEngines.length&&<p className="awNotice">{t('engines.none')} <Button type="button" onClick={()=>{onClose();setView('settings');}}>{t('nav.settings')}</Button></p>}
    {!available.length&&<p className="awNotice">{t('desk.server.noProfiles')}</p>}
    {profile&&engine&&<div className="deskQuickSummary"><b>{profile.name}</b><span>{ENGINE_NAMES[engine]} · {Math.round(profileContextSize(profile.config,strataModels)/1024)}K</span></div>}
    {profile&&!existing&&<LaunchFit config={profile.config} compact/>}
    {blocker&&<p className="awNotice" role="status">{t(blocker)}</p>}
    {existing&&<p className="awNotice">{t('desk.server.alreadyRunning')}</p>}
    <div className="awDialogActions"><Button type="button" disabled={busy} onClick={()=>{onClose();setView('profiles');}}>{t('desk.server.more')}</Button><Button type="button" disabled={busy||!profile} onClick={()=>{if(!profile)return;setBusy(true);void useControlStore.getState().saveServer(profile.id).then(id=>{selectRun(id);onClose();}).catch(e=>notify('error',String(e))).finally(()=>setBusy(false));}}>{t('presets.saveServer')}</Button><Button type="submit" className="primary" disabled={busy||!installed||!profile||!!blocker}><Play size={15}/>{t(existing?'desk.server.show':'actions.start')}</Button></div>
  </form></WorkspaceDialog>;
}
