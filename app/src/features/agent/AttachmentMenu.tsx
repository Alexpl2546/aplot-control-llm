import { Image, Paperclip, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function AttachmentMenu({disabled,onAttach}:{disabled:boolean;onAttach:(images:boolean)=>void}) {
  const {t}=useTranslation(),id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  return <div className="awAttachmentMenu" ref={root} onBlur={event=>{if(!root.current?.contains(event.relatedTarget as Node))setOpen(false);}} onKeyDown={event=>{
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();}
    if(event.key==='Tab')setOpen(false);
  }}><button ref={trigger} type="button" className="awComposerAdd" disabled={disabled} aria-label={t('aw.composer.add')} title={t('aw.composer.add')} aria-haspopup="menu" aria-expanded={open&&!disabled} aria-controls={id} onClick={()=>setOpen(v=>!v)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);}}}><Plus size={21}/></button>
    {open&&!disabled&&<div className="awAttachmentPopover" role="menu" id={id} aria-label={t('aw.composer.add')} onKeyDown={event=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
      const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')),current=items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
    }}><button type="button" role="menuitem" onClick={()=>{close();onAttach(false);}}><Paperclip size={17}/><span>{t('aw.composer.attachFiles')}<small>{t('aw.composer.fileHint')}</small></span></button><button type="button" role="menuitem" onClick={()=>{close();onAttach(true);}}><Image size={17}/><span>{t('aw.composer.attachImages')}<small>{t('aw.composer.imageHint')}</small></span></button></div>}
  </div>;
}
