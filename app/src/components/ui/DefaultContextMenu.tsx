import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import './DefaultContextMenu.css';

interface MenuTarget { x: number; y: number; element: HTMLElement; root: HTMLElement; }

/** Runs after feature handlers, which claim their menus with preventDefault/stopPropagation. */
export function DefaultContextMenu() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<MenuTarget>();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = (event: MouseEvent) => {
      setTarget(undefined);
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      event.preventDefault();
      if(event.target.closest('[role="menu"]'))return;
      const element = event.target instanceof HTMLElement ? event.target : event.target.parentElement;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      setTarget({ element, root: element.closest('dialog[open]') ?? document.body,
        x: event.clientX || bounds.left, y: event.clientY || bounds.bottom });
    };
    document.addEventListener('contextmenu', open);
    return () => document.removeEventListener('contextmenu', open);
  }, []);
  useLayoutEffect(() => {
    if (!target || !menu.current) return;
    const node = menu.current;
    node.showPopover?.();
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(target.x, innerWidth - bounds.width - 8)) / zoom}px`;
    node.style.top = `${Math.max(8, Math.min(target.y, innerHeight - bounds.height - 8)) / zoom}px`;
    node.querySelector('button')?.focus();
  }, [target]);
  useEffect(() => {
    if (!target) return;
    const close = () => setTarget(undefined);
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); target.element.focus({ preventScroll: true }); close(); }
      else if (event.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [target]);
  if (!target) return null;
  const selectAll = () => {
    const input = target.element.closest('input, textarea');
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      input.focus({ preventScroll: true });
      input.select();
    } else {
      const editable = target.element.closest<HTMLElement>('[contenteditable="true"]');
      editable?.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editable ?? target.root);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    setTarget(undefined);
  };
  return createPortal(<div ref={menu} className="deskServerMenu defaultContextMenu" role="menu" aria-label={t('context.selectAll')}
    popover="manual" onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" onClick={selectAll}>{t('context.selectAll')}</button>
  </div>, target.root);
}
