import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { beginModelRecipe, cancelPreparation, retryAcquisitionProfiles, useAcquisitionStore } from './acquisition';
import { findModelRecipe } from './recipes';
export function PreparationPanel(){
  const {t}=useTranslation(),{preparation,error,profileErrors,readyProfiles,busy}=useAcquisitionStore();
  const latest=preparation?.lines.at(-1);
  const match=latest?.match(/(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)%/);
  const percent=match?Math.max(0,Math.min(100,Number(match[1]))):undefined;
  return <>{preparation&&<article className="downloadTask">
    <header className="downloadTaskHead"><b>{preparation.recipe?.name??findModelRecipe(preparation.recipeId)?.name??preparation.recipeId}</b><span>{t(`downloads.state.${preparation.state}`)}</span></header>
    {preparation.state==='installing'&&<><p role="status">{t('recipes.strataPreparation')}</p>{latest&&<p className="downloadTaskFile" role="status">{latest}</p>}<progress max={100} value={percent} aria-label={t('downloads.strataStageProgress')}/><Button onClick={()=>void cancelPreparation().catch(cause=>useAcquisitionStore.setState({error:String(cause)}))}>{t('downloads.cancel')}</Button></>}
    {readyProfiles.includes(preparation.id)&&<p role="status">{t('recipes.profileReady')}</p>}
    {['interrupted','failed','cancelled'].includes(preparation.state)&&<Button disabled={busy} onClick={()=>void beginModelRecipe(preparation.recipeId,preparation.destination,preparation.rootPath).catch(cause=>useAcquisitionStore.setState({error:String(cause)}))}>{t('downloads.resume')}</Button>}
    {preparation.configPath&&<code>{preparation.configPath}</code>}
    {preparation.error&&<p className="awError">{preparation.error}</p>}
    <details><summary>{t('aw.details')}</summary><pre className="modelPreparationLog">{preparation.lines.join('\n')}</pre></details>
  </article>}
  {Object.values(profileErrors).some(Boolean)&&<div className="awError" role="alert"><p>{t('recipes.profileFailed')}</p>{Object.entries(profileErrors).filter(([,value])=>value).map(([id,value])=><p key={id}>{value}</p>)}<Button onClick={retryAcquisitionProfiles}>{t('chat.retry')}</Button></div>}
  {error&&<p className="awError" role="alert">{error}</p>}</>;
}
