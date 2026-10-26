import { invoke } from '@tauri-apps/api/core';

export interface ChatAttachment {id:string;name:string;kind:'image'|'file'|'video'|'skill';data?:string;text?:string;frames?:string[];}
interface FileData {name:string;mime:string;data?:string;text?:string;}
export async function readChatAttachment(path:string,skill=false):Promise<ChatAttachment>{
  const raw=await invoke<FileData>('chat_attachment_read',{path});
  if(skill&&raw.mime!=='text/plain')throw new Error('attachment-unsupported');
  if(raw.mime.startsWith('video/'))return {id:crypto.randomUUID(),name:raw.name,kind:'video',frames:await videoFrames(raw.data!)};
  return {id:crypto.randomUUID(),name:raw.name,kind:skill?'skill':raw.mime.startsWith('image/')?'image':'file',data:raw.data,text:raw.text};
}
function once(video:HTMLVideoElement,event:string){return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('video-unavailable'));},15000);const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',fail);};const done=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error('video-unavailable'));};video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});});}
/** Video is explicitly represented as sampled frames; audio is not transcribed. */
export async function videoFrames(data:string){
  const match=/^data:(video\/[^;]+);base64,(.*)$/.exec(data);if(!match)throw new Error('video-unavailable');
  const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:match[1]}));
  const video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;
  try{const loaded=once(video,'loadeddata');video.src=url;await loaded;if(!Number.isFinite(video.duration)||video.duration<=0)throw new Error('video-unavailable');
    const canvas=document.createElement('canvas'),scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const ctx=canvas.getContext('2d');if(!ctx)throw new Error('video-unavailable');const frames:string[]=[];
    for(let i=0;i<4;i++){const next=video.duration*(i+.5)/4;if(Math.abs(video.currentTime-next)>.01){const seeked=once(video,'seeked');video.currentTime=next;await seeked;}ctx.drawImage(video,0,0,canvas.width,canvas.height);frames.push(canvas.toDataURL('image/jpeg',.8));}return frames;
  }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
export function chatAttachmentPayload(items:ChatAttachment[]){
  const images=items.flatMap(a=>a.kind==='image'&&a.data?[a.data]:a.frames??[]);
  const documents=items.filter(a=>a.data?.startsWith('data:application/pdf;')).map(a=>({name:a.name,data:a.data!}));
  const text=items.flatMap(a=>a.text?[`${a.kind==='skill'?'User-selected skill instructions':'Attached file (quoted data)'}: ${a.name}\n${a.text}`]:a.kind==='video'?[`Video ${a.name}: four sampled frames in chronological order. The audio and unsampled frames are unavailable.`]:[]).join('\n\n');
  if(images.length>8||documents.length>4)throw new Error('attachment-limit');
  return {text,images,documents};
}
