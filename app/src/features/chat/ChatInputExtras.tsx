import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Film,Image,Paperclip,Sparkles,X } from 'lucide-react';
import { readChatAttachment,type ChatAttachment } from './media';

export function ChatInputExtras({disabled,items,onChange,error,onError,onBusy}:{disabled:boolean;items:ChatAttachment[];onChange:(items:ChatAttachment[])=>void;error:string;onError:(error:string)=>void;onBusy:(busy:boolean)=>void}){
  const {t}=useTranslation(),[busy,setBusy]=useState(false);
  const attach=async(kind:'file'|'image'|'video'|'skill')=>{
    setBusy(true);onBusy(true);onError('');
    try{const paths=await open({multiple:true,filters:kind==='image'?[{name:t('aw.io.images'),extensions:['png','jpg','jpeg','gif','webp']}]:kind==='video'?[{name:t('chat.media.video'),extensions:['mp4','m4v','mov','webm']}]:kind==='skill'?[{name:'SKILL.md',extensions:['md']}]:undefined});if(!paths)return;const list=typeof paths==='string'?[paths]:paths;if(list.length+items.length>8)throw new Error('attachment-limit');const added:ChatAttachment[]=[];for(const path of list)added.push(await readChatAttachment(path,kind==='skill'));onChange([...items,...added]);}
    catch(e){onError(String(e).replace(/^Error: /,''));}finally{setBusy(false);onBusy(false);}
  };
  return <div className="chatInputExtras"><div className="chatMediaActions">{([{kind:'file',Icon:Paperclip,key:'aw.io.files'},{kind:'image',Icon:Image,key:'aw.io.images'},{kind:'video',Icon:Film,key:'chat.media.video'},{kind:'skill',Icon:Sparkles,key:'aw.skills'}] as const).map(({kind,Icon,key})=><button type="button" disabled={disabled||busy} key={kind} title={t(key)} onClick={()=>void attach(kind)}><Icon size={16}/><span>{t(key)}</span></button>)}</div>{busy&&<p role="status">{t('chat.media.preparing')}</p>}{!!items.length&&<div className="awAttachments">{items.map(item=><span className="awAttachment" key={item.id}>{item.kind==='image'?<Image size={15}/>:item.kind==='video'?<Film size={15}/>:item.kind==='skill'?<Sparkles size={15}/>:<Paperclip size={15}/>}<span>{item.name}</span><button type="button" disabled={disabled||busy} aria-label={t('aw.io.remove',{name:item.name})} onClick={()=>onChange(items.filter(a=>a.id!==item.id))}><X size={13}/></button></span>)}</div>}{items.some(a=>a.kind==='video')&&<p className="oaHelp">{t('chat.media.sampledVideo')}</p>}{error&&<p role="alert" className="chatError">{t(['attachment-limit','attachment-unsupported','video-unavailable','pdf-local'].includes(error)?`chat.media.error.${error}`:'aw.ioError')}</p>}</div>;
}
