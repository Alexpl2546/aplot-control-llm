import { Activity, ArrowDown, ArrowRight, ArrowUp, BookOpen, Boxes, Check, Gauge, Search, Settings, SlidersHorizontal, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import type { AppView } from "../types/app";
import { useStudioCopy } from "./ui/studioCopy";

const destinations = [
  { id: "dashboard", key: "nav.dashboard", Icon: Gauge, terms: "overview home главная обзор мониторинг" },
  { id: "configuration", key: "nav.configuration", Icon: SlidersHorizontal, terms: "config launch параметры запуск" },
  { id: "models", key: "nav.library", Icon: Boxes, terms: "models library модели библиотека" },
  { id: "profiles", key: "nav.profiles", Icon: Boxes, terms: "profiles профили" },
  { id: "performance", key: "nav.benchmarks", Icon: Activity, terms: "performance benchmark тест производительность" },
  { id: "logs", key: "nav.logs", Icon: ScrollText, terms: "logs логи журнал" },
  { id: "apiDocs", key: "actions.openApi", Icon: BookOpen, terms: "api docs документация" },
  { id: "settings", key: "nav.settings", Icon: Settings, terms: "settings настройки" },
] satisfies { id: AppView; key: string; Icon: typeof Gauge; terms: string }[];

export function WorkspaceChrome() {
  const { t } = useTranslation();
  const copy = useStudioCopy();
  const activeView = useControlStore(state => state.activeView);
  const setView = useControlStore(state => state.setView);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const items = destinations.filter(item => `${t(item.key)} ${item.terms}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));

  const go = (id: AppView) => { setView(id); setOpened(false); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector(".setupOverlay, .modalBackdrop, .modelImportBackdrop")) {
        event.preventDefault();
        previousFocus.current = document.activeElement as HTMLElement;
        setQuery(""); setSelected(0); setOpened(value => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (opened) { dialog.current?.showModal(); input.current?.focus(); }
    else if (dialog.current?.open) { dialog.current.close(); (previousFocus.current?.isConnected ? previousFocus.current : document.getElementById("main-content"))?.focus(); }
  }, [opened]);

  useEffect(() => { if (opened) document.getElementById(`studio-command-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [selected, opened]);

  return <>
    <dialog ref={dialog} className="commandPalette" aria-label={copy.searchHint} onCancel={() => setOpened(false)} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpened(false); } }}>
      <div className="commandInput"><Search size={21}/><input ref={input} placeholder={copy.searchHint} value={query} role="combobox" aria-label={copy.searchHint} aria-expanded="true" aria-controls="studio-commands" aria-autocomplete="list" aria-activedescendant={items.length ? `studio-command-${selected}` : undefined} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(index => items.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0); }
        if (event.key === "Enter" && items[selected]) { event.preventDefault(); go(items[selected].id); }
      }}/><button type="button" aria-label={copy.close} onClick={() => setOpened(false)}><X size={18}/></button></div>
      <div className="commandSection">{copy.section}</div>
      <div id="studio-commands" role="listbox" className="commandResults" aria-label={copy.section}>
        {items.map(({ id, key, Icon }, index) => <div id={`studio-command-${index}`} role="option" aria-selected={index === selected} key={id} className={`commandOption ${index === selected ? "selected" : ""}`} onPointerMove={() => setSelected(index)} onClick={() => go(id)}><span className="commandOptionIcon"><Icon size={18}/></span><span>{t(key)}</span>{activeView === id ? <Check size={15}/> : <ArrowRight size={15}/>}</div>)}
        {!items.length && <p className="commandEmpty">{copy.noResults}</p>}
      </div>
      <footer><span><kbd><ArrowUp size={11}/></kbd><kbd><ArrowDown size={11}/></kbd>{copy.navigate}</span><span><kbd>↵</kbd>{copy.open}</span><span><kbd>esc</kbd>{copy.close}</span></footer>
    </dialog>
  </>;
}
