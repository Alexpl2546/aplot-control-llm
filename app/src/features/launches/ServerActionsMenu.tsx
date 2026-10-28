import { stopRunWithUndo } from './stopWithUndo';
import { Copy, FileText, MessageSquare, Play, RefreshCw, RotateCw, Settings2, Square, Pin, PinOff, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import { RestartDialog } from '../../components/config/RestartDialog';
import { useLaunchAction } from './useLaunchAction';
import { isActive, isTransition, isWorking } from './presentation';
import { useActivityStore } from '../activity/store';

export interface ServerMenuTarget {runId:string;x:number;y:number;}
export function ServerActionsMenu({target,onClose}:{target?:ServerMenuTarget;onClose:()=>void}) {
  const {t}=useTranslation(),state=useControlStore(),run=state.runs.find(r=>r.info.runId===target?.runId);
  const {requestLaunch,pendingLaunch,confirming,confirmLaunch,cancelLaunch}=useLaunchAction();
  const ref=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),[position,setPosition]=useState({left:0,top:0});
  useLayoutEffect(()=>{if(!target)return;opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;const bounds=ref.current?.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(target.x,window.innerWidth-(bounds?.width??260)-8)),top:Math.max(8,Math.min(target.y,window.innerHeight-(bounds?.height??340)-8))});ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();},[target]);
  useEffect(()=>{if(!target)return;const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))onClose();};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose();}else if(e.key==='Tab')onClose();};document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);if(opener.current?.isConnected)opener.current.focus();};},[target,onClose]);
  const select=()=>{if(run)state.selectRun(run.info.runId);};
  const act=(fn:()=>void|Promise<void>)=>{onClose();void Promise.resolve().then(fn).catch(e=>state.notify('error',String(e)));};
  const busy=!run||!!state.runBusyById[run.info.runId]||isTransition(run.info.state)||state.optimizerRunning;
  const pinned=!!run&&(state.settings.pinnedServerIds??[]).includes(run.info.runId);
  const actions=run?[
    {key:'actions.start',icon:Play,disabled:busy||isActive(run.info.state),fn:()=>{select();return requestLaunch('start',run.info.runId);}},
    {key:'actions.stop',icon:Square,disabled:busy||!isActive(run.info.state)||!run.info.managed,fn:()=>stopRunWithUndo(run.info.runId)},
    {key:'actions.restart',icon:RotateCw,disabled:busy||!isWorking(run.info.state)||!run.info.managed,fn:()=>{select();return requestLaunch('restart',run.info.runId);}},
    {key:'desk.server.configure',icon:Settings2,fn:()=>{select();state.setView('configuration');}},
    {key:'chat.open',icon:MessageSquare,disabled:!isWorking(run.info.state),fn:()=>{select();state.setView('chat');}},
    {key:'desk.logs.technical',icon:FileText,fn:()=>{select();useActivityStore.getState().setMode('technical');state.setView('logs');}},
    {key:'k.top.copyEndpoint',icon:Copy,fn:()=>navigator.clipboard.writeText(run.info.endpoint.replace(/\/+$/,'').replace(/\/v1$/,'')+'/v1').then(()=>state.notify('success',t('k.top.copied')))},
    {key:'desk.server.refresh',icon:RefreshCw,fn:()=>state.refreshManagedRuns()},
    {key:pinned?'desk.server.unpin':'desk.server.pin',icon:pinned?PinOff:Pin,disabled:busy||!state.profiles.some(p=>`profile:${p.id}`===run.info.runId),fn:()=>state.pinRun(run.info.runId,!pinned)},
    {key:'desk.server.remove',icon:Trash2,disabled:busy||isActive(run.info.state),fn:()=>state.removeRun(run.info.runId)},
  ]:[];
  return <>{target&&run&&createPortal(<div ref={ref} className="deskServerMenu" role="menu" aria-label={t('desk.server.menu')} style={position} onKeyDown={e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const current=items.indexOf(document.activeElement as HTMLButtonElement);const index=e.key==='Home'?0:e.key==='End'?items.length-1:(current+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[index]?.focus();}}><header>{run.info.name}</header>{actions.map(a=><button role="menuitem" type="button" key={a.key} disabled={a.disabled} onClick={()=>act(a.fn)}><a.icon size={15}/>{t(a.key)}</button>)}</div>,document.body)}<RestartDialog open={!!pendingLaunch} running={pendingLaunch?.action==='restart'} profileName={pendingLaunch?.profileName??''} pending={confirming} onConfirm={confirmLaunch} onClose={cancelLaunch}/></>;
}
