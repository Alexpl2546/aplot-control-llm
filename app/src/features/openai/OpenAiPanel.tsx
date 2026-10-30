import { useEffect, useState, type CSSProperties } from 'react';
import { CodexLimitsSetup } from './CodexLimitsSetup';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '../../services/filePicker';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Plus, Pencil, Power, Trash2, LogOut, Star, RefreshCw, FileSearch, X } from 'lucide-react';
import { Button } from '../../components/ui/Primitives';
import { ComponentFailure, ComponentIcon, ComponentInstallButton, ComponentProgress } from '../../components/config/ComponentInstall';
import './connections.css';
import { initializeOpenAi, refreshOpenAi, updateConnectionProfile, useOpenAi, type ConnectionProfile } from './store';

type Provider = 'openai'|'claude';
const runtimeOf = (provider:Provider) => provider==='openai'?'codex':'claude';
const programName = (provider:Provider) => provider==='openai'?'Codex CLI':'Claude Code';
const providerName = (provider:Provider) => provider==='openai'?'ChatGPT':'Claude';

export function ConnectionsSettingsContent({providerFilter}:{providerFilter?:Provider}){
  const {t}=useTranslation(),s=useOpenAi(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [adding,setAdding]=useState(false),[name,setName]=useState('');
  const [rename,setRename]=useState(''),[renameName,setRenameName]=useState('');
  const [confirm,setConfirm]=useState<{p:ConnectionProfile;action:'delete'|'disconnect'|'disable'}>();
  useEffect(()=>initializeOpenAi(),[]);
  const action=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();await refreshOpenAi(true);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const providers=(['openai','claude'] as const).filter(p=>!providerFilter||p===providerFilter);
  const profiles=s.profiles.filter(p=>!providerFilter||p.provider===providerFilter);
  const connected=profiles.filter(p=>p.enabled&&s.profileStatuses[p.id]?.connected).length;
  const programReady=(provider:Provider)=>provider==='openai'?s.installed:s.claude.installed;
  const profileLabel=(p:ConnectionProfile)=>p.name.trim()||s.profileStatuses[p.id]?.email?.trim()||p.email?.trim()||providerName(p.provider);
  const create=(provider:Provider)=>void action(async()=>{await updateConnectionProfile('create',{provider,name:name.trim()});setAdding(false);setName('');});
  const chooseProgram=(provider:Provider)=>void action(async()=>{const path=await open({multiple:false,filters:[{name:programName(provider),extensions:['exe']}]});if(typeof path==='string')await invoke(provider==='openai'?'codex_set_executable':'claude_set_executable',{path});});

  if(confirm)return <div className="oaConnections">
    <div className="oaConfirm"><h3>{t(`profiles.confirm.${confirm.action}`,{name:profileLabel(confirm.p)})}</h3><p>{t(`profiles.confirmHint.${confirm.action}`)}</p><div className="oaActions"><Button disabled={busy} onClick={()=>setConfirm(undefined)}>{t('aw.cancel')}</Button><Button disabled={busy} className="awDangerButton" onClick={()=>void action(async()=>{await updateConnectionProfile(confirm.action,{id:confirm.p.id});setConfirm(undefined);})}>{t(`profiles.action.${confirm.action}`)}</Button></div></div>
    {(error||s.error)&&<ConnectionError value={error||s.error}/>}
  </div>;

  const showAdd=adding||!profiles.length;
  return <div className="oaConnections">
    <header className="oaHead">
      <div><h3>{t('profiles.accounts')}</h3>{profiles.length>0&&<p>{t('profiles.connectedOf',{count:connected,total:profiles.length})}</p>}</div>
      <Button className={clsx('kIconBtn',s.loading&&'isSpinning')} disabled={busy} title={t('openai.refresh')} aria-label={t('openai.refresh')} onClick={()=>void action(()=>refreshOpenAi(true))}><RefreshCw size={15}/></Button>
      {profiles.length>0&&<Button className={adding?undefined:'primary'} disabled={busy} aria-expanded={adding} onClick={()=>{setAdding(v=>!v);setName('');}}>{adding?<X size={15}/>:<Plus size={15}/>}{t(adding?'aw.cancel':'profiles.add')}</Button>}
    </header>

    {showAdd&&<section className="oaAdd" aria-label={t('profiles.add')}>
      <b>{t('profiles.addTitle')}</b>
      <input className="uiInput" aria-label={t('profiles.name')} placeholder={t('profiles.nameOptional')} maxLength={80} value={name} onChange={e=>setName(e.target.value)}/>
      <div className="oaProviderTiles">{providers.map(provider=><button type="button" key={provider} className="oaProviderTile" disabled={busy} onClick={()=>create(provider)}>
        <ComponentIcon id={runtimeOf(provider)} size={20}/><span><strong>{providerName(provider)}</strong><small>{t(`profiles.providerHint.${provider}`)}</small></span><Plus size={16} className="oaTilePlus"/>
      </button>)}</div>
    </section>}

    {profiles.length>0&&<div className="oaProfileList">{profiles.map((p,index)=>{
      const status=s.profileStatuses[p.id],isConnected=p.enabled&&!!status?.connected,pending=!!status?.pending;
      const ready=p.provider==='openai'||s.claude.installed,isDefault=isConnected&&s.defaults[p.provider]===p.id;
      const state=!p.enabled?'disabled':pending?'pending':isConnected?'connected':'signedOut';
      const subtitle=(status?.email||p.email)&&profileLabel(p)!==(status?.email||p.email)?`${providerName(p.provider)} · ${status?.email||p.email}`:t(`profiles.providerHint.${p.provider}`);
      const failure=s.profileErrors[p.id]||(status&&'error' in status?(status as {error?:string}).error:'');
      return <article className={`oaCard is-${state}`} key={p.id} style={{'--i':index} as CSSProperties}>
        <div className="oaCardMain">
          <ComponentIcon id={runtimeOf(p.provider)} size={20}/>
          <div className="oaCardText">
            <div className="oaCardName"><strong>{profileLabel(p)}</strong>
              <span className={`componentStatus is-${{connected:'installed',pending:'external',signedOut:'blocked',disabled:'absent'}[state]}`}><i aria-hidden="true"/>{t(state==='disabled'?'profiles.disabled':state==='pending'?'openai.waiting':state==='connected'?'profiles.connected':'profiles.signedOut')}</span>
              {isDefault&&<span className="componentStatus is-update"><Star size={11}/>{t('profiles.default')}</span>}
            </div>
            <p>{subtitle}</p>
          </div>
          <div className="oaCardActions">
            {!p.enabled?<Button disabled={busy} onClick={()=>void action(()=>updateConnectionProfile('enable',{id:p.id}))}><Power size={14}/>{t('profiles.enable')}</Button>
              :pending?<Button disabled={busy} onClick={()=>void action(()=>p.provider==='openai'?invoke('openai_cancel_login'):invoke('claude_login',{action:'cancel',profileId:p.id}))}>{t('aw.cancel')}</Button>
              :!isConnected&&ready?<Button disabled={busy} className="primary" onClick={()=>void action(async()=>{if(p.provider==='openai'){const url=await invoke<string>('openai_login',{profileId:p.id});await openUrl(url);}else await invoke('claude_login',{action:'login',profileId:p.id});})}>{t(p.provider==='openai'?'profiles.signIn.openai':'profiles.connectClaude')}</Button>
              :isConnected&&!isDefault?<Button disabled={busy} onClick={()=>void action(()=>updateConnectionProfile('select',{id:p.id}))}><Star size={14}/>{t('profiles.makeDefault')}</Button>:null}
            <Button className="kIconBtn" disabled={busy||pending} title={t('profiles.rename')} aria-label={t('profiles.rename')} onClick={()=>{setRename(rename===p.id?'':p.id);setRenameName(p.name);}}><Pencil size={14}/></Button>
            {p.enabled&&<Button className="kIconBtn" disabled={busy||pending} title={t('profiles.disableHint')} aria-label={t('profiles.action.disable')} onClick={()=>setConfirm({p,action:'disable'})}><Power size={14}/></Button>}
            {isConnected&&<Button className="kIconBtn" disabled={busy} title={t('profiles.action.disconnect')} aria-label={t('profiles.action.disconnect')} onClick={()=>setConfirm({p,action:'disconnect'})}><LogOut size={14}/></Button>}
            <Button className="kIconBtn oaDeleteIcon" disabled={busy} title={t('profiles.action.delete')} aria-label={t('profiles.action.delete')} onClick={()=>setConfirm({p,action:'delete'})}><Trash2 size={14}/></Button>
          </div>
        </div>
        {rename===p.id&&<form className="oaRename" onSubmit={e=>{e.preventDefault();void action(async()=>{await updateConnectionProfile('rename',{id:p.id,name:renameName});setRename('');});}}><input className="uiInput" autoFocus aria-label={t('profiles.name')} placeholder={t('profiles.namePlaceholder')} maxLength={80} value={renameName} onChange={e=>setRenameName(e.target.value)}/><Button type="submit" className="primary" disabled={busy}>{t('aw.save')}</Button><Button type="button" onClick={()=>setRename('')}>{t('aw.cancel')}</Button></form>}
        {!ready&&p.enabled&&<div className="oaNeedProgram"><span>{t('profiles.needProgram',{name:programName(p.provider)})}</span><ComponentInstallButton id={runtimeOf(p.provider)}/></div>}
        {!ready&&<><ComponentProgress id={runtimeOf(p.provider)}/><ComponentFailure id={runtimeOf(p.provider)}/></>}
        {p.provider==='openai'&&isConnected&&status?.connectionId&&<details className="oaLimits"><summary>{t('profiles.limits')}</summary><CodexLimitsSetup connectionId={status.connectionId}/></details>}
        {failure&&<ConnectionError value={failure}/>}
      </article>;
    })}</div>}

    <section className="oaPrograms" aria-label={t('profiles.runtimeSetup')}>
      <header><h4>{t('profiles.runtimeSetup')}</h4><p>{t('profiles.runtimeHint')}</p></header>
      {providers.map(provider=>{const id=runtimeOf(provider),ok=programReady(provider);return <div className="oaProgram" key={provider}>
        <div className="oaProgramRow">
          <ComponentIcon id={id} size={18}/>
          <div className="oaCardText"><div className="oaCardName"><strong>{programName(provider)}</strong><span className={`componentStatus is-${ok?'installed':'absent'}`}><i aria-hidden="true"/>{t(ok?'profiles.program.ready':'profiles.program.missing')}</span></div><p>{t(`profiles.program.for.${provider}`)}</p></div>
          <div className="oaCardActions">
            {!ok&&<ComponentInstallButton id={id}/>}
            <Button className="kIconBtn" disabled={busy} title={t('profiles.chooseExecutable')} aria-label={t('profiles.chooseExecutable')} onClick={()=>chooseProgram(provider)}><FileSearch size={15}/></Button>
          </div>
        </div>
        <ComponentProgress id={id}/><ComponentFailure id={id}/>
      </div>;})}
    </section>
    {(error||s.error)&&<ConnectionError value={error||s.error}/>}
  </div>;
}
function ConnectionError({value}:{value:string}){
  const {t}=useTranslation(),code=value.replace(/^Error: /,'');
  const known=['auth','network','plan-permission','login-denied','login-timeout','signed-out-locally-revoke-unconfirmed'].includes(code);
  return <div className="awError" role="alert"><p>{t(known?`openai.error.${code}`:'openai.error.failed')}</p>{!known&&<details><summary>{t('aw.details')}</summary><pre>{value.slice(0,1500)}</pre></details>}</div>;
}
