import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  return <section className="oaAccounts" aria-label={t('profiles.accounts')}>
    <div className="oaProviderAccounts oaCodexAccounts"><header><button type="button" className="oaProviderManage" aria-haspopup="dialog" onClick={()=>setProvider('openai')}><AgentIcon runtime="codex"/><b>Codex</b></button></header>{openai.length?<ul>{openai.map(renderAccount)}</ul>:<p className="oaAccountsEmpty">{t('profiles.noActiveAccounts')}</p>}</div>
    <div className="oaProviderAccounts oaClaudeAccounts"><header><button type="button" className="oaProviderManage" aria-haspopup="dialog" onClick={()=>setProvider('claude')}><AgentIcon runtime="claude"/><b>Claude</b></button></header>{claude.length?<ul>{claude.map(renderAccount)}</ul>:<p className="oaAccountsEmpty">{t('profiles.noActiveAccounts')}</p>}</div>
    {provider&&<WorkspaceDialog title={`${provider==='openai'?'Codex':'Claude'} · ${t('profiles.accounts')}`} wide onClose={()=>setProvider(undefined)}><div className="oaProviderDialog"><Suspense fallback={<p>{t('aw.loading')}</p>}><ConnectionsSettingsContent providerFilter={provider}/></Suspense></div></WorkspaceDialog>}
  </section>;
}
