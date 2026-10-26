import { useEffect, useState } from 'react';
import { CodexLimitsSetup } from './CodexLimitsSetup';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Power, Trash2, LogOut, Check } from 'lucide-react';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { useControlStore } from '../../store/control';
import { openSettingsSection } from '../../services/settingsWindow';
import { AgentIcon } from '../agent/AgentIdentity';
import { initializeOpenAi, refreshOpenAi, updateConnectionProfile, useOpenAi, type ConnectionProfile } from './store';

export function ConnectionsSettingsContent({providerFilter}:{providerFilter?:'openai'|'claude'}){
  const {t}=useTranslation(),s=useOpenAi(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [adding,setAdding]=useState(false),[provider,setProvider]=useState<'openai'|'claude'>(providerFilter??'openai'),[name,setName]=useState('');
  const [rename,setRename]=useState(''),[renameName,setRenameName]=useState('');
  const [confirm,setConfirm]=useState<{p:ConnectionProfile;action:'delete'|'disconnect'|'disable'}>();
  const runs=useControlStore(state=>state.runs),setView=useControlStore(state=>state.setView);
  useEffect(()=>initializeOpenAi(),[]);
  const action=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await refreshOpenAi(true);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const profiles=s.profiles.filter(p=>!providerFilter||p.provider===providerFilter);
  const connected=profiles.filter(p=>p.enabled&&s.profileStatuses[p.id]?.connected).length;
  const profileLabel=(p:ConnectionProfile)=>p.name.trim()||s.profileStatuses[p.id]?.email?.trim()||p.email?.trim()||(p.provider==='openai'?'Codex':'Claude');
  return <div className="oaConnections">
    {confirm?<><h3>{t(`profiles.confirm.${confirm.action}`,{name:profileLabel(confirm.p)})}</h3><p>{t(`profiles.confirmHint.${confirm.action}`)}</p><div className="oaActions"><Button disabled={busy} onClick={()=>setConfirm(undefined)}>{t('aw.cancel')}</Button><Button disabled={busy} className="awDangerButton" onClick={()=>void action(async()=>{await updateConnectionProfile(confirm.action,{id:confirm.p.id});setConfirm(undefined);})}>{t(`profiles.action.${confirm.action}`)}</Button></div></>:<>
    <header className="oaProfilesHeader"><div><h3>{t('profiles.accounts')}</h3><p>{t('profiles.connectedCount',{count:connected})}</p></div><Button disabled={busy} onClick={()=>{setAdding(v=>!v);setName('');}}><Plus size={15}/>{t('profiles.add')}</Button></header>
    <p className="oaHelp">{t('profiles.hint')}</p>
    {adding&&<form className="oaProfileAdd" onSubmit={e=>{e.preventDefault();void action(async()=>{await updateConnectionProfile('create',{provider,name:name.trim()});setAdding(false);});}}><ChoiceSelect disabled={!!providerFilter} label={t('profiles.provider')} value={provider} options={[{value:'openai',label:'ChatGPT'},{value:'claude',label:'Claude Code'}]} onChange={v=>setProvider(v as typeof provider)}/><input autoFocus aria-label={t('profiles.name')} placeholder={t('profiles.namePlaceholder')} maxLength={80} value={name} onChange={e=>setName(e.target.value)}/><Button type="submit" disabled={busy} className="primary">{t('profiles.create')}</Button></form>}
    {!profiles.length&&<p>{t('profiles.empty')}</p>}
    {profiles.map(p=>{
      const status=s.profileStatuses[p.id],connected=p.enabled&&!!status?.connected,pending=!!status?.pending;
      const installed=p.provider==='openai'||s.claude.installed;
      return <section className={`oaProfile${!p.enabled?' isDisabled':''}`} key={p.id}>
        <header><AgentIcon runtime={p.provider==='openai'?'codex':'claude'} size={22}/><div><h3>{profileLabel(p)}</h3><span>{p.provider==='openai'?'ChatGPT · '+t('profiles.chatAndCodex'):'Claude Code · '+t('profiles.chatAndAgent')}</span></div><span className={`oaProfileState${connected?' isConnected':''}`}>{t(!p.enabled?'profiles.disabled':pending?'openai.waiting':connected?'profiles.connected':'profiles.signedOut')}</span></header>
        {rename===p.id?<form className="oaActions" onSubmit={e=>{e.preventDefault();void action(async()=>{await updateConnectionProfile('rename',{id:p.id,name:renameName});setRename('');});}}><input aria-label={t('profiles.name')} placeholder={t('profiles.namePlaceholder')} maxLength={80} value={renameName} onChange={e=>setRenameName(e.target.value)}/><Button type="submit" disabled={busy}>{t('aw.save')}</Button><Button type="button" onClick={()=>setRename('')}>{t('aw.cancel')}</Button></form>:<>
        <div className="oaActions">
          {!p.enabled?<Button disabled={busy} onClick={()=>void action(()=>updateConnectionProfile('enable',{id:p.id}))}><Power size={14}/>{t('profiles.enable')}</Button>:pending?<Button disabled={busy} onClick={()=>void action(()=>p.provider==='openai'?invoke('openai_cancel_login'):invoke('claude_login',{action:'cancel',profileId:p.id}))}>{t('aw.cancel')}</Button>:!connected&&installed?<Button disabled={busy} className="primary" onClick={()=>void action(async()=>{if(p.provider==='openai'){const url=await invoke<string>('openai_login',{profileId:p.id});await openUrl(url);}else await invoke('claude_login',{action:'login',profileId:p.id});})}>{p.provider==='openai'?'Continue with ChatGPT':t('profiles.connectClaude')}</Button>:null}
          {p.enabled&&connected&&(s.defaults[p.provider]===p.id?<span className="oaDefault"><Check size={14}/>{t('profiles.default')}</span>:<Button disabled={busy} onClick={()=>void action(()=>updateConnectionProfile('select',{id:p.id}))}>{t('profiles.makeDefault')}</Button>)}
          {p.enabled&&<Button disabled={busy||pending} title={t('profiles.disableHint')} onClick={()=>setConfirm({p,action:'disable'})}><Power size={14}/>{t('profiles.action.disable')}</Button>}
          <Button disabled={busy||pending} onClick={()=>{setRename(p.id);setRenameName(p.name);}}><Pencil size={14}/>{t('profiles.rename')}</Button>
          {connected&&<Button disabled={busy} onClick={()=>setConfirm({p,action:'disconnect'})}><LogOut size={14}/>{t('profiles.action.disconnect')}</Button>}
          <Button disabled={busy} className="oaDelete" onClick={()=>setConfirm({p,action:'delete'})}><Trash2 size={14}/>{t('profiles.action.delete')}</Button>
        </div>
        {p.provider==='openai'&&connected&&status?.connectionId&&<CodexLimitsSetup connectionId={status.connectionId}/>}
        {!installed&&<p>{t('profiles.claudeMissing')}</p>}
        {(s.profileErrors[p.id]||(status&&'error' in status&&status.error))&&<ConnectionError value={s.profileErrors[p.id]||(status as {error?:string})?.error||''}/>}
        </>}
      </section>;
    })}
    {!providerFilter&&<section className="oaLocal"><header><AgentIcon runtime="local" size={22}/><h3>{t('profiles.local')}</h3><span>{t('profiles.localCount',{count:runs.length})}</span></header><p>{t('profiles.localHint')}</p>{runs.map(r=><div className="oaLocalRow" key={r.info.runId}><b>{r.info.name}</b><span>{r.info.engine} · {r.info.state==='ready'||r.info.state==='busy'?t('profiles.connected'):t('profiles.serverStopped')}</span></div>)}<Button onClick={()=>{useControlStore.setState({settingsOpen:false});setView('models');}}>{t('profiles.manageLocal')}</Button></section>}
    <details className="oaRuntimeSetup"><summary>{t('profiles.runtimeSetup')}</summary><p>{t('profiles.runtimeHint')}</p>{(['codex','claude'] as const).filter(runtime=>!providerFilter||runtime===(providerFilter==='openai'?'codex':'claude')).map(runtime=><div key={runtime}><b><AgentIcon runtime={runtime}/>{runtime==='codex'?'Codex CLI':'Claude Code'}</b><span>{t((runtime==='codex'?s.installed:s.claude.installed)?'profiles.runtimeReady':'profiles.runtimeMissing')}</span><Button disabled={busy} onClick={()=>void action(async()=>{const path=await open({multiple:false,filters:[{name:runtime==='codex'?'Codex CLI':'Claude Code',extensions:['exe']}]});if(typeof path==='string')await invoke(runtime==='codex'?'codex_set_executable':'claude_set_executable',{path});})}>{t('profiles.chooseExecutable')}</Button></div>)}<Button onClick={()=>{openSettingsSection('components');}}>{t('profiles.manageComponents')}</Button></details>
    <Button disabled={busy} onClick={()=>void action(()=>refreshOpenAi(true))}>{t('openai.refresh')}</Button>
    </>}
    {(error||s.error)&&<ConnectionError value={error||s.error}/>}
  </div>;
}
function ConnectionError({value}:{value:string}){
  const {t}=useTranslation(),code=value.replace(/^Error: /,'');
  const known=['auth','network','plan-permission','login-denied','login-timeout','signed-out-locally-revoke-unconfirmed'].includes(code);
  return <div className="awError" role="alert"><p>{t(known?`openai.error.${code}`:'openai.error.failed')}</p>{!known&&<details><summary>{t('aw.details')}</summary><pre>{value.slice(0,1500)}</pre></details>}</div>;
}
