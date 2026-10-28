import { Bot, Boxes, CornerDownLeft, Monitor, Moon, PanelTop, Play, Plus, RotateCw, Rows3, ScrollText, Search, Server, Settings, Sparkles, Square, Sun, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useControlStore } from "../../store/control";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { isActive, runColor } from "../../features/launches/presentation";
import { useLaunchUi } from "../../features/launches/ui";
import { stopRunWithUndo } from "../../features/launches/stopWithUndo";
import { selectTask, useWorkspaceStore } from "../../features/agent/workspace";
import { useUiPrefs } from "../../lib/uiPrefs";
import { languageName, nextAppLanguage } from "../../lib/languages";
import { toggleMiniWindow } from "../../features/mini/miniWindow";
import { isTauri } from "../../services/tauri";
import { NAV } from "./KSidebar";
import { commandScore } from "../../lib/commandScore";

export const usePalette = create<{ open: boolean; setOpen: (open: boolean) => void }>(set => ({ open: false, setOpen: open => set({ open }) }));

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  color?: string;
  keywords?: string;
  icon: ComponentType<{ size?: number }> | LucideIcon;
  run: () => void | Promise<unknown>;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = usePalette(state => state.open);
  const setOpen = usePalette(state => state.setOpen);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const runs = useControlStore(state => state.runs);
  const profiles = useControlStore(state => state.profiles);
  const models = useControlStore(state => state.libraryModels);
  const settings = useControlStore(state => state.settings);
  const tasks = useWorkspaceStore(state => state.tasks);
  const projects = useWorkspaceStore(state => state.projects);
  const density = useUiPrefs(state => state.density);
  const mica = useUiPrefs(state => state.mica);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { setQuery(""); setActive(0); element.showModal(); requestAnimationFrame(() => input.current?.focus()); }
    if (!open && element.open) element.close();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    if (!open) return [];
    const control = useControlStore.getState();
    const go = (view: Parameters<typeof control.setView>[0]) => () => control.setView(view);
    const dark = settings.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : settings.theme === "dark";
    const out: Command[] = [];
    const groupNav = t("palette.group.navigate"), groupServers = t("palette.group.servers"), groupProfiles = t("palette.group.profiles");
    const groupModels = t("palette.group.models"), groupTasks = t("palette.group.tasks"), groupApp = t("palette.group.app");
    const shortcuts: Record<string, string> = { dashboard: "Ctrl 1", configuration: "Ctrl 2", models: "Ctrl 3", performance: "Ctrl 4", logs: "Ctrl 5", apiDocs: "Ctrl 6" };
    NAV.forEach(([id, Icon, key]) => out.push({ id: `nav:${id}`, group: groupNav, label: t(key), hint: shortcuts[id], icon: Icon, run: go(id) }));
    out.push({ id: "nav:settings", group: groupNav, label: t("nav.settings"), hint: "Ctrl ,", icon: Settings, run: go("settings") });

    out.push({ id: "server:new", group: groupServers, label: t("palette.newServer"), hint: "Ctrl N", icon: Plus, run: () => useLaunchUi.getState().setQuickAdd(true) });
    runs.forEach((run, index) => {
      const name = `${t("k.serverNumber", { number: index + 1 })} · ${run.info.name}`;
      const color = runColor(run.info.runId);
      const meta = `${ENGINE_NAMES[run.info.engine]} · ${t(`status.${run.info.state}`)}`;
      out.push({ id: `server:select:${run.info.runId}`, group: groupServers, label: name, hint: meta, color, icon: Server, keywords: run.info.endpoint, run: () => control.selectRun(run.info.runId) });
      if (!run.info.managed) return;
      if (isActive(run.info.state)) {
        out.push({ id: `server:stop:${run.info.runId}`, group: groupServers, label: t("palette.stop", { name }), color, icon: Square, keywords: "stop стоп остановить выключить", run: () => stopRunWithUndo(run.info.runId) });
        out.push({ id: `server:restart:${run.info.runId}`, group: groupServers, label: t("palette.restart", { name }), color, icon: RotateCw, keywords: "restart перезапуск рестарт", run: () => control.restartManagedRun(run.info.runId) });
      } else {
        out.push({ id: `server:start:${run.info.runId}`, group: groupServers, label: t("palette.start", { name }), color, icon: Play, keywords: "start старт запуск включить", run: () => control.startManagedRun(run.info.runId) });
      }
      out.push({ id: `server:logs:${run.info.runId}`, group: groupServers, label: t("palette.logs", { name }), color, icon: ScrollText, run: () => { control.selectRun(run.info.runId); control.setView("logs"); } });
    });

    profiles.filter(profile => !profile.unsupportedEngine).slice(0, 40).forEach(profile => out.push({
      id: `profile:${profile.id}`, group: groupProfiles, label: t("palette.launchProfile", { name: profile.name }),
      hint: `${ENGINE_NAMES[(profile.config.engine ?? "llama_cpp") as keyof typeof ENGINE_NAMES] ?? profile.config.engine} · ${Math.round(profile.config.ctxSize / 1024)}K`, icon: Play,
      run: () => useLaunchUi.getState().setQuickAdd(true, profile.id),
    }));

    models.slice(0, 60).forEach(model => out.push({
      id: `model:${model.id}`, group: groupModels, label: model.name,
      hint: [model.quantization, `${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`].filter(Boolean).join(" · "), icon: Boxes, keywords: `${model.path} ${model.architecture ?? ""}`,
      run: go("models"),
    }));

    [...tasks].filter(task => !task.deletedAt && !task.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30).forEach(task => out.push({
      id: `task:${task.id}`, group: groupTasks, label: task.title, hint: projects.find(project => project.id === task.projectId)?.name, icon: Bot,
      run: () => { selectTask(task.id); control.setView("agentWorkspace"); },
    }));

    out.push({ id: "app:theme", group: groupApp, label: t(dark ? "k.theme.toLight" : "k.theme.toDark"), icon: dark ? Sun : Moon, run: () => control.updateSettings({ theme: dark ? "light" : "dark" }) });
    out.push({ id: "app:density", group: groupApp, label: t(document.documentElement.dataset.density === "compact" ? "density.toComfortable" : "density.toCompact"), icon: Rows3, run: () => useUiPrefs.getState().setDensity(document.documentElement.dataset.density === "compact" ? "comfortable" : "compact") });
    out.push({ id: "app:language", group: groupApp, label: t("language.switchTo", { language: languageName(nextAppLanguage(settings.language)) }), icon: Sparkles, run: () => control.updateSettings({ language: nextAppLanguage(settings.language) }) });
    if (isTauri()) {
      out.push({ id: "app:mini", group: groupApp, label: t("mini.toggle"), hint: "Ctrl Shift M", icon: PanelTop, run: () => toggleMiniWindow() });
      out.push({ id: "app:mica", group: groupApp, label: t(mica ? "mica.off" : "mica.on"), icon: Monitor, run: () => useUiPrefs.getState().setMica(!mica) });
    }
    return out;
  }, [open, runs, profiles, models, tasks, projects, settings.theme, settings.language, density, mica, t]);

  const results = useMemo(() => {
    if (!query.trim()) {
      const order = [t("palette.group.servers"), t("palette.group.navigate"), t("palette.group.tasks"), t("palette.group.app")];
      return commands.filter(command => order.includes(command.group)).sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    }
    return commands
      .map(command => ({ command, score: Math.max(commandScore(command.label, query), commandScore(`${command.keywords ?? ""} ${command.hint ?? ""}`, query) - 40) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(entry => entry.command);
  }, [commands, query, t]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const execute = (command?: Command) => {
    if (!command) return;
    setOpen(false);
    Promise.resolve(command.run()).catch(error => useControlStore.getState().notify("error", String(error)));
  };

  let lastGroup = "";
  return <dialog ref={dialog} className="kPalette commandPalette" aria-label={t("palette.title")}
    onClose={() => setOpen(false)} onCancel={event => { event.preventDefault(); setOpen(false); }}
    onClick={event => { if (event.target === dialog.current) setOpen(false); }}>
    {open && <>
      <div className="commandInput"><Search size={17}/>
        <input ref={input} value={query} placeholder={t("palette.placeholder")} aria-label={t("palette.placeholder")} role="combobox" aria-expanded="true" aria-controls="palette-results"
          aria-activedescendant={results[active] ? `palette-${results[active]!.id}` : undefined} autoComplete="off" spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(results.length - 1, value + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); execute(results[active]); }
          }}/>
        <button type="button" aria-label={t("actions.close")} onClick={() => setOpen(false)}><X size={15}/></button>
      </div>
      <div ref={list} id="palette-results" className="commandResults" role="listbox">
        {!results.length && <p className="commandEmpty">{t("palette.empty")}</p>}
        {results.map((command, index) => {
          const header = command.group !== lastGroup ? command.group : "";
          lastGroup = command.group;
          const Icon = command.icon;
          return <div key={command.id} role="presentation">
            {header && <div className="commandSection" role="presentation">{header}</div>}
            <div id={`palette-${command.id}`} data-index={index} role="option" aria-selected={index === active} className={`commandOption${index === active ? " selected" : ""}`}
              style={command.color ? { ["--c" as string]: command.color } : undefined}
              onPointerMove={() => { if (index !== active) setActive(index); }} onClick={() => execute(command)}>
              <span className="commandOptionIcon"><Icon size={15}/></span>
              <span className="kPalLabel">{command.label}</span>
              {command.hint && <span className={`kPalHint${command.color ? " hasColor" : ""}`}>{command.hint}</span>}
            </div>
          </div>;
        })}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd>{t("palette.navigate")}</span><span><kbd><CornerDownLeft size={10}/></kbd>{t("palette.run")}</span><span><kbd>Esc</kbd>{t("palette.close")}</span><span className="kPalFootHint">{t("palette.hint")}</span></footer>
    </>}
  </dialog>;
}
