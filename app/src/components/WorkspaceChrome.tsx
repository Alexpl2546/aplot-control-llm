import { useEffect } from 'react';
import { useControlStore } from '../store/control';
import { usePalette } from './shell/CommandPalette';
import { useLaunchUi } from '../features/launches/ui';
import { toggleMiniWindow } from '../features/mini/miniWindow';
import { isTauri } from '../services/tauri';
import { SHORTCUT_VIEWS, shortcutTarget } from '../lib/navigation';
import { actionFor, comboOf } from '../lib/shortcuts';

const HINT_DELAY_MS=450;

/**
 * Global keyboard layer: navigation, palette, new server, settings and mini window — combos from Settings → Shortcuts. Holding Ctrl alone for a moment reveals the shortcut hints on screen.
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
      // Combos come from Settings → Shortcuts and match the physical key, so they work in any keyboard layout.
      // Plain typing never triggers a shortcut: a combo needs Ctrl or Alt, or is a function key.
      if(!(event.ctrlKey||event.metaKey||event.altKey)&&!/^F\d+$/.test(event.code))return;
      const action=actionFor(comboOf(event));
      if(!action)return;
      if(action==='palette'){event.preventDefault();const palette=usePalette.getState();palette.setOpen(!palette.open);return;}
      if(modalOpen()||usePalette.getState().open)return;
      event.preventDefault();
      if(action==='mini'){if(isTauri())void toggleMiniWindow();return;}
      if(action==='newServer'){useLaunchUi.getState().setQuickAdd(true);return;}
      if(action==='settings'){setView('settings');return;}
      setView(shortcutTarget(SHORTCUT_VIEWS[Number(action.slice(3))-1]));
    };
    const onUp=(event:KeyboardEvent)=>{if(event.key==='Control')hideHints();};
    window.addEventListener('keydown',onKey);window.addEventListener('keyup',onUp);window.addEventListener('blur',hideHints);
    return()=>{hideHints();window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',onUp);window.removeEventListener('blur',hideHints);};
  },[setView]);
  return null;
}
