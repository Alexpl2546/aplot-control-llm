import { Bell, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useControlStore } from '../../store/control';
import type { AppNotice } from '../../types/app';
import { WorkspaceDialog } from '../../features/agent/WorkspacePanels';
import { Button } from '../ui/Primitives';
import './NotificationCenter.css';

export function NotificationCenter() {
  const {t}=useTranslation();
  const [open,setOpen]=useState(false),[unread,setUnread]=useState(0);
  const [items,setItems]=useState<AppNotice[]>(()=>useControlStore.getState().notices);
  const runs=useControlStore(state=>state.runs);
  useEffect(()=>useControlStore.subscribe((state,previous)=>{
    if(state.notices===previous.notices)return;
    const added=state.notices.filter(notice=>!previous.notices.some(item=>item.id===notice.id));
    if(added.length){setItems(current=>[...added.slice().reverse(),...current].slice(0,50));setUnread(count=>count+added.length);}
  }),[]);
  const crashed=runs.filter(run=>run.info.state==='crashed');
  return <><button type="button" className="kIconBtn kBell" title={t('notifications.title')} aria-label={t('notifications.title')} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setUnread(0);setOpen(true);}}>
    <Bell size={16}/>{unread>0&&<i className="kCount">{Math.min(unread,99)}</i>}
  </button>{open&&<WorkspaceDialog title={t('notifications.title')} onClose={()=>setOpen(false)}>
    <div className="notificationList">
      {crashed.map(run=><button type="button" className="notificationItem is-error" key={run.info.runId} onClick={()=>{useControlStore.getState().selectRun(run.info.runId);useControlStore.getState().setView('dashboard');setOpen(false);}}><b>{run.info.name}</b><span>{t('status.crashed')}</span></button>)}
      {items.map(item=><article key={item.id} className={`notificationItem is-${item.kind}`}>{item.message}</article>)}
      {!items.length&&!crashed.length&&<p className="oaHelp">{t('notifications.empty')}</p>}
    </div><div className="awDialogActions"><Button disabled={!items.length} onClick={()=>{setItems([]);setUnread(0);}}><Trash2 size={14}/>{t('notifications.clear')}</Button><Button onClick={()=>{useControlStore.getState().setView('logs');setOpen(false);}}>{t('nav.logs')}</Button></div>
  </WorkspaceDialog>}</>;
}
