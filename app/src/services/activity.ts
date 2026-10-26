import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import type { ActivityEvent } from '../features/activity/model';
const key='aplot-activity-preview-v1';
export async function loadActivity():Promise<unknown[]> {return isTauri()?invoke('activity_list'):JSON.parse(localStorage.getItem(key)??'[]');}
export async function saveActivity(event:ActivityEvent):Promise<void> {if(isTauri())await invoke('activity_record',{event});else{const rows=await loadActivity();localStorage.setItem(key,JSON.stringify([event,...rows].slice(0,500)));}}
