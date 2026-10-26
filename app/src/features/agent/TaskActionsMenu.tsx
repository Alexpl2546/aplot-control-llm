import { Archive, ArchiveRestore, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentTask } from './workspaceModel';
import { editTask } from './workspace';

export interface TaskMenuTarget { task:AgentTask; x:number; y:number; }
export function TaskActionsMenu({target,onClose,onRename,onTrash,onRestore}:{target?:TaskMenuTarget;onClose:()=>void;onRename:(id:string)=>void;onTrash:(id:string)=>void;onRestore:(id:string)=>void}) {
  const {t}=useTranslation(),ref=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),[position,setPosition]=useState({left:0,top:0});
  useLayoutEffect(()=>{
    if(!target)return;
    opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const bounds=ref.current?.getBoundingClientRect();
    setPosition({left:Math.max(8,Math.min(target.x,window.innerWidth-(bounds?.width??260)-8)),top:Math.max(8,Math.min(target.y,window.innerHeight-(bounds?.height??190)-8))});
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  },[target]);
  useEffect(()=>{
    if(!target)return;
    const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))onClose();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose();}else if(e.key==='Tab')onClose();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);if(opener.current?.isConnected&&!document.querySelector('dialog[open]'))opener.current.focus();};
  },[target,onClose]);
  if(!target)return null;
  const {task}=target;
  const act=(fn:()=>void)=>{onClose();fn();};
  return createPortal(<div ref={ref} className="deskServerMenu awTaskMenu" role="menu" aria-label={t('aw.taskMenu')} style={position} onContextMenu={e=>e.preventDefault()} onKeyDown={e=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();
    const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button')??[]),current=items.indexOf(document.activeElement as HTMLButtonElement);
    items[e.key==='Home'?0:e.key==='End'?items.length-1:(current+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }}><header>{task.title}</header>{task.deletedAt?<button role="menuitem" type="button" onClick={()=>act(()=>onRestore(task.id))}><RotateCcw size={15}/>{t('aw.restoreTask')}</button>:<>
    <button role="menuitem" type="button" onClick={()=>act(()=>onRename(task.id))}><Pencil size={15}/>{t('aw.rename')}</button>
    <button role="menuitem" type="button" onClick={()=>act(()=>editTask(task.id,{archived:!task.archived}))}>{task.archived?<ArchiveRestore size={15}/>:<Archive size={15}/>} {t(task.archived?'aw.unarchiveTask':'aw.archiveTask')}</button>
    <button role="menuitem" type="button" className="awDangerAction" onClick={()=>act(()=>onTrash(task.id))}><Trash2 size={15}/>{t('aw.trashTask')}</button>
  </>}</div>,document.body);
}
