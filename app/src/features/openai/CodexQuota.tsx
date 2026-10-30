import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { AgentIcon } from '../agent/AgentIdentity';
import { initializeOpenAi, useOpenAi } from './store';
import { accountQuotas } from './accountQuotas';
import './openai.css';
import { WorkspaceDialog } from '../agent/WorkspacePanels';
const ConnectionsSettingsContent=lazy(()=>import('./OpenAiPanel').then(module=>({default:module.ConnectionsSettingsContent})));

export function CodexQuota(){
  const {t}=useTranslation(),state=useOpenAi(),[now,setNow]=useState(Date.now());
  useEffect(()=>{initializeOpenAi();const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
  const [provider,setProvider]=useState<'openai'|'claude'>();
  const [open,setOpen]=useState(false),dock=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    const away=(event:PointerEvent)=>{if(!dock.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
    document.addEventListener('pointerdown',away);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',escape);};
  },[open]);
  const accounts=accountQuotas(state);
  const renderAccount=(account:typeof accounts[number])=><li key={account.id}>
      <div className="oaAccountIdentity"><AgentIcon runtime={account.runtime}/><div><b>{account.name}</b></div></div>
      <div className="oaAccountLimits">{!account.limits.length?<span className="oaAccountUnknown" title={t(account.runtime==='codex'?'limits.setup.sidebarHint':'openai.limitsUnavailable')} aria-label={t(account.runtime==='codex'?'limits.setup.sidebarHint':'openai.limitsUnavailable')}>—</span>:account.limits.map(limit=>{
        const label=limit.minutes===10080?t('openai.week'):limit.minutes===300?t('openai.fiveHours'):limit.minutes?`${limit.minutes} ${t('openai.minutes')}`:t('openai.window');
        const value=Math.round(limit.remaining),seconds=limit.resetsAt?Math.max(0,limit.resetsAt-Math.floor(now/1000)):undefined;
        const reset=seconds===undefined?'':seconds===0?t('openai.resetPending'):t('openai.resetIn',{hours:Math.floor(seconds/3600),minutes:Math.floor(seconds%3600/60)});
        const title=[limit.label,label,t('openai.remaining',{value}),reset,limit.stale?t('openai.stale'):''].filter(Boolean).join(' · ');
        return <div className={`oaAccountLimit${value<=10?' isLow':''}${limit.stale?' isStale':''}`} key={limit.id} title={title}><span>{limit.label?`${limit.label} · ${label}`:label}</span><progress max={100} value={value} aria-label={title}/><b>{value}%</b></div>;
      })}</div>
    </li>;
  const openai=accounts.filter(account=>account.runtime==='codex'),claude=accounts.filter(account=>account.runtime==='claude');
  // The sidebar shows one chip per provider with its lowest limit; the full list opens above it.
  const lowest=(list:typeof accounts)=>{const values=list.flatMap(account=>account.limits.map(limit=>Math.round(limit.remaining)));return values.length?Math.min(...values):undefined;};
  const chip=(runtime:'codex'|'claude',name:string,list:typeof accounts)=>{const value=lowest(list);const label=value===undefined?t('quota.chipUnknown',{name}):t('quota.chip',{name,value});
    return <button type="button" className={`oaQuotaChip${value!==undefined&&value<=10?' isLow':''}`} aria-expanded={open} aria-haspopup="true" title={label} aria-label={label} onClick={()=>setOpen(!open)}><AgentIcon runtime={runtime}/><b>{value===undefined?'—':`${value}%`}</b></button>;};
  return <div className="oaQuotaDock" ref={dock}>
    {open&&<section className="oaAccounts oaQuotaPopover" aria-label={t('profiles.accounts')}>
    <div className="oaProviderAccounts oaCodexAccounts"><header><button type="button" className="oaProviderManage" aria-haspopup="dialog" onClick={()=>{setOpen(false);setProvider('openai');}}><AgentIcon runtime="codex"/><b>Codex</b></button><button type="button" className="oaQuotaAdd" aria-haspopup="dialog" onClick={()=>{setOpen(false);setProvider('openai');}}><Plus size={13}/>{t('quota.add')}</button></header>{openai.length?<ul>{openai.map(renderAccount)}</ul>:<p className="oaAccountsEmpty">{t('profiles.noActiveAccounts')}</p>}</div>
    <div className="oaProviderAccounts oaClaudeAccounts"><header><button type="button" className="oaProviderManage" aria-haspopup="dialog" onClick={()=>{setOpen(false);setProvider('claude');}}><AgentIcon runtime="claude"/><b>Claude</b></button><button type="button" className="oaQuotaAdd" aria-haspopup="dialog" onClick={()=>{setOpen(false);setProvider('claude');}}><Plus size={13}/>{t('quota.add')}</button></header>{claude.length?<ul>{claude.map(renderAccount)}</ul>:<p className="oaAccountsEmpty">{t('profiles.noActiveAccounts')}</p>}</div>
    </section>}
    <div className="oaQuotaChips">{chip('codex','Codex',openai)}{chip('claude','Claude',claude)}</div>
    {provider&&<WorkspaceDialog title={`${provider==='openai'?'Codex':'Claude'} · ${t('profiles.accounts')}`} onClose={()=>setProvider(undefined)}><div className="oaProviderDialog"><Suspense fallback={<p>{t('aw.loading')}</p>}><ConnectionsSettingsContent providerFilter={provider}/></Suspense></div></WorkspaceDialog>}
  </div>;
}
