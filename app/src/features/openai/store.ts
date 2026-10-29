import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../../services/tauri';
import { storeClaudeReasoning, storeCodexReasoning, type CodexListedModel } from '../reasoning/profiles';

export interface OpenAiStatus {connected:boolean;email?:string;connectionId?:string;pending:boolean;error?:string;}
export interface ClaudeStatus {installed:boolean;connected:boolean;email?:string;connectionId?:string;pending?:boolean;planType?:string;}
export interface ConnectionProfile {id:string;provider:'openai'|'claude';name:string;enabled:boolean;connectionId?:string;email?:string;}
export interface ProfileRegistry {profiles:ConnectionProfile[];defaults:Record<string,string>;}
export interface CloudModel extends CodexListedModel {slug:string;display_name?:string;visibility?:string;}
export interface CodexModel {id:string;model:string;displayName:string;defaultReasoningEffort?:string;}
export interface CodexLimitsAuth {connected:boolean;pending:boolean;email?:string;planType?:string;error?:string;}
export interface QuotaWindow {usedPercent:number;windowDurationMins?:number|null;resetsAt?:number|null;}
export interface QuotaBucket {limitId?:string;limitName?:string;primary?:QuotaWindow;secondary?:QuotaWindow;planType?:string;spendControlReached?:boolean|null;}
export interface QuotaSnapshot {rateLimits?:QuotaBucket;rateLimitsByLimitId?:Record<string,QuotaBucket>;ordinaryUsageAllowed?:boolean|null;}
export const codexRpc = <T = Record<string,unknown>>(method:string,params:unknown = {}) => invoke<T>('codex_rpc',{method,params});
export const useOpenAi = create<{
  profiles:ConnectionProfile[];defaults:Record<string,string>;profileStatuses:Record<string,OpenAiStatus|ClaudeStatus>;catalogs:Record<string,CodexModel[]>;profileErrors:Record<string,string>;chatProfileId?:string;
  codexLimitsAuth:Record<string,CodexLimitsAuth>;quotaErrors:Record<string,string>;
  quotaProfileId?:string;quotaConnectionId?:string;quotasByConnection:Record<string,{value:QuotaSnapshot;at:number;stale?:boolean}>;claudeLimitsByConnection:Record<string,{value:Record<string,unknown>;at:number}>;
  claudeLimits?:Record<string,unknown>;claudeLimitsAt?:number;claude:ClaudeStatus;claudeModels:CodexModel[];claudeChatModel:string;status:OpenAiStatus;models:CloudModel[];codexModels:CodexModel[];codexAccount?:{type:string;email?:string;planType?:string};
  installed:boolean;checked:boolean;quota?:QuotaSnapshot;quotaAt?:number;quotaError?:string;error:string;loading:boolean;chatProvider:'local'|'chatgpt'|'claude';chatModel:string;
}>(()=>({quotaErrors:{},codexLimitsAuth:{},quotasByConnection:{},claudeLimitsByConnection:{},profiles:[],defaults:{},profileStatuses:{},catalogs:{},profileErrors:{},claude:{installed:false,connected:false},claudeModels:[],claudeChatModel:'',status:{connected:false,pending:false},models:[],codexModels:[],installed:false,checked:false,error:'',loading:false,chatProvider:'local',chatModel:''}));
let refreshing:Promise<void>|undefined, initialized=false, accountEpoch=0;
const quotaEpochs=new Map<string,number>();
const quotaReaders=new Map<string,Promise<void>>(),quotaRetries=new Map<string,{failures:number;nextAt:number}>();
export function refreshQuota(force=true,connectionId=useOpenAi.getState().quotaProfileId?cloudSelection(useOpenAi.getState(),'openai',undefined,useOpenAi.getState().quotaProfileId).status.connectionId:useOpenAi.getState().quotaConnectionId??useOpenAi.getState().status.connectionId){
  if(!connectionId)return Promise.resolve();
  if(connectionId!==useOpenAi.getState().quotaConnectionId)useOpenAi.setState({quotaConnectionId:connectionId,quota:undefined,quotaAt:undefined,quotaError:undefined});
  if(!force&&Date.now()<(quotaRetries.get(connectionId)?.nextAt??0))return Promise.resolve();
  const existing=quotaReaders.get(connectionId);if(existing)return existing;
  const epoch=accountEpoch,connectionEpoch=quotaEpochs.get(connectionId)??0;
  const reading=(async()=>{
    try{const quota=await invoke<QuotaSnapshot>('codex_limits',{action:'read',connectionId});if(epoch!==accountEpoch||connectionEpoch!==(quotaEpochs.get(connectionId)??0))return;const at=Date.now();quotaRetries.set(connectionId,{failures:0,nextAt:at+60000});useOpenAi.setState(s=>({quotaErrors:Object.fromEntries(Object.entries(s.quotaErrors).filter(([id])=>id!==connectionId)),quotasByConnection:{...s.quotasByConnection,[connectionId]:{value:quota,at}},...(s.quotaConnectionId===connectionId?{quota,quotaAt:at,quotaError:undefined}:{})}));}
    catch{if(epoch===accountEpoch&&connectionEpoch===(quotaEpochs.get(connectionId)??0)){const failures=(quotaRetries.get(connectionId)?.failures??0)+1;quotaRetries.set(connectionId,{failures,nextAt:Date.now()+Math.min(900000,60000*2**Math.min(failures,4))});useOpenAi.setState(s=>({quotaErrors:{...s.quotaErrors,[connectionId]:'limits-unavailable'},quotasByConnection:s.quotasByConnection[connectionId]?{...s.quotasByConnection,[connectionId]:{...s.quotasByConnection[connectionId],stale:true}}:s.quotasByConnection,...(s.quotaConnectionId===connectionId?{quotaError:'unavailable'}:{})}));}}
  })().finally(()=>{if(quotaReaders.get(connectionId)===reading)quotaReaders.delete(connectionId);});quotaReaders.set(connectionId,reading);return reading;
}
function refreshAccountQuotas(force=false){
  const s=useOpenAi.getState();if(!s.installed)return;
  const ids=s.profiles.filter(p=>p.provider==='openai'&&p.enabled&&s.profileStatuses[p.id]?.connected&&s.codexLimitsAuth[s.profileStatuses[p.id].connectionId??'']?.connected).flatMap(p=>s.profileStatuses[p.id].connectionId?[s.profileStatuses[p.id].connectionId!]:[]);
  // Bound native worker startup when many subscription profiles are configured.
  void (async()=>{for(let i=0;i<ids.length;i+=4)await Promise.allSettled(ids.slice(i,i+4).map(id=>refreshQuota(force,id)));})();
}
let refreshAgain=false;
export function refreshOpenAi(force=false){
  if(!isTauri())return Promise.resolve();if(refreshing){if(force)refreshAgain=true;return refreshing;}
  refreshing=(async()=>{
    useOpenAi.setState({error:''});
    const outcomes=await Promise.allSettled([
      (async()=>{
        const status=await invoke<OpenAiStatus>('openai_status');
        if(status.connectionId!==useOpenAi.getState().status.connectionId){accountEpoch++;useOpenAi.setState({quota:undefined,quotaAt:undefined,models:[],codexModels:[]});}
        useOpenAi.setState({status});
        const available=await invoke<{installed:boolean}>('codex_available');
        useOpenAi.setState({installed:available.installed,checked:true,codexAccount:status.connected&&available.installed?{type:'chatgpt',email:status.email}:undefined});

        if(status.connected&&status.connectionId){const result=await invoke<{models:CloudModel[]}>('openai_models',{connectionId:status.connectionId});
          if(useOpenAi.getState().status.connectionId===status.connectionId){const models=(result.models??[]).filter(m=>m.visibility==='list');useOpenAi.setState({models,codexModels:models.map(m=>({id:m.slug,model:m.slug,displayName:m.display_name??m.slug,defaultReasoningEffort:m.default_reasoning_level}))});void storeCodexReasoning(status.connectionId,models);}
        }else useOpenAi.setState({models:[],codexModels:[],quota:undefined,quotaAt:undefined});
      })(),
      (async()=>{
        const claude=await invoke<ClaudeStatus>('claude_status');if(claude.connectionId!==useOpenAi.getState().claude.connectionId)useOpenAi.setState({claudeLimits:undefined,claudeLimitsAt:undefined,claudeModels:[]});useOpenAi.setState({claude});
        if(claude.connected){const result=await invoke<{models:{value?:string;model?:string;id?:string;displayName?:string;name?:string}[]}>('claude_catalog');
          if(useOpenAi.getState().claude.connectionId===claude.connectionId){const claudeModels=(result.models??[]).flatMap(m=>{const model=m.value??m.model??m.id;return model?[{id:model,model,displayName:m.displayName??m.name??model}]:[];});useOpenAi.setState({claudeModels});if(claude.connectionId)void storeClaudeReasoning(claude.connectionId,claudeModels.map(m=>m.model));}
        }else useOpenAi.setState({claudeModels:[]});
      })(),
    ]);
    const errors=outcomes.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);if(errors.length)useOpenAi.setState({error:errors.join(' · ')});
    await refreshProfiles();
  })().catch(error=>{useOpenAi.setState({error:String(error)});}).finally(()=>{refreshing=undefined;if(refreshAgain){refreshAgain=false;return refreshOpenAi();}});return refreshing;
}
export function initializeOpenAi(){
  if(initialized||!isTauri())return;initialized=true;void refreshOpenAi();
  void listen<{method:string;aplotConnectionId?:string;params?:Record<string,unknown>}>('codex://event',({payload})=>{
    if(['account/login/completed','account/updated'].includes(payload.method)){accountEpoch++;quotaRetries.clear();useOpenAi.setState({quota:undefined,quotaAt:undefined});void refreshOpenAi();}
    if(payload.method==='account/rateLimits/updated'){if(payload.aplotConnectionId)void refreshQuota(true,payload.aplotConnectionId);else refreshAccountQuotas(true);}
  });
  void listen<{connectionId:string;reason:string}>('codex-limits://changed',({payload})=>{
    const id=payload.connectionId;
    if(payload.reason==='limits')void refreshQuota(false,id);
    else if(payload.reason==='closed'){
      quotaEpochs.set(id,(quotaEpochs.get(id)??0)+1);
      useOpenAi.setState(s=>({codexLimitsAuth:{...s.codexLimitsAuth,[id]:{connected:false,pending:false,error:'closed'}},quotasByConnection:Object.fromEntries(Object.entries(s.quotasByConnection).filter(([key])=>key!==id))}));
    }else{quotaRetries.delete(id);void refreshCodexLimitsStatus(id);}
  });
  void listen('openai://changed',()=>{accountEpoch++;void refreshOpenAi(true);});
  void listen('connections://changed',()=>void refreshOpenAi(true));
  void listen('claude://changed',()=>void refreshOpenAi(true));
  window.addEventListener('focus',()=>refreshAccountQuotas());
  setInterval(()=>{if(useOpenAi.getState().status.pending||useOpenAi.getState().claude.pending||Object.values(useOpenAi.getState().profileStatuses).some(s=>s.pending))void refreshOpenAi();},3000);
  setInterval(()=>{for(const [id,auth] of Object.entries(useOpenAi.getState().codexLimitsAuth))if(auth.pending)void refreshCodexLimitsStatus(id);},3000);
  setInterval(()=>{if(!document.hidden)refreshAccountQuotas();if(useOpenAi.getState().status.pending)void refreshOpenAi();},60000);
}
export function remaining(window:QuotaWindow){return Math.min(100,Math.max(0,100-window.usedPercent));}

async function refreshProfiles(){
  const registry=await invoke<ProfileRegistry>('connection_profiles');if(!Array.isArray(registry?.profiles))return;
  const current=useOpenAi.getState(),statuses:Record<string,OpenAiStatus|ClaudeStatus>={},catalogs:Record<string,CodexModel[]>={},errors:Record<string,string>={};
  // Bound process fan-out: Claude auth status runs the official executable.
  for(let index=0;index<registry.profiles.length;index+=4)await Promise.allSettled(registry.profiles.slice(index,index+4).map(async p=>{
    if(!p.enabled){statuses[p.id]={connected:false,pending:false};return;}
    try{
      const primary=registry.defaults[p.provider]===p.id;
      const status=primary?(p.provider==='openai'?current.status:current.claude):await invoke<OpenAiStatus|ClaudeStatus>(p.provider==='openai'?'openai_status':'claude_status',{profileId:p.id});statuses[p.id]=status;
      if(!status.connected||!status.connectionId)return;
      if(primary){catalogs[status.connectionId]=p.provider==='openai'?current.codexModels:current.claudeModels;return;}
      if(current.catalogs[status.connectionId]){catalogs[status.connectionId]=current.catalogs[status.connectionId];return;}
      if(p.provider==='openai'){const result=await invoke<{models:CloudModel[]}>('openai_models',{connectionId:status.connectionId});const listed=(result.models??[]).filter(m=>m.visibility==='list');catalogs[status.connectionId]=listed.map(m=>({id:m.slug,model:m.slug,displayName:m.display_name??m.slug,defaultReasoningEffort:m.default_reasoning_level}));void storeCodexReasoning(status.connectionId,listed);}
      else{const result=await invoke<{models:{value?:string;model?:string;id?:string;displayName?:string;name?:string}[]}>('claude_catalog',{connectionId:status.connectionId});const listed=(result.models??[]).flatMap(m=>{const id=m.value??m.model??m.id;return id?[{id,model:id,displayName:m.displayName??m.name??id}]:[];});catalogs[status.connectionId]=listed;void storeClaudeReasoning(status.connectionId,listed.map(m=>m.model));}
    }catch(e){errors[p.id]=String(e);}
  }));
  const codexLimitsAuth:Record<string,CodexLimitsAuth>={};
  for(const p of registry.profiles){
    const id=statuses[p.id]?.connectionId;
    if(p.provider!=='openai'||!p.enabled||!statuses[p.id]?.connected||!id)continue;
    try{codexLimitsAuth[id]=await invoke<CodexLimitsAuth>('codex_limits',{action:'status',connectionId:id});}
    catch(e){codexLimitsAuth[id]={connected:false,pending:false,error:String(e)};}
  }
  const latest=await invoke<ProfileRegistry>('connection_profiles');
  const quotaConnectionId=useOpenAi.getState().quotaConnectionId;const validQuota=!quotaConnectionId||(latest.profiles??[]).some(p=>p.enabled&&p.connectionId===quotaConnectionId&&statuses[p.id]?.connected);
  const connectedIds=new Set((latest.profiles??[]).filter(p=>p.enabled&&statuses[p.id]?.connected).flatMap(p=>statuses[p.id].connectionId?[statuses[p.id].connectionId!]:[]));
  const quotasByConnection=Object.fromEntries(Object.entries(useOpenAi.getState().quotasByConnection).filter(([id])=>connectedIds.has(id)&&codexLimitsAuth[id]?.connected));
  const claudeLimitsByConnection=Object.fromEntries(Object.entries(useOpenAi.getState().claudeLimitsByConnection).filter(([id])=>connectedIds.has(id)));
  useOpenAi.setState({codexLimitsAuth,quotasByConnection,claudeLimitsByConnection,profiles:latest.profiles??registry.profiles,defaults:latest.defaults??registry.defaults,profileStatuses:statuses,catalogs,profileErrors:errors,...(!validQuota?{quotaConnectionId:undefined,quota:undefined,quotaAt:undefined,quotaError:undefined}:{})});
  refreshAccountQuotas();
}
export function cloudSelection(s:ReturnType<typeof useOpenAi.getState>,provider:'openai'|'claude',connectionId?:string,profileId?:string){
  const profile=connectionId?s.profiles.find(p=>p.provider===provider&&p.connectionId===connectionId):s.profiles.find(p=>p.provider===provider&&p.id===(profileId||s.defaults[provider]));
  const legacy=provider==='openai'?s.status:s.claude;
  const status:OpenAiStatus|ClaudeStatus=profile?(profile.enabled?s.profileStatuses[profile.id]??{connected:false,pending:false}:{connected:false,pending:false}):s.profiles.length||profileId||connectionId&&connectionId!==legacy.connectionId?{connected:false,pending:false}:legacy;
  return {profile,status,models:status.connectionId?s.catalogs[status.connectionId]??(status.connectionId===legacy.connectionId?(provider==='openai'?s.codexModels:s.claudeModels):[]):[],installed:provider==='openai'?s.installed:s.claude.installed};
}
export function connectionOptions(s:ReturnType<typeof useOpenAi.getState>,provider:'openai'|'claude'){
  return s.profiles.filter(p=>p.provider===provider&&p.enabled).map(p=>({value:p.id,label:p.name.trim()||s.profileStatuses[p.id]?.email||p.email|| (provider==='openai'?'Codex':'Claude')}));
}
export async function updateConnectionProfile(action:string,options:{id?:string;provider?:string;name?:string}={}){
  const registry=await invoke<ProfileRegistry>('connection_profile_update',{action,...options});useOpenAi.setState({profiles:registry.profiles,defaults:registry.defaults});await refreshOpenAi(true);return registry;
}

export async function codexLimitsAction(action:'login'|'cancel'|'logout',connectionId:string){
  quotaEpochs.set(connectionId,(quotaEpochs.get(connectionId)??0)+1);
  quotaReaders.delete(connectionId);
  const result=await invoke<{authUrl?:string}>('codex_limits',{action,connectionId});
  quotaRetries.delete(connectionId);
  useOpenAi.setState(s=>({quotaErrors:Object.fromEntries(Object.entries(s.quotaErrors).filter(([id])=>id!==connectionId)),codexLimitsAuth:{...s.codexLimitsAuth,[connectionId]:{connected:false,pending:action==='login'}},quotasByConnection:Object.fromEntries(Object.entries(s.quotasByConnection).filter(([id])=>id!==connectionId)),...(s.quotaConnectionId===connectionId?{quota:undefined,quotaAt:undefined}: {})}));
  return result;
}

export async function refreshCodexLimitsStatus(connectionId:string){
  const epoch=quotaEpochs.get(connectionId)??0;
  let auth:CodexLimitsAuth;
  try{auth=await invoke<CodexLimitsAuth>('codex_limits',{action:'status',connectionId});}
  catch(e){auth={connected:false,pending:false,error:String(e)};}
  if(epoch!==(quotaEpochs.get(connectionId)??0))return;
  const s=useOpenAi.getState();
  if(!s.profiles.some(p=>p.provider==='openai'&&p.enabled&&s.profileStatuses[p.id]?.connected&&s.profileStatuses[p.id].connectionId===connectionId))return;
  useOpenAi.setState(current=>({codexLimitsAuth:{...current.codexLimitsAuth,[connectionId]:auth},...(!auth.connected?{quotasByConnection:Object.fromEntries(Object.entries(current.quotasByConnection).filter(([id])=>id!==connectionId))}:{})}));
  if(auth.connected)await refreshQuota(false,connectionId);
}
