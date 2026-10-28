import { stopRunWithUndo } from './stopWithUndo';
import { Play, RotateCw, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { Button } from '../../components/ui/Primitives';
import { RestartDialog } from '../../components/config/RestartDialog';
import { RunSelector } from './RunSelector';
import { useLaunchAction } from './useLaunchAction';
import { launchBlocker } from './readiness';
import { isActive, isTransition } from './presentation';
export function LaunchControls() {
  const {t}=useTranslation(),s=useControlStore(),run=s.runs.find(r=>r.info.runId===s.selectedRunId);
  const {requestLaunch,pendingLaunch,confirming,confirmLaunch,cancelLaunch}=useLaunchAction();
  const active=!!run&&isActive(run.info.state),blocker=s.settings.serverEngine&&s.availableEngines.includes(s.settings.serverEngine)?launchBlocker(s.config,s.settings):"engines.none";
  const busy=s.optimizerRunning||Object.values(s.runBusyById).some(Boolean)||!!run&&isTransition(run.info.state);
  return <div className="deskLaunchControls"><RunSelector compact disabled={busy}/><span className="deskLaunchProfile" title={s.config.profileName}>{s.config.profileName}{s.dirty&&<i>{t('desk.server.draft')}</i>}</span><div>{active&&<Button disabled={busy||!run.info.managed} onClick={()=>void stopRunWithUndo(run.info.runId)}><Square size={14}/>{t('actions.stop')}</Button>}<Button className="primary" disabled={busy||!!blocker||!!run&&!run.info.managed} title={blocker?t(blocker):undefined} onClick={()=>void requestLaunch(active?'restart':'start',s.selectedRunId)}>{active?<RotateCw size={14}/>:<Play size={14}/>} {t(active?'actions.restart':'actions.start')}</Button></div><RestartDialog open={!!pendingLaunch} running={pendingLaunch?.action==='restart'} profileName={pendingLaunch?.profileName??''} pending={confirming} onConfirm={confirmLaunch} onClose={cancelLaunch}/></div>;
}
