import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, Film, Image, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import './mediaGallery.css';

export interface MediaItem { id: string; name: string; kind: 'image' | 'video'; data?: string; path?: string; poster?: string; }
const cache = new Map<string, string>();
async function mediaData(item: MediaItem) {
  if (item.data) return item.data;
  if (!item.path) throw new Error('attachment-missing');
  const cached = cache.get(item.path);
  if (cached) return cached;
  const result = await invoke<{ data?: string }>('chat_attachment_read', { path: item.path, preview: true });
  if (!result.data) throw new Error('attachment-unsupported');
  // Cache small images only; videos are loaded when their viewer opens.
  if (item.kind === 'image' && result.data.length < 7 * 1024 * 1024) {
    while (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(item.path, result.data);
  }
  return result.data;
}
function useMediaSource(item: MediaItem | undefined, thumbnail = false) {
  const [state, setState] = useState<{ key: string; src?: string; failed?: boolean }>();
  const key = item ? `${item.id}:${thumbnail}` : '';
  useEffect(() => {
    if (!item) return;
    let active = true, objectUrl: string | undefined;
    const load = async () => {
      try {
        if (thumbnail && item.poster) { setState({ key, src: item.poster }); return; }
        if (thumbnail && item.kind === 'video') return;
        const data = await mediaData(item);
        const match = /^data:((?:image|video)\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(data);
        if (!match || !match[1].startsWith(`${item.kind}/`)) throw new Error('attachment-data');
        const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
        setState({ key, src: objectUrl });
      } catch { if (active) setState({ key, failed: true }); }
    };
    void load();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key, item?.data, item?.path, item?.poster, item?.kind, thumbnail]);
  return state?.key === key ? state : undefined;
}

function MediaThumbnail({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const { t } = useTranslation(), source = useMediaSource(item, true);
  return <button type="button" className="chatMediaThumbnail" title={item.name} aria-label={t('chat.media.open', { name: item.name })} onClick={onOpen}>
    {source?.src ? <img src={source.src} alt={item.name} loading="lazy"/> : item.kind === 'video' ? <Film size={28}/> : <Image size={28}/>}
    {item.kind === 'video' && <span className="chatMediaPlay" aria-hidden="true">▶</span>}
    <span className="chatMediaName">{item.name}</span>
  </button>;
}

function MediaViewer({ items, index, onSelect, onClose }: { items: MediaItem[]; index: number; onSelect: (index: number) => void; onClose: () => void }) {
  const { t } = useTranslation(), dialog = useRef<HTMLDialogElement>(null), title = useId();
  const item = items[index], source = useMediaSource(item);
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="chatMediaViewer" aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onSelect(index - 1); }
    if (event.key === 'ArrowRight' && index < items.length - 1) { event.preventDefault(); onSelect(index + 1); }
  }}>
    <header><b id={title}>{item.name}</b><span>{index + 1} / {items.length}</span><button type="button" aria-label={t('actions.close')} onClick={onClose} autoFocus><X size={22}/></button></header>
    <div className="chatMediaViewport">
      {index > 0 && <button className="chatMediaPrevious" type="button" aria-label={t('chat.media.previous')} onClick={() => onSelect(index - 1)}><ChevronLeft/></button>}
      {source?.failed || failed === item.id ? <p role="alert">{t('chat.media.previewFailed')}</p> : !source?.src ? <p role="status">{t('chat.media.preparing')}</p> : item.kind === 'video'
        ? <video key={source.src} src={source.src} controls playsInline preload="metadata" aria-label={item.name} onError={() => setFailed(item.id)}/>
        : <img src={source.src} alt={item.name} onError={() => setFailed(item.id)}/>}
      {index < items.length - 1 && <button className="chatMediaNext" type="button" aria-label={t('chat.media.next')} onClick={() => onSelect(index + 1)}><ChevronRight/></button>}
    </div>
  </dialog>, document.body);
}

export function MediaGallery({ items }: { items: MediaItem[] }) {
  const [selected, setSelected] = useState<string>();
  const index = items.findIndex(item => item.id === selected);
  if (!items.length) return null;
  return <><div className="chatMediaGallery">{items.map(item => <MediaThumbnail key={item.id} item={item} onOpen={() => setSelected(item.id)}/>)}</div>
    {index >= 0 && <MediaViewer items={items} index={index} onSelect={next => setSelected(items[next].id)} onClose={() => setSelected(undefined)}/>}</>;
}
