import { Code, ExternalLink, FolderOpen, MoreHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFile } from './workspaceModel';
import { projectFileActions } from './fileActions';

export interface FileMenuTarget {file:WorkspaceFile;x:number;y:number;}
export function FileActionsMenu({target,onClose,onOpen,onRead,onReveal}:{target?:FileMenuTarget;onClose:()=>void;onOpen:(path:string)=>void;onRead:(path:string)=>void;onReveal:(path:string)=>void}) {
  const {t}=useTranslation(),ref=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),[position,setPosition]=useState({left:0,top:0});
  useLayoutEffect(()=>{if(!target)return;opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;const bounds=ref.current?.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(target.x,window.innerWidth-(bounds?.width??260)-8)),top:Math.max(8,Math.min(target.y,window.innerHeight-(bounds?.height??190)-8))});ref.current?.querySelector<HTMLButtonElement>('button')?.focus();},[target]);
  useEffect(()=>{if(!target)return;const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))onClose();};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}else if(event.key==='Tab')onClose();};document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);if(opener.current?.isConnected&&!document.querySelector('dialog[open]'))opener.current.focus();};},[target,onClose]);
  if(!target)return null;
  const {file}=target,policy=projectFileActions(file.path),act=(fn:()=>void)=>{onClose();fn();};
  return createPortal(<div ref={ref} className="deskServerMenu" role="menu" aria-label={t('aw.file.menu')} style={position} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')),current=items.indexOf(document.activeElement as HTMLButtonElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}}><header>{file.name}</header>
    {!file.directory&&policy.mode!=='reveal'&&<button type="button" role="menuitem" onClick={()=>act(()=>onOpen(file.path))}><ExternalLink size={16}/>{t(policy.browser?'aw.file.browser':policy.mode==='editor'?'aw.file.editor':'aw.file.defaultApp')}</button>}
    <button type="button" role="menuitem" onClick={()=>act(()=>onReveal(file.path))}><FolderOpen size={16}/>{t('aw.file.reveal')}</button>
    {!file.directory&&policy.canPreview&&<button type="button" role="menuitem" onClick={()=>act(()=>onRead(file.path))}><Code size={16}/>{t('aw.file.source')}</button>}
  </div>,document.body);
}

export function FileMenuButton({name,onClick}:{name:string;onClick:(event:React.MouseEvent<HTMLButtonElement>)=>void}) {
  const {t}=useTranslation();
  return <button type="button" className="kIconBtn awFileMenuTrigger" title={t('aw.file.menu')} aria-label={t('aw.file.menuFor',{name})} aria-haspopup="menu" onClick={onClick}><MoreHorizontal size={16}/></button>;
}
