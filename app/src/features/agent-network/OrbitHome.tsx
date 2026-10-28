import ReactMarkdown from "react-markdown";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle, ArrowLeft, ArrowRight, Bot, ChevronRight, CircleAlert, Copy, Crosshair, FolderOpen,
  LayoutGrid, Minus, Pause, Pencil, Play, Plug, Plus, Search, Server, Settings2, Users, X,
} from "lucide-react";
import { useActivityStore } from "../activity/store";
import type { ActivityEvent } from "../activity/model";
import { useAgentStore } from "../agent/store";
import { selectProject, selectTask, taskStatus, useWorkspaceStore } from "../agent/workspace";
import { toolPath } from "../agent/workspaceModel";
import { AgentPresetForm, PresetModelBadge, TemplatePicker, openAgentPreset } from "../agent/AgentPresets";
import { AgentIcon } from "../agent/AgentIdentity";
import type { AgentPreset } from "../agent/workspaceModel";
import { useControlStore } from "../../store/control";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { useLaunchUi } from "../launches/ui";
import { Button } from "../../components/ui/Primitives";
import { isTauri } from "../../services/tauri";
import { demoAgentNetwork } from "../../mocks/agentNetworkDemo";
import { AwayDigest, useAway } from "../away/AwayDigest";
import { buildAgentNetwork, type AgentNetworkSnapshot, type NetworkAgent, type NetworkProject, type NetworkStatus, type NetworkTask } from "./model";
import { AgentNetworkLegend, ProjectDotGraph, agentDisplayName } from "./AgentNetworkGraph";
import { AgentOrbit } from "./AgentOrbit";
import "./AgentNetwork.css";
import "./orbitHome.css";

type View =
  | { kind: "overview" } | { kind: "agents" } | { kind: "projects" }
  | { kind: "agent"; id: string } | { kind: "project"; id: string } | { kind: "task"; id: string } | { kind: "newAgent" };

function StatusTag({ status }: { status: NetworkStatus }) {
  const { t } = useTranslation();
  return <span className={`agentNetworkStatus state-${status}`}><i aria-hidden="true"/>{t(`agentNetwork.status.${status}`)}</span>;
}

function ActivityLine({ event, language }: { event: ActivityEvent; language: string }) {
  const { t } = useTranslation();
  const detail = [event.data.agent, event.data.outcome, event.data.message].find(value => typeof value === "string") as string | undefined;
  return <li className={`agentNetworkEvent level-${event.level}`}><i aria-hidden="true"/>
    <div><b>{t(`agentNetwork.event.${event.kind}`, { defaultValue: event.kind })}</b>{detail && <span>{detail}</span>}<time dateTime={new Date(event.time).toISOString()}>{new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(event.time)}</time></div>
  </li>;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="ohSection"><header><h3>{title}</h3>{action}</header>{children}</section>;
}

/**
 * Home = the Orbit. The whole page is the map; everything else happens in place (hover, click, focus)
 * or in the side panel that slides in from the right. The panel replaces the old dashboard cards
 * (continue work, ready servers, projects) and the separate full-screen network dialog.
 */
export function OrbitHome() {
  const { t, i18n } = useTranslation();
  const workspace = useWorkspaceStore();
  const threads = useAgentStore(state => state.threads);
  const events = useActivityStore(state => state.events);
  const control = useControlStore();
  const awaySince = useAway(state => state.since);
  const [scopeToRun, setScopeToRun] = useState(false);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [resetToken, setResetToken] = useState(0);
  const [focusProjectId, setFocusProjectId] = useState<string>();
  const [cutoff, setCutoff] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [stack, setStack] = useState<View[]>([]);
  const [drawerWidth, setDrawerWidth] = useState(0);
  const [editingId, setEditingId] = useState<string>();
  const [newDraft, setNewDraft] = useState<AgentPreset>();
  const drawer = useRef<HTMLElement>(null);
  const view = stack.at(-1);
  const open = (next: View, replace = false) => setStack(current => replace || !current.length ? [next] : current.at(-1)?.kind === next.kind && !("id" in next) ? current : [...current, next]);
  const back = () => setStack(current => current.slice(0, -1));
  const close = () => setStack([]);

  const source = useMemo(() => ({ projects: workspace.projects, tasks: workspace.tasks, presets: workspace.presets, threads, events }), [workspace.projects, workspace.tasks, workspace.presets, threads, events]);
  const data = useMemo<AgentNetworkSnapshot>(() => {
    const live = buildAgentNetwork(source, { runId: scopeToRun ? control.selectedRunId ?? undefined : undefined });
    return !isTauri() && !live.agents.length && !live.tasks.length && !workspace.projects.length ? demoAgentNetwork() : live;
  }, [source, scopeToRun, control.selectedRunId, workspace.projects.length]);

  const timeline = useMemo(() => {
    const times = data.tasks.map(row => row.task.createdAt).filter(Number.isFinite).sort((a, b) => a - b);
    return times.length > 1 ? { start: times[0]!, end: Math.max(times.at(-1)!, Date.now()) } : undefined;
  }, [data.tasks]);
  useEffect(() => {
    if (!playing || !timeline) return;
    const step = (timeline.end - timeline.start) / 160;
    const timer = window.setInterval(() => setCutoff(value => {
      const next = (value ?? timeline.start) + step;
      if (next >= timeline.end) { setPlaying(false); return undefined; }
      return next;
    }), 50);
    return () => window.clearInterval(timer);
  }, [playing, timeline]);

  /* The orbit re-centres into the space the panel leaves free. */
  useEffect(() => {
    const element = drawer.current;
    if (!element) { setDrawerWidth(0); return; }
    const update = () => setDrawerWidth(element.offsetWidth + 16);
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [view?.kind]);

  useEffect(() => { if (awaySince) open({ kind: "overview" }, true); }, [awaySince]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (stack.length) { event.preventDefault(); back(); } else if (focusProjectId) setFocusProjectId(undefined);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [stack.length, focusProjectId]);

  const taskById = (id: string) => data.tasks.find(row => row.task.id === id);
  const live = control.runs.filter(run => ["ready", "busy"].includes(run.info.state));
  const crashed = control.runs.filter(run => run.info.state === "crashed");
  const waitingTasks = workspace.tasks.filter(task => !task.deletedAt && (threads[task.id]?.requests.length ?? 0) > 0);
  const attention = crashed.length + waitingTasks.length + (workspace.saveError ? 1 : 0);
  const recent = workspace.tasks.filter(task => !task.archived && !task.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const myAgents = data.agents;
  const presetOf = (agent: NetworkAgent) => agent.id.startsWith("preset:") ? workspace.presets.find(preset => preset.id === agent.id.slice("preset:".length)) : undefined;
  const planet = (agent: NetworkAgent, large = false) => <i className={`ohPlanet${large ? " isLarge" : ""}`} aria-hidden="true" style={agent.color ? { ["--c" as string]: agent.color } : undefined}/>;
  const selectedAgentId = view?.kind === "agent" ? view.id : undefined;
  const openWorkspace = (taskId?: string) => { if (taskId) selectTask(taskId); control.setView("agentWorkspace"); };
  const summary = t("agentNetwork.summary", { projects: data.projects.length, tasks: data.tasks.length, agents: myAgents.length });

  const projectRows = (entry: NetworkProject) => entry.taskIds.map(taskById).filter((row): row is NetworkTask => !!row);

  const renderOverview = () => <>
    <AwayDigest/>
    {attention > 0 && <Section title={t("desk.home.attention")}>
      <ul className="ohList">
        {crashed.map(run => <li key={run.info.runId}><button type="button" className="isDanger" onClick={() => { control.selectRun(run.info.runId); control.setView("logs"); }}><CircleAlert size={15}/><span><b>{run.info.name}</b><small>{t("status.crashed")}</small></span><ChevronRight size={14}/></button></li>)}
        {waitingTasks.map(task => <li key={task.id}><button type="button" className="isWarn" onClick={() => openWorkspace(task.id)}><AlertCircle size={15}/><span><b>{task.title}</b><small>{t("aw.status.waiting")}</small></span><ChevronRight size={14}/></button></li>)}
        {workspace.saveError && <li className="ohNote">{t(`aw.error.${workspace.saveError}`)}</li>}
      </ul>
    </Section>}
    <Section title={t("desk.home.continue")} action={<button type="button" className="ohLink" onClick={() => openWorkspace()}>{t("desk.home.allTasks")}<ArrowRight size={13}/></button>}>
      {recent.length ? <ul className="ohList">{recent.map(task => <li key={task.id}><button type="button" onClick={() => open({ kind: "task", id: task.id })}>
        <Bot size={15}/><span><b>{task.title}</b><small>{workspace.projects.find(project => project.id === task.projectId)?.name} · {new Date(task.updatedAt).toLocaleDateString(i18n.language, { day: "numeric", month: "short" })}</small></span>
        <span className={`awTaskState is-${taskStatus(threads[task.id])}`}><i/>{t(`aw.status.${taskStatus(threads[task.id])}`)}</span></button></li>)}</ul>
        : <div className="ohEmpty"><FolderOpen size={20}/><p>{t("desk.home.noTasksHint")}</p><Button onClick={() => openWorkspace()}>{t("aw.openFolder")}</Button></div>}
    </Section>
    <Section title={t("desk.home.connection")} action={<span className="kMono ohCount">{live.length}</span>}>
      {live.length ? <ul className="ohList">{live.map(run => <li key={run.info.runId}><div className="ohServer">
        <span className={`kLed is-${run.info.state}`}/><span><b>{run.info.name}</b><small>{ENGINE_NAMES[run.info.engine]} · {t(`status.${run.info.state}`)}</small><code>{run.info.endpoint}/v1</code></span>
        <span className="ohServerActions">
          <button type="button" className="kIconBtn" title={t("desk.server.configure")} aria-label={t("desk.server.configure")} onClick={() => { control.selectRun(run.info.runId); control.setView("configuration"); }}><Settings2 size={14}/></button>
          <button type="button" className="kIconBtn" title={t("desk.home.connectClient")} aria-label={t("desk.home.connectClient")} onClick={() => { control.selectRun(run.info.runId); control.setView("apiDocs"); }}><Plug size={14}/></button>
          <button type="button" className="kIconBtn" title={t("k.top.copyEndpoint")} aria-label={t("k.top.copyEndpoint")} onClick={() => void navigator.clipboard.writeText(`${run.info.endpoint.replace(/\/$/, "")}/v1`).then(() => control.notify("success", t("k.top.copied")))}><Copy size={14}/></button>
        </span></div></li>)}</ul>
        : <div className="ohEmpty"><Server size={20}/><p>{t("desk.home.noServerHint")}</p><Button className="primary" onClick={() => useLaunchUi.getState().setQuickAdd(true)}><Plus size={14}/>{t("desk.server.new")}</Button></div>}
    </Section>
    <Section title={t("desk.home.projects")} action={data.projects.length > 0 ? <button type="button" className="ohLink" onClick={() => open({ kind: "projects" })}>{t("agentNetwork.openProjectCloud")}<ArrowRight size={13}/></button> : undefined}>
      {workspace.projects.length ? <ul className="ohList">{workspace.projects.slice(-4).reverse().map(project => <li key={project.id}><button type="button" onClick={() => open({ kind: "project", id: project.id })}><FolderOpen size={15}/><span><b>{project.name}</b><small title={project.path}>{project.path}</small></span><ChevronRight size={14}/></button></li>)}</ul>
        : <p className="ohNote">{t("desk.home.noProjects")}</p>}
    </Section>
  </>;

  const agentRow = (agent: NetworkAgent) => {
    const preset = presetOf(agent);
    return <li key={agent.id}><button type="button" className="ohAgentRow" onClick={() => { setEditingId(undefined); open({ kind: "agent", id: agent.id }); }}>
      {planet(agent)}<span><b>{agentDisplayName(agent, t)}</b>
        {preset ? <PresetModelBadge preset={preset}/> : <small className="presetModel"><AgentIcon runtime={agent.runtime} size={13}/><span>{agent.runtime ? t(`agentNetwork.runtime.${agent.runtime}`) : t("agentNetwork.child")}</span></small>}
      </span>
      <span className="ohAgentMeta">{agent.status !== "ready" ? <StatusTag status={agent.status}/> : <small>{t("agentNetwork.taskCount", { count: agent.taskIds.length })}</small>}</span></button></li>;
  };

  const renderAgents = () => <Section title={t("orbit.myAgents")} action={<button type="button" className="ohLink" onClick={() => { setNewDraft(undefined); open({ kind: "newAgent" }); }}>{t("presets.add")}<Plus size={13}/></button>}>
    {myAgents.length ? <ul className="ohList">{myAgents.map(agentRow)}</ul>
      : <div className="ohEmpty"><Users size={20}/><p>{t("orbit.noOwnAgents")}</p><Button className="primary" onClick={() => open({ kind: "newAgent" })}><Plus size={14}/>{t("presets.add")}</Button></div>}
  </Section>;

  const renderNewAgent = () => newDraft
    ? <AgentPresetForm key={newDraft.id} initial={newDraft} compact autoFocus onCancel={() => setNewDraft(undefined)}
        onSaved={preset => { control.notify("success", t("presets.created", { name: preset.name })); setNewDraft(undefined); open({ kind: "agent", id: `preset:${preset.id}` }, true); }}/>
    : <TemplatePicker onPick={setNewDraft}/>;

  const renderProjects = () => <Section title={t("agentNetwork.projectCloud")}>
    {data.projects.length ? <div className="ohProjectGrid">{data.projects.map(entry => <button type="button" key={entry.project.id} className="agentNetworkProjectCard" onClick={() => open({ kind: "project", id: entry.project.id })}>
      <div className="agentNetworkProjectCardTitle"><span><FolderOpen size={15}/><b>{entry.project.name}</b></span><ChevronRight size={15}/></div>
      <ProjectDotGraph tasks={projectRows(entry).map(row => ({ id: row.task.id, status: row.status }))} label={t("agentNetwork.projectGraph", { name: entry.project.name })}/>
      <span className="ohNote">{t("agentNetwork.taskCount", { count: entry.taskIds.length })} · {t("agentNetwork.agentCount", { count: entry.agentIds.length })}</span>
    </button>)}</div> : <div className="ohEmpty"><FolderOpen size={20}/><p>{t("agentNetwork.noProjectsHint")}</p><Button onClick={() => openWorkspace()}>{t("agentNetwork.openWorkspace")}</Button></div>}
  </Section>;

  const renderAgent = (id: string) => {
    const agent = data.agents.find(item => item.id === id);
    if (!agent) return <p className="ohNote">{t("agentNetwork.selectionUnavailable")}</p>;
    const tasks = agent.taskIds.map(taskById).filter((row): row is NetworkTask => !!row);
    const preset = presetOf(agent);
    if (preset && editingId === preset.id) return <>
      <div className="ohHero">{planet(agent, true)}<div><h2>{preset.name}</h2><PresetModelBadge preset={preset}/></div></div>
      <AgentPresetForm key={preset.id} initial={preset} compact onCancel={() => setEditingId(undefined)}
        onSaved={() => { setEditingId(undefined); control.notify("success", t("presets.saved")); }}
        onDeleted={() => { setEditingId(undefined); open({ kind: "agents" }, true); }}/>
    </>;
    return <>
      <div className="ohHero">{planet(agent, true)}<div><h2>{agentDisplayName(agent, t)}</h2>{preset ? <PresetModelBadge preset={preset}/> : <StatusTag status={agent.status}/>}</div></div>
      <div className="ohFacts">{agent.runtime && <span>{t("orbit.runtime")}<b>{t(`agentNetwork.runtime.${agent.runtime}`)}{agent.kind === "child" ? ` · ${t("agentNetwork.child")}` : ""}</b></span>}{preset && <span>{t("aw.io.access")}<b>{t(`aw.io.access.${preset.accessMode}`)}</b></span>}<span>{t("agentNetwork.project")}<b>{agent.projectIds.length}</b></span><span>{t("orbit.tasks")}<b>{agent.taskIds.length}</b></span></div>
      <div className="ohActions">
        {preset && <Button className="primary" onClick={() => setEditingId(preset.id)}><Pencil size={14}/>{t("presets.editAgent")}</Button>}
        {preset && <Button onClick={() => openAgentPreset(preset.id)} title={t("orbit.agentSettings")}><Settings2 size={14}/>{t("orbit.inSettings")}</Button>}
        {agent.projectIds[0] && <Button onClick={() => setFocusProjectId(agent.projectIds[0])}><Crosshair size={14}/>{t("orbit.focusProject")}</Button>}
      </div>
      {preset && <details className="ohDoc"><summary>AGENT.md</summary><div className="ohMarkdown">{preset.instructions.trim() ? <ReactMarkdown>{preset.instructions}</ReactMarkdown> : <p>{t("presets.noInstructions")}</p>}</div></details>}
      {!!agent.projectIds.length && <Section title={t("agentNetwork.projectsAssigned")}><ul className="ohList">{agent.projectIds.map(pid => data.projects.find(row => row.project.id === pid)).filter((row): row is NetworkProject => !!row).map(entry => <li key={entry.project.id}><button type="button" onClick={() => open({ kind: "project", id: entry.project.id })}><FolderOpen size={15}/><span><b>{entry.project.name}</b></span><ChevronRight size={14}/></button></li>)}</ul></Section>}
      <Section title={t("orbit.tasks")}>{tasks.length ? <ul className="ohList">{tasks.slice(0, 12).map(row => <li key={row.task.id}><button type="button" onClick={() => open({ kind: "task", id: row.task.id })}><Bot size={15}/><span><b>{row.task.title}</b><small>{row.project.name}</small></span><StatusTag status={row.status}/></button></li>)}</ul> : <p className="ohNote">{t("agentNetwork.noAssignedTasks")}</p>}</Section>
    </>;
  };

  const renderProject = (id: string) => {
    const entry = data.projects.find(row => row.project.id === id);
    if (!entry) return <p className="ohNote">{t("agentNetwork.selectionUnavailable")}</p>;
    const rows = projectRows(entry);
    const notes = workspace.memory.filter(memory => memory.projectId === id && memory.confirmed).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
    const timelineEvents = rows.flatMap(row => row.events).sort((a, b) => b.time - a.time).slice(0, 5);
    return <>
      <div className="ohHero"><FolderOpen size={26}/><div><h2>{entry.project.name}</h2><code title={entry.project.path}>{entry.project.path}</code></div></div>
      <div className="ohActions">
        <Button className={focusProjectId === id ? "primary" : ""} onClick={() => setFocusProjectId(focusProjectId === id ? undefined : id)}><Crosshair size={14}/>{t(focusProjectId === id ? "orbit.unfocus" : "orbit.focusProject")}</Button>
        <Button onClick={() => { selectProject(id); control.setView("agentWorkspace"); }}><ArrowRight size={14}/>{t("agentNetwork.openWorkspace")}</Button>
      </div>
      <Section title={t("orbit.tasks")}>{rows.length ? <ul className="ohList">{rows.map(row => <li key={row.task.id}><button type="button" onClick={() => open({ kind: "task", id: row.task.id })}><Bot size={15}/><span><b>{row.task.title}</b></span><StatusTag status={row.status}/></button></li>)}</ul> : <p className="ohNote">{t("agentNetwork.noTasksInProject")}</p>}</Section>
      {!!notes.length && <Section title={t("agentNetwork.confirmedNotes")}>{notes.map(note => <p key={note.id} className="ohNote">{note.text}</p>)}</Section>}
      {!!timelineEvents.length && <Section title={t("agentNetwork.projectEventHistory")}><ol className="ohEvents">{timelineEvents.map(event => <ActivityLine key={event.id} event={event} language={i18n.language}/>)}</ol></Section>}
    </>;
  };

  const renderTask = (id: string) => {
    const row = taskById(id);
    if (!row) return <p className="ohNote">{t("agentNetwork.selectionUnavailable")}</p>;
    const answer = [...(row.thread?.entries ?? [])].reverse().find(entry => entry.kind === "assistant" && entry.text.trim())?.text;
    const artifacts = [...new Set((row.thread?.entries ?? []).filter(entry => entry.kind === "tool" && entry.status === "success").map(entry => toolPath(entry.args, entry.result)).filter(Boolean))].slice(-5);
    const names = row.participants.map(pid => data.agents.find(agent => agent.id === pid)).filter((agent): agent is NetworkAgent => !!agent);
    return <>
      <div className="ohHero"><Bot size={26}/><div><h2>{row.task.title}</h2><StatusTag status={row.status}/></div></div>
      <div className="ohFacts"><span>{t("agentNetwork.project")}<b>{row.project.name}</b></span><span>{t("agentNetwork.updated")}<b>{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(row.task.updatedAt)}</b></span></div>
      <div className="ohActions"><Button className="primary" onClick={() => openWorkspace(row.task.id)}><ArrowRight size={14}/>{t("agentNetwork.openTask")}</Button></div>
      {row.thread?.requests.length ? <div className="agentNetworkNotice isWaiting"><CircleAlert size={15}/><span>{t("agentNetwork.pendingDecision", { count: row.thread.requests.length })}</span></div> : null}
      {row.thread?.error && <div className="agentNetworkNotice isBlocked"><CircleAlert size={15}/><span>{t("agentNetwork.taskError", { reason: t(`aw.error.${row.thread.error}`, { defaultValue: row.thread.error }) })}</span></div>}
      <Section title={t("agentNetwork.assignedAgents")}>{names.length ? <ul className="ohList">{names.map(agent => <li key={agent.id}><button type="button" onClick={() => open({ kind: "agent", id: agent.id })}><Bot size={15}/><span><b>{agentDisplayName(agent, t)}</b></span><StatusTag status={agent.status}/></button></li>)}</ul> : <p className="ohNote">{t("agentNetwork.unassigned")}</p>}</Section>
      {row.task.instructions && <Section title={t("agentNetwork.instructions")}><p className="ohText">{row.task.instructions}</p></Section>}
      {answer && <Section title={t("agentNetwork.latestResponse")}><p className="ohText">{answer.length > 1100 ? `${answer.slice(-1100)}…` : answer}</p></Section>}
      {!!artifacts.length && <Section title={t("agentNetwork.artifacts")}><ul className="ohCode">{artifacts.map(path => <li key={path}><code>{path}</code></li>)}</ul></Section>}
      <Section title={t("agentNetwork.timeline")}>{row.events.length ? <ol className="ohEvents">{row.events.slice(0, 8).map(event => <ActivityLine key={event.id} event={event} language={i18n.language}/>)}</ol> : <p className="ohNote">{t("agentNetwork.noEvents")}</p>}</Section>
    </>;
  };

  const titles: Record<View["kind"], string> = {
    overview: t("orbit.overview"), agents: t("orbit.agentsTab"), projects: t("agentNetwork.projectCloud"),
    agent: t("agentNetwork.agentDetails"), project: t("agentNetwork.projectDetails"), task: t("agentNetwork.taskDetails"), newAgent: t("presets.newAgent"),
  };
  const tabs: [View["kind"], typeof LayoutGrid, string][] = [["overview", LayoutGrid, t("orbit.overview")], ["agents", Users, t("orbit.agentsTab")], ["projects", FolderOpen, t("agentNetwork.projectCloud")]];

  return <div className={`orbitHome${view ? " hasDrawer" : ""}`}>
    <AgentOrbit variant="stage" data={data} query={query} zoom={zoom} onZoom={setZoom} resetToken={resetToken} insetRight={view ? drawerWidth : 0}
      selectedAgentId={selectedAgentId} focusProjectId={focusProjectId} cutoff={cutoff} maxAgents={40}
      onFocusProject={id => { setFocusProjectId(id); if (id) open({ kind: "project", id }); }}
      onSelectAgent={id => { setEditingId(undefined); open({ kind: "agent", id }, view?.kind === "agent"); }}
      onOpenProjects={() => open({ kind: "projects" }, true)}/>

    <header className="ohHud ohTop">
      <div className="ohTitle"><h1>{t("agentNetwork.title")}</h1><span>{summary}</span></div>
      <label className="ohSearch"><Search size={14}/><input aria-label={t("agentNetwork.searchAgents")} placeholder={t("agentNetwork.searchAgents")} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label={t("agentNetwork.clearSearch")} onClick={() => setQuery("")}><X size={12}/></button>}</label>
      <button type="button" className={`ohChip${scopeToRun ? " isOn" : ""}`} disabled={!control.selectedRunId} aria-pressed={scopeToRun} title={t("orbit.scopeHint")} onClick={() => setScopeToRun(value => !value)}><Server size={13}/>{scopeToRun ? t("agentNetwork.currentRunOnly", { name: control.runs.find(run => run.info.runId === control.selectedRunId)?.info.name ?? "" }) : t("agentNetwork.allRuns")}</button>
      {focusProjectId && <button type="button" className="ohChip isOn" onClick={() => setFocusProjectId(undefined)}>{t("orbit.focus", { name: data.projects.find(entry => entry.project.id === focusProjectId)?.project.name ?? "" })}<X size={12}/></button>}
      <nav className="ohTabs" aria-label={t("orbit.panels")}>
        {tabs.map(([kind, Icon, label]) => <button type="button" key={kind} aria-pressed={view?.kind === kind} className={view?.kind === kind ? "isOn" : ""} onClick={() => view?.kind === kind ? close() : open({ kind } as View, true)}>
          <Icon size={15}/><span>{label}</span>{kind === "overview" && attention > 0 && <i className="ohBadge">{attention}</i>}</button>)}
      </nav>
    </header>

    {!workspace.ready && isTauri() && <div className="ohHud ohLoading" role="status"><span/>{t("agentNetwork.loading")}</div>}
    {workspace.error && <div className="ohHud ohError" role="alert"><CircleAlert size={15}/>{workspace.error}</div>}

    <footer className="ohHud ohBottom">
      <AgentNetworkLegend/>
      {timeline && <div className="agentOrbitTimeline" role="group" aria-label={t("orbit.timeline")}>
        <button type="button" className="kIconBtn" aria-label={t(playing ? "orbit.pause" : "orbit.play")} title={t(playing ? "orbit.pause" : "orbit.play")} onClick={() => { if (!playing && cutoff === undefined) setCutoff(timeline.start); setPlaying(value => !value); }}>{playing ? <Pause size={14}/> : <Play size={14}/>}</button>
        <input type="range" min={timeline.start} max={timeline.end} step={(timeline.end - timeline.start) / 300 || 1} value={cutoff ?? timeline.end} aria-label={t("orbit.timeline")}
          onChange={event => { setPlaying(false); const value = Number(event.target.value); setCutoff(value >= timeline.end - 1 ? undefined : value); }}/>
        <span className="kMono">{cutoff === undefined ? t("orbit.now") : new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(cutoff)}</span>
      </div>}
      <div className="ohZoom" aria-label={t("agentNetwork.mapControls")}>
        <button type="button" className="kIconBtn" aria-label={t("agentNetwork.zoomOut")} onClick={() => setZoom(value => Math.max(0.5, Math.round(value / 1.2 * 100) / 100))}><Minus size={14}/></button>
        <span className="kMono">{Math.round(zoom * 100)}%</span>
        <button type="button" className="kIconBtn" aria-label={t("agentNetwork.zoomIn")} onClick={() => setZoom(value => Math.min(2.5, Math.round(value * 1.2 * 100) / 100))}><Plus size={14}/></button>
        <button type="button" className="kIconBtn" title={t("agentNetwork.resetView")} aria-label={t("agentNetwork.resetView")} onClick={() => { setZoom(1); setResetToken(value => value + 1); setFocusProjectId(undefined); setCutoff(undefined); setPlaying(false); }}><Crosshair size={14}/></button>
      </div>
    </footer>

    {view && <aside ref={drawer} className="ohDrawer" aria-label={titles[view.kind]} key={stack.length === 1 ? view.kind : undefined}>
      <header>
        {stack.length > 1 && <button type="button" className="kIconBtn" aria-label={t("agentNetwork.back")} title={t("agentNetwork.back")} onClick={back}><ArrowLeft size={15}/></button>}
        <h2>{titles[view.kind]}</h2>
        <button type="button" className="kIconBtn" aria-label={t("actions.close")} title={t("actions.close")} onClick={close}><X size={15}/></button>
      </header>
      <div className="ohDrawerBody" key={`${view.kind}:${"id" in view ? view.id : ""}`}>
        {view.kind === "overview" && renderOverview()}
        {view.kind === "agents" && renderAgents()}
        {view.kind === "projects" && renderProjects()}
        {view.kind === "agent" && renderAgent(view.id)}
        {view.kind === "project" && renderProject(view.id)}
        {view.kind === "task" && renderTask(view.id)}
        {view.kind === "newAgent" && renderNewAgent()}
      </div>
    </aside>}

    {!data.projects.length && (workspace.ready || !isTauri()) && !view && <div className="ohHud ohOnboard">
      <b>{t("agentNetwork.noProjects")}</b><p>{t("orbit.onboard")}</p>
      <div><Button className="primary" onClick={() => openWorkspace()}>{t("agentNetwork.openWorkspace")}</Button><Button onClick={() => open({ kind: "agents" }, true)}><Users size={14}/>{t("orbit.agentsTab")}</Button></div>
    </div>}
  </div>;
}

