import { useEffect } from 'react';
import { useControlStore } from '../store/control';
import type { AppView } from '../types/app';
const SHORTCUTS:AppView[]=['dashboard','configuration','models','performance','logs','apiDocs'];
/** Navigation shortcuts remain available independently of the retired command palette. */
export function WorkspaceChrome(){
  const setView=useControlStore(s=>s.setView);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(!(event.ctrlKey||event.metaKey)||event.shiftKey||event.altKey||document.querySelector('dialog[open],.setupOverlay,.modalBackdrop'))return;const position=Number(event.key);if(position>=1&&position<=6){event.preventDefault();setView(SHORTCUTS[position-1]);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[setView]);return null;
}
