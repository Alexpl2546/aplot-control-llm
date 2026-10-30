import { useEffect } from 'react';
import { useControlStore } from '../store/control';
import { usePalette } from './shell/CommandPalette';
import { useLaunchUi } from '../features/launches/ui';
import { toggleMiniWindow } from '../features/mini/miniWindow';
import { isTauri } from '../services/tauri';
import { SHORTCUT_VIEWS, shortcutTarget } from '../lib/navigation';

const HINT_DELAY_MS=450;

/**
 * Global keyboard layer: Ctrl+1…5 navigation, Ctrl+K palette, Ctrl+N new server, Ctrl+, settings,
 * Ctrl+Shift+M mini window. Holding Ctrl alone for a moment reveals the shortcut hints on screen.
 */
export function WorkspaceChrome(){
  const setView=useControlStore(s=>s.setView);
  useEffect(()=>{
    let hintTimer:number|undefined;
    const root=document.documentElement;
    const hideHints=()=>{window.clearTimeout(hintTimer);hintTimer=undefined;delete root.dataset.keyHints;};
    const modalOpen=()=>!!document.querySelector('dialog[open]:not(.kPalette),.setupOverlay,.modalBackdrop,.agentNetworkOverlay');
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Control'&&!event.repeat&&!event.shiftKey&&!event.altKey){hintTimer=window.setTimeout(()=>{root.dataset.keyHints='on';},HINT_DELAY_MS);return;}
      if(event.key!=='Control')hideHints();
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();
      if(key==='k'&&!event.shiftKey){event.preventDefault();const palette=usePalette.getState();palette.setOpen(!palette.open);return;}
      if(modalOpen()||usePalette.getState().open)return;
      if(event.shiftKey&&(key==='m'||event.code==='KeyM')&&isTauri()){event.preventDefault();void toggleMiniWindow();return;}
      if(event.shiftKey)return;
      if(key==='n'){event.preventDefault();useLaunchUi.getState().setQuickAdd(true);return;}
      if(key===','){event.preventDefault();setView('settings');return;}
      const position=Number(event.key);if(position>=1&&position<=SHORTCUT_VIEWS.length){event.preventDefault();setView(shortcutTarget(SHORTCUT_VIEWS[position-1]));}
    };
    const onUp=(event:KeyboardEvent)=>{if(event.key==='Control')hideHints();};
    window.addEventListener('keydown',onKey);window.addEventListener('keyup',onUp);window.addEventListener('blur',hideHints);
    return()=>{hideHints();window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',onUp);window.removeEventListener('blur',hideHints);};
  },[setView]);
  return null;
}
