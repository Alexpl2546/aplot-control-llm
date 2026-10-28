import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useControlStore } from "../../store/control";
import { APP_LANGUAGES } from "../../lib/languages";

/** Sidebar language button: one click opens the full list instead of cycling through ten languages. */
export function LanguageMenu() {
  const { t } = useTranslation();
  const language = useControlStore(state => state.settings.language);
  const updateSettings = useControlStore(state => state.updateSettings);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ left: 0, bottom: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } return; }
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  const toggle = () => {
    const box = button.current?.getBoundingClientRect();
    if (box) setPlace({ left: box.left, bottom: window.innerHeight - box.top + 8 });
    setOpen(value => !value);
  };
  const choose = (code: typeof language) => { setOpen(false); button.current?.focus(); if (code !== language) void updateSettings({ language: code }); };
  return <>
    <button ref={button} type="button" className="kIconBtn kLang" aria-haspopup="menu" aria-expanded={open} title={t("settings.language")} aria-label={t("settings.language")} onClick={toggle}>{language.toUpperCase()}</button>
    {open && createPortal(<div ref={menu} className="kLangMenu" role="menu" aria-label={t("settings.language")} style={{ left: place.left, bottom: place.bottom }}
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      {APP_LANGUAGES.map(item => <button type="button" role="menuitemradio" aria-checked={item.code === language} key={item.code} lang={item.code} onClick={() => choose(item.code)}>
        <span className="kMono">{item.code.toUpperCase()}</span><b>{item.nativeName}</b>{item.code === language && <Check size={14}/>}</button>)}
    </div>, document.body)}
  </>;
}
