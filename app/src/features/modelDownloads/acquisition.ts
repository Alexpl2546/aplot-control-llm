import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauri, saveProfile, discoverStrataModels, scanModels } from '../../services/tauri';
import { useControlStore } from '../../store/control';
import { DEFAULT_CONFIG } from '../../types/config';
import { mergeModelDirectories } from '../../lib/modelDirectories';
import { isPrimaryModelFile, modelLaunchMetadata } from '../../lib/models';
import { pathKey } from '../../lib/engineModels';
import { resolveModelDownload, modelDownloadDestination, prepareModelDownload, startModelDownload } from './service';
import { useModelDownloadStore } from './store';
import type { DownloadTask } from './types';
import { findModelRecipe, loadModelRecipes, type ModelRecipe, type RecipeHardware } from './recipes';

export interface PreparationStatus {id:string;recipeId:string;state:string;lines:string[];configPath?:string;error?:string;recipe?:ModelRecipe;destination?:string;rootPath?:string;}
interface Receipt {recipeId:string;profileId?:string;error?:string;recipe?:ModelRecipe;}
const STORAGE='aplot-model-recipes-v1';
function receipts():Record<string,Receipt>{try{return JSON.parse(localStorage.getItem(STORAGE)??'{}');}catch{return {};}}
function remember(id:string,receipt:Receipt){localStorage.setItem(STORAGE,JSON.stringify({...receipts(),[id]:receipt}));}
export const useAcquisitionStore=create<{preparation?:PreparationStatus;error:string;profileErrors:Record<string,string>;readyProfiles:string[];busy:boolean}>(()=>({error:'',profileErrors:Object.fromEntries(Object.entries(receipts()).filter(([,receipt])=>receipt.error).map(([id,receipt])=>[id,receipt.error!])),readyProfiles:Object.entries(receipts()).filter(([,receipt])=>receipt.profileId).map(([id])=>id),busy:false}));
const preparing=new Set<string>();
function profileReady(id:string,recipeId:string,profileId:string){
  remember(id,{recipeId,profileId});
  useAcquisitionStore.setState(current=>({profileErrors:{...current.profileErrors,[id]:''},readyProfiles:[...new Set([...current.readyProfiles,id])]}));
}

export function currentRecipeHardware():RecipeHardware {
  const runtime=useControlStore.getState().runtime;
  return {ramGiB:runtime.memory.totalMiB/1024,freeRamGiB:Math.max(0,runtime.memory.totalMiB-runtime.memory.usedMiB)/1024,vramGiB:runtime.gpu.memoryTotalMiB/1024};
}
export async function readRecipeHardware():Promise<RecipeHardware> {
  if(!isTauri())return currentRecipeHardware();
  const snapshot=await invoke<{memoryTotalMiB:number;memoryUsedMiB:number;gpu?:{memoryTotalMiB:number}}>('hardware_snapshot');
  return {ramGiB:snapshot.memoryTotalMiB/1024,freeRamGiB:Math.max(0,snapshot.memoryTotalMiB-snapshot.memoryUsedMiB)/1024,vramGiB:(snapshot.gpu?.memoryTotalMiB??0)/1024};
}

export async function beginModelRecipe(recipeId:string, selectedDestination?:string, selectedRoot?:string) {
  if(useAcquisitionStore.getState().busy)return;
  useAcquisitionStore.setState({busy:true,error:''});
  try {
    const rootValue=selectedRoot??useControlStore.getState().settings.strataRootPath;
    if(!findModelRecipe(recipeId)&&isTauri())await loadModelRecipes(rootValue);
    const recipe=findModelRecipe(recipeId);
    if(!recipe)throw new Error('Unknown model recipe');
    const destination=selectedDestination?.trim()||await modelDownloadDestination(recipe.engine);
    if(recipe.engine==='strata') {
      if(!isTauri())throw new Error('desktop-only');
      const state=useControlStore.getState();
      const preparation=await invoke<PreparationStatus>('start_strata_model_preparation',{recipeId,rootValue,destination,existingDirectories:[...state.settings.modelDirectories,destination]});
      remember(preparation.id,{recipeId,recipe});
      useAcquisitionStore.setState({preparation});
      return;
    }
    const resolved=await resolveModelDownload(recipe.source!);
    const variant=resolved.variants.find(item=>item.complete&&/(?:^|[^A-Z0-9])Q4_K_M(?:$|[^A-Z0-9])/i.test(item.label));
    // Browser fixtures exercise the workflow without claiming a real download.
    const selected=variant??(!isTauri()?resolved.variants.find(item=>item.complete):undefined);
    if(!selected)throw new Error('The publisher no longer provides the supported Q4_K_M recipe');
    const plan=await prepareModelDownload({source:resolved.source,revision:resolved.revision,files:selected.files},destination);
    remember(plan.planId,{recipeId,recipe});
    const task=await startModelDownload(plan.planId,plan);
    remember(task.id,{recipeId,recipe});
    useModelDownloadStore.getState().applyTask(task);
  } finally {useAcquisitionStore.setState({busy:false});}
}

async function finishProfile(id:string,recipeId:string,task?:DownloadTask,configPath?:string) {
  const receipt=receipts()[id];
  if(receipt?.profileId||receipt?.error||preparing.has(id)||!isTauri())return;
  const recipe=receipt?.recipe??findModelRecipe(recipeId);
  if(!recipe)return;
  preparing.add(id);
  try {
    const state=useControlStore.getState();
    const previous=state.profiles.find(profile=>profile.id===id);
    if(previous){await useControlStore.getState().saveServer(previous.id);profileReady(id,recipeId,id);return;}
    let config={...DEFAULT_CONFIG,profileId:id,profileName:recipe.name,engine:recipe.engine,ctxSize:8192,parallel:1};
    if(task){
      const root=task.installedPath||task.plan.finalPath;
      await state.updateSettings({modelDirectories:mergeModelDirectories(state.settings.modelDirectories,root)});
      const models=await scanModels([root]);
      const model=models.find(item=>isPrimaryModelFile(item)&&item.architecture==='qwen3'&&item.quantization?.toUpperCase()==='Q4_K_M');
      if(!model)throw new Error('Downloaded model did not pass the expected llama.cpp architecture and quantization checks');
      config={...config,binaryPath:state.settings.binaryPath,device:'',engineOptions:{llama_cpp:{binaryPath:state.settings.binaryPath,serverMode:'single'}},modelPath:model.path,modelBytes:model.sizeBytes,modelAlias:recipe.name,...modelLaunchMetadata(model)};
    }else if(configPath){
      const root=configPath.replace(/[\\/][^\\/]+$/,'');
      const models=await discoverStrataModels(root);
      const model=models.find(item=>pathKey(item.configPath)===pathKey(configPath));
      if(!model)throw new Error('Strata configuration validation failed');
      config={...config,modelPath:model.modelPath??model.configPath,modelAlias:model.modelName,engineModel:model.modelName,ctxSize:model.contextLength,engineOptions:{strata:{strataRootPath:root,strataConfigPath:model.configPath,strataHost:'127.0.0.1',strataPort:8080,strataApiKey:''}}};
    }else return;
    const existing=useControlStore.getState().profiles.find(profile=>profile.config.engine===recipe.engine&&(configPath?pathKey(String(profile.config.engineOptions?.strata?.strataConfigPath??''))===pathKey(configPath):pathKey(profile.config.modelPath)===pathKey(config.modelPath)));
    if(existing){await useControlStore.getState().saveServer(existing.id);profileReady(id,recipeId,existing.id);return;}
    const now=new Date().toISOString();
    const saved=await saveProfile({id,name:recipe.name,config,createdAt:now,updatedAt:now,lastKnownGood:false});
    useControlStore.setState(current=>({profiles:[...current.profiles.filter(profile=>profile.id!==saved.id),saved]}));
    await useControlStore.getState().saveServer(saved.id);
    profileReady(id,recipeId,saved.id);
    void useControlStore.getState().rescanModels();
  }catch(error){
    remember(id,{recipeId,recipe,error:String(error)});
    useAcquisitionStore.setState(current=>({profileErrors:{...current.profileErrors,[id]:String(error)}}));
  }finally{preparing.delete(id);}
}

export function startAcquisitionMonitor(){
  let disposed=false,polling=false;
  const completed=(tasks:DownloadTask[])=>{if(!useControlStore.getState().initialized)return;const saved=receipts();for(const task of tasks){const receipt=saved[task.id];if(task.state==='completed'&&receipt&&!receipt.profileId&&!receipt.error)void finishProfile(task.id,receipt.recipeId,task);}};
  const stop=useModelDownloadStore.subscribe((state,previous)=>{if(state.tasks!==previous.tasks)completed(state.tasks);});
  const stopReady=useControlStore.subscribe((state,previous)=>{if(state.initialized&&!previous.initialized)completed(useModelDownloadStore.getState().tasks);});
  completed(useModelDownloadStore.getState().tasks);
  const poll=async()=>{
    if(polling||!isTauri())return;polling=true;
    try{const status=await invoke<PreparationStatus|null>('model_preparation_status');
      if(!disposed&&status){
        if(status.recipe)remember(status.id,{...receipts()[status.id],recipeId:status.recipeId,recipe:status.recipe});
        useAcquisitionStore.setState({preparation:status});if(status.state==='completed'&&useControlStore.getState().initialized)void finishProfile(status.id,status.recipeId,undefined,status.configPath);
      }
    }catch(error){if(!disposed)useAcquisitionStore.setState({error:String(error)});}finally{polling=false;}
  };
  void poll();const timer=setInterval(()=>void poll(),2000);
  return()=>{disposed=true;stop();stopReady();clearInterval(timer);};
}
export async function cancelPreparation(){await invoke('cancel_model_preparation');}
export function retryAcquisitionProfiles(){
  const saved=receipts();for(const [id,receipt]of Object.entries(saved))if(receipt.error)remember(id,{recipeId:receipt.recipeId,recipe:receipt.recipe});
  for(const task of useModelDownloadStore.getState().tasks)if(task.state==='completed'&&saved[task.id])void finishProfile(task.id,saved[task.id].recipeId,task);
  const status=useAcquisitionStore.getState().preparation;
  if(status?.state==='completed')void finishProfile(status.id,status.recipeId,undefined,status.configPath);
}
