// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null)}));
vi.mock('../src/services/tauri',async importOriginal=>({...await importOriginal<typeof import('../src/services/tauri')>(),isTauri:()=>true,saveProfile:vi.fn(async profile=>profile),scanModels:vi.fn(async()=>[])}));
import {saveProfile,scanModels} from '../src/services/tauri';
import {invoke} from '@tauri-apps/api/core';
import {beginModelRecipe,startAcquisitionMonitor,useAcquisitionStore} from '../src/features/modelDownloads/acquisition';
import {useModelDownloadStore} from '../src/features/modelDownloads/store';
import {useControlStore} from '../src/store/control';
import type {DownloadTask} from '../src/features/modelDownloads/types';
const task:DownloadTask={id:'download-1',sequence:1,state:'completed',plan:{planId:'download-1',source:'Qwen/Qwen3-4B-GGUF',repoId:'Qwen/Qwen3-4B-GGUF',revision:'a'.repeat(40),files:[],destination:'C:/Models',finalPath:'C:/Models/Qwen',totalBytes:10,availableBytes:100,warnings:[]},downloadedBytes:10,totalBytes:10,speedBytesPerSecond:0,createdAt:'2026-10-23',updatedAt:'2026-10-23',installedPath:'C:/Models/Qwen'};
beforeEach(()=>{
 vi.clearAllMocks();localStorage.clear();
 localStorage.setItem('aplot-model-recipes-v1',JSON.stringify({'download-1':{recipeId:'qwen3-4b'}}));
 vi.mocked(scanModels).mockResolvedValue([{id:'model',path:'C:/Models/Qwen/Qwen3-4B-Q4_K_M.gguf',fileName:'Qwen3-4B-Q4_K_M.gguf',sizeBytes:10,modifiedAt:'2026-10-23',architecture:'qwen3',quantization:'Q4_K_M'}]);
 useAcquisitionStore.setState({error:'',profileErrors:{},readyProfiles:[],busy:false,preparation:undefined});
 useModelDownloadStore.setState({tasks:[task]});
 useControlStore.setState({initialized:true,selectedRunId:'another-server',profiles:[],updateSettings:vi.fn(async()=>{}),rescanModels:vi.fn(async()=>{}),libraryModels:[{id:'model',name:'Qwen',path:'C:/Models/Qwen/Qwen3-4B-Q4_K_M.gguf',sizeBytes:10,architecture:'qwen3',quantization:'Q4_K_M',sources:{llama_cpp:{id:'model',path:'C:/Models/Qwen/Qwen3-4B-Q4_K_M.gguf',fileName:'Qwen3-4B-Q4_K_M.gguf',sizeBytes:10,architecture:'qwen3',quantization:'Q4_K_M'}}}]});
});
it('prepares Strata in the selected folder and original engine root without a memory admission gate',async()=>{
 const status={id:'strata-transfer',recipeId:'strata-coder',state:'installing',lines:[],destination:'D:/Models',rootPath:'D:/Original Strata'};
 vi.mocked(invoke).mockResolvedValueOnce(status);
 await beginModelRecipe('strata-coder','  D:/Models  ','D:/Original Strata');
 expect(invoke).toHaveBeenCalledWith('start_strata_model_preparation',expect.objectContaining({recipeId:'strata-coder',destination:'D:/Models',rootValue:'D:/Original Strata'}));
 expect(useAcquisitionStore.getState().preparation).toEqual(status);
 expect(useAcquisitionStore.getState().busy).toBe(false);
});
it('creates a verified recipe profile without changing the current server or editor',async()=>{
 const config=useControlStore.getState().config;
 const stop=startAcquisitionMonitor();
 try{await vi.waitFor(()=>expect(saveProfile).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(useAcquisitionStore.getState().readyProfiles).toContain('download-1'));
 expect(vi.mocked(saveProfile).mock.calls[0][0].config).toMatchObject({engine:'llama_cpp',ctxSize:8192,parallel:1,modelArchitecture:'qwen3',device:'',engineOptions:{llama_cpp:{serverMode:'single'}}});
 expect(useControlStore.getState().runs.some(run=>run.info.runId==='profile:download-1'&&run.info.state==='stopped')).toBe(true);
 expect(useControlStore.getState().config).toBe(config);expect(useControlStore.getState().selectedRunId).toBe('another-server');
 }finally{stop();}
});
it('waits for startup restoration before creating a profile',async()=>{
 useControlStore.setState({initialized:false});const stop=startAcquisitionMonitor();
 try{expect(saveProfile).not.toHaveBeenCalled();useControlStore.setState({initialized:true});await vi.waitFor(()=>expect(saveProfile).toHaveBeenCalledOnce());}finally{stop();}
});
it('does not advertise readiness when the actual downloaded architecture differs',async()=>{
 vi.mocked(scanModels).mockResolvedValue([{id:'model',path:'C:/Models/Qwen/model.gguf',fileName:'model.gguf',sizeBytes:10,modifiedAt:'2026-10-23',architecture:'qwen4exp',quantization:'Q4_K_M'}]);const stop=startAcquisitionMonitor();
 try{await vi.waitFor(()=>expect(useAcquisitionStore.getState().profileErrors['download-1']).toContain('architecture'));expect(saveProfile).not.toHaveBeenCalled();expect(useAcquisitionStore.getState().readyProfiles).toEqual([]);}finally{stop();}
});

it('uses the first shard even when scanning returns later shards first',async()=>{
 const model={id:'shard',path:'C:/Models/Qwen/Qwen3-Q4_K_M-00002-of-00002.gguf',fileName:'Qwen3-Q4_K_M-00002-of-00002.gguf',sizeBytes:10,modifiedAt:'2026-10-23',architecture:'qwen3',quantization:'Q4_K_M'};
 vi.mocked(scanModels).mockResolvedValue([model,{...model,id:'first',path:model.path.replace('00002-of-','00001-of-'),fileName:model.fileName.replace('00002-of-','00001-of-')}]);
 const stop=startAcquisitionMonitor();try{await vi.waitFor(()=>expect(saveProfile).toHaveBeenCalledOnce());expect(vi.mocked(saveProfile).mock.calls[0][0].config.modelPath).toContain('00001-of-00002');}finally{stop();}
});
