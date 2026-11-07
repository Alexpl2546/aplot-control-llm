import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge, Button } from '../../components/ui/Primitives';
import { beginModelRecipe, cancelPreparation, dismissPreparation, retryAcquisitionProfiles, useAcquisitionStore } from './acquisition';
import { findModelRecipe } from './recipes';

export function PreparationPanel(){
  const {t}=useTranslation(),{preparation,error,profileErrors,readyProfiles,busy}=useAcquisitionStore();
  const latest=preparation?.lines.at(-1);
  const match=latest?.match(/(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)%/);
  const percent=match?Math.max(0,Math.min(100,Number(match[1]))):undefined;
  const tone=preparation?.state==='completed'?'green':['failed','cancelled'].includes(preparation?.state??'')?'red':['paused','interrupted'].includes(preparation?.state??'')?'orange':'blue';
  const profileErrorEntries=Object.entries(profileErrors).filter(([,value])=>value);

  return <>
    {preparation&&<article className="downloadTask downloadPreparationTask">
      <header className="downloadTaskHead">
        <div className="downloadTaskIdentity"><b>{preparation.recipe?.name??findModelRecipe(preparation.recipeId)?.name??preparation.recipeId}</b></div>
        <div className="downloadTaskHeadActions">
          <Badge tone={tone}>{t(`downloads.state.${preparation.state}`)}</Badge>
          {preparation.state!=='installing'&&<Button className="downloadDismiss" aria-label={t('downloads.removeHistory')} title={t('downloads.removeHistory')} onClick={()=>dismissPreparation(preparation.id)}><X size={14}/></Button>}
        </div>
      </header>
      {preparation.state==='installing'&&<>
        <p className="downloadPreparationStatus" role="status">{t('recipes.strataPreparation')}</p>
        {latest&&<p className="downloadTaskFile" role="status">{latest}</p>}
        <div className="downloadTaskProgress"><progress max={100} value={percent} aria-label={t('downloads.strataStageProgress')}/>{percent!==undefined&&<span>{Math.round(percent)}%</span>}</div>
        <div className="downloadTaskActions"><Button onClick={()=>void cancelPreparation().catch(cause=>useAcquisitionStore.setState({error:String(cause)}))}>{t('downloads.cancel')}</Button></div>
      </>}
      {readyProfiles.includes(preparation.id)&&<p className="downloadPreparationStatus" role="status">{t('recipes.profileReady')}</p>}
      {['interrupted','failed','cancelled'].includes(preparation.state)&&<div className="downloadTaskActions"><Button disabled={busy} onClick={()=>void beginModelRecipe(preparation.recipeId,preparation.destination,preparation.rootPath).catch(cause=>useAcquisitionStore.setState({error:String(cause)}))}>{t('downloads.resume')}</Button></div>}
      {preparation.configPath&&<code className="downloadPreparationPath">{preparation.configPath}</code>}
      {preparation.error&&<p className="awError downloadPreparationError">{preparation.error}</p>}
      {preparation.lines.length>0&&<details className="downloadTaskDetails"><summary>{t('aw.details')}</summary><pre className="modelPreparationLog">{preparation.lines.join('\n')}</pre></details>}
    </article>}
    {profileErrorEntries.length>0&&<details className="downloadsProfileErrors">
      <summary>{t('recipes.profileFailed')} · {profileErrorEntries.length}</summary>
      <div className="awError" role="alert">{profileErrorEntries.map(([id,value])=><p key={id}>{value}</p>)}<Button onClick={retryAcquisitionProfiles}>{t('chat.retry')}</Button></div>
    </details>}
    {error&&<p className="awError" role="alert">{error}</p>}
  </>;
}
