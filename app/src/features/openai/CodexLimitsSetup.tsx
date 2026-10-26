import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { codexLimitsAction,refreshCodexLimitsStatus,refreshQuota,useOpenAi } from './store';

export function CodexLimitsSetup({connectionId}:{connectionId:string}){
  const {t}=useTranslation();
  const auth=useOpenAi(s=>s.codexLimitsAuth[connectionId]),installed=useOpenAi(s=>s.installed);
  const quotaError=useOpenAi(s=>s.quotaErrors[connectionId]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const run=async(action:'login'|'cancel'|'logout'|'refresh')=>{
    setBusy(true);setError('');
    try{
      if(action==='refresh')await refreshQuota(true,connectionId);
      else{
        const result=await codexLimitsAction(action,connectionId);
        if(action==='login'){
          if(!result.authUrl)throw new Error('codex-auth');
          try{await openUrl(result.authUrl);}catch(e){await codexLimitsAction('cancel',connectionId);throw e;}
        }
      }
      await refreshCodexLimitsStatus(connectionId);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const issue=error||auth?.error||quotaError;
  const code=issue?.replace(/^Error: /,'');
  const known=code&&['limits-unavailable','account-mismatch','login-busy','login-denied','login-timeout','not-installed','codex-service','codex-auth','closed','timeout'].includes(code)?code:'failed';
  return <div className="oaLimitsSetup">
    <b>{t('limits.setup.title')}</b>
    <p className="oaHelp">{t(!installed?'limits.setup.install':auth?.pending?'limits.setup.waiting':auth?.connected?'limits.setup.connected':'limits.setup.hint')}</p>
    <div className="oaActions">
      {auth?.pending?<Button disabled={busy} onClick={()=>void run('cancel')}>{t('aw.cancel')}</Button>:auth?.connected?<><Button disabled={busy} onClick={()=>void run('refresh')}>{t('openai.refresh')}</Button><Button disabled={busy} onClick={()=>void run('logout')}>{t('limits.setup.disconnect')}</Button></>:<Button disabled={busy||!installed} onClick={()=>void run('login')}>{t('limits.setup.connect')}</Button>}
    </div>
    {issue&&<p className="awError" role="alert">{t(`limits.setup.error.${known}`)}</p>}
  </div>;
}
