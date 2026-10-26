import { Check, FolderOpen, Pencil, Settings2, UserRoundMinus, UserRoundPlus, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentPreset, AgentProject, AgentTask } from './workspaceModel';

export interface AgentMenuTarget { preset:AgentPreset; x:number; y:number; }

export function AgentActionsMenu({target,preset:currentPreset,projects,task,recruited,onClose,onConfigure,onProject,onRecruit,onDelete}:{
  target?:AgentMenuTarget;
  preset?:AgentPreset;
  projects:AgentProject[];
  task?:AgentTask;
  recruited:boolean;
  onClose:()=>void;
  onConfigure:(id:string)=>void;
  onProject:(presetId:string,projectId:string,assigned:boolean)=>void;
  onRecruit:(taskId:string,presetId:string,recruited:boolean)=>void;
  onDelete:(preset:AgentPreset)=>void;
}) {
  const {t}=useTranslation(),ref=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),[position,setPosition]=useState({left:0,top:0});
  useLayoutEffect(()=>{
    if(!target)return;
    opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const bounds=ref.current?.getBoundingClientRect();
    setPosition({left:Math.max(8,Math.min(target.x,window.innerWidth-(bounds?.width??280)-8)),top:Math.max(8,Math.min(target.y,window.innerHeight-(bounds?.height??300)-8))});
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  },[target]);
  useEffect(()=>{
    if(!target)return;
    const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))onClose();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onClose();}else if(event.key==='Tab')onClose();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);if(opener.current?.isConnected&&!document.querySelector('dialog[open]'))opener.current.focus();};
  },[target,onClose]);
  if(!target)return null;
  const preset=currentPreset??target.preset;
  const act=(action:()=>void)=>{onClose();action();};
  const primary=task?.presetId===preset.id;
  return createPortal(<div ref={ref} className="deskServerMenu awAgentMenu" role="menu" aria-label={t('presets.agentMenu')} style={position} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
    const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),current=items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }}><header>{preset.name}</header>
    <button role="menuitem" type="button" onClick={()=>act(()=>onConfigure(preset.id))}><Settings2 size={15}/>{t('presets.configure')}</button>
    <button role="menuitem" type="button" onClick={()=>act(()=>onConfigure(preset.id))}><Pencil size={15}/>{t('profiles.rename')}</button>
    <div className="awAgentMenuSection"><span>{t('presets.projectAssignments')}</span>{projects.length?projects.map(project=>{
      const checked=preset.projectIds?.includes(project.id)??false;
      return <button role="menuitemcheckbox" aria-checked={checked} type="button" key={project.id} onClick={()=>onProject(preset.id,project.id,!checked)}>{checked?<Check size={15}/>:<FolderOpen size={15}/>}<span>{project.name}</span></button>;
    }):<p>{t('presets.noProjects')}</p>}</div>
    <div className="awAgentMenuSection"><span>{t('presets.taskRecruitment')}</span>{task?<button role="menuitem" type="button" disabled={primary} onClick={()=>act(()=>onRecruit(task.id,preset.id,!recruited))}>{recruited?<UserRoundMinus size={15}/>:<UserRoundPlus size={15}/>}<span>{primary?t('presets.alreadyPrimary'):recruited?t('presets.releaseFromTask'):t('presets.recruitToTask',{task:task.title})}</span></button>:<p>{t('presets.noSelectedTask')}</p>}</div>
    <button role="menuitem" type="button" className="awDangerAction" onClick={()=>act(()=>onDelete(preset))}><Trash2 size={15}/>{t('profiles.action.delete')}</button>
  </div>,document.body);
}
