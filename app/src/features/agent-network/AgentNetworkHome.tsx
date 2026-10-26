import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, ArrowRight, Bot, ChevronRight, CircleAlert, FolderOpen, Maximize2, Minus, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useActivityStore } from "../activity/store";
import type { ActivityEvent } from "../activity/model";
import { useAgentStore } from "../agent/store";
import { selectTask, useWorkspaceStore } from "../agent/workspace";
import { toolPath } from "../agent/workspaceModel";
import { useControlStore } from "../../store/control";
import { Button } from "../../components/ui/Primitives";
import { buildAgentNetwork, type AgentNetworkSnapshot, type NetworkAgent, type NetworkLink, type NetworkProject, type NetworkStatus, type NetworkTask } from "./model";
import { AgentNetworkGraph, AgentNetworkLegend, ProjectDotGraph, agentDisplayName, type NetworkHover } from "./AgentNetworkGraph";
import "./AgentNetwork.css";

type DetailLevel = "network" | "projects" | "project" | "task";
type Selection = { kind: "agent" | "link"; id: string } | null;
const SCOPE_STORAGE_KEY = "aplot.homeAgentNetwork.enabled";
const NETWORK_PAGE_SIZE = 20;
const PROJECT_PAGE_SIZE = 24;
const TASK_PAGE_SIZE = 20;

function readEnabled() {
  try { return localStorage.getItem(SCOPE_STORAGE_KEY) !== "false"; } catch { return true; }
}

function setEnabledPreference(value: boolean) {
  try { localStorage.setItem(SCOPE_STORAGE_KEY, String(value)); } catch { /* Keep the preference for this session. */ }
}

function StatusTag({ status }: { status: NetworkStatus }) {
  const { t } = useTranslation();
  return <span className={`agentNetworkStatus state-${status}`}><i aria-hidden="true" />{t(`agentNetwork.status.${status}`)}</span>;
}

function Pager({ page, pageCount, onChange, label }: { page: number; pageCount: number; onChange: (page: number) => void; label: string }) {
  const { t } = useTranslation();
  if (pageCount < 2) return null;
  return <nav className="agentNetworkPager" aria-label={label}>
    <button type="button" aria-label={t("agentNetwork.previousPage")} disabled={page <= 0} onClick={() => onChange(page - 1)}><ArrowLeft size={14} /></button>
    <span>{t("agentNetwork.pageOf", { page: page + 1, total: pageCount })}</span>
    <button type="button" aria-label={t("agentNetwork.nextPage")} disabled={page + 1 >= pageCount} onClick={() => onChange(page + 1)}><ArrowRight size={14} /></button>
  </nav>;
}

function DetailPanel({ title, children, empty }: { title: string; children: ReactNode; empty?: boolean }) {
  return <aside className={`agentNetworkInspector${empty ? " isEmpty" : ""}`} aria-label={title}>
    <header><h3>{title}</h3></header>
    {children}
  </aside>;
}

function ActivityLine({ event, language }: { event: ActivityEvent; language: string }) {
  const { t } = useTranslation();
  const detail = [event.data.agent, event.data.outcome, event.data.message].find(value => typeof value === "string") as string | undefined;
  return <li className={`agentNetworkEvent level-${event.level}`}>
    <i aria-hidden="true" />
    <div><b>{t(`agentNetwork.event.${event.kind}`, { defaultValue: event.kind })}</b>{detail && <span>{detail}</span>}<time dateTime={new Date(event.time).toISOString()}>{new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(event.time)}</time></div>
  </li>;
}

function ProjectStats({ entry, data }: { entry: NetworkProject; data: AgentNetworkSnapshot }) {
  const { t } = useTranslation();
  const rows = entry.taskIds.map(id => data.tasks.find(row => row.task.id === id)).filter((row): row is NetworkTask => !!row);
  const running = rows.filter(row => row.status === "running").length;
  const waiting = rows.filter(row => row.status === "waiting" || row.status === "blocked").length;
  const participants = new Set([...rows.flatMap(row => row.participants), ...entry.agentIds]);
  return <div className="agentNetworkProjectStats">
    <span>{t("agentNetwork.taskCount", { count: rows.length })}</span>
    {running > 0 && <span className="state-running">{t("agentNetwork.runningCount", { count: running })}</span>}
    {waiting > 0 && <span className="state-waiting">{t("agentNetwork.attentionCount", { count: waiting })}</span>}
    <span>{t("agentNetwork.agentCount", { count: participants.size })}</span>
  </div>;
}

function ProjectCard({ entry, data, onOpen }: { entry: NetworkProject; data: AgentNetworkSnapshot; onOpen: () => void }) {
  const { t } = useTranslation();
  const tasks = entry.taskIds.map(id => data.tasks.find(row => row.task.id === id)).filter((row): row is NetworkTask => !!row);
  return <button type="button" className="agentNetworkProjectCard" onClick={onOpen}>
    <div className="agentNetworkProjectCardTitle"><span><FolderOpen size={15} /><b>{entry.project.name}</b></span><ChevronRight size={15} /></div>
    <ProjectDotGraph tasks={tasks.map(row => ({ id: row.task.id, status: row.status }))} label={t("agentNetwork.projectGraph", { name: entry.project.name })} />
    <ProjectStats entry={entry} data={data} />
  </button>;
}

function taskAgentNames(task: NetworkTask, data: AgentNetworkSnapshot, t: (key: string) => string) {
  return task.participants.map(id => data.agents.find(agent => agent.id === id)).filter((agent): agent is NetworkAgent => !!agent).map(agent => agentDisplayName(agent, t));
}

export function AgentNetworkHome() {
  const { t, i18n } = useTranslation();
  const workspace = useWorkspaceStore();
  const threads = useAgentStore(state => state.threads);
  const events = useActivityStore(state => state.events);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const runs = useControlStore(state => state.runs);
  const selectedRun = runs.find(run => run.info.runId === selectedRunId);

  const [enabled, setEnabled] = useState(readEnabled);
  const [scopeToRun, setScopeToRun] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [level, setLevel] = useState<DetailLevel>("network");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<NetworkHover>(null);
  const [query, setQuery] = useState("");
  const [agentPage, setAgentPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusBeforeOpen = useRef<HTMLElement | SVGElement | null>(null);
  const source = useMemo(() => ({ projects: workspace.projects, tasks: workspace.tasks, presets: workspace.presets, threads, events }), [workspace.projects, workspace.tasks, workspace.presets, threads, events]);
  const data = useMemo(() => buildAgentNetwork(source, { runId: scopeToRun ? selectedRunId ?? undefined : undefined }), [source, scopeToRun, selectedRunId]);

  useEffect(() => { setEnabledPreference(enabled); }, [enabled]);

  useEffect(() => {
    if (!expanded) {
      focusBeforeOpen.current?.focus();
      focusBeforeOpen.current = null;
      return;
    }
    if (!focusBeforeOpen.current) {
      focusBeforeOpen.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null;
    }
    requestAnimationFrame(() => closeButton.current?.focus());
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (level === "task") setLevel("project");
        else if (level === "project") setLevel("projects");
        else if (level === "projects") setLevel("network");
        else setExpanded(false);
      }
      if (event.key === "Tab" && dialog.current) {
        const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement | SVGElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
          .filter(element => element.getClientRects().length > 0);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [expanded, level]);

  const taskById = (id: string) => data.tasks.find(row => row.task.id === id);
  const projectEntry = data.projects.find(entry => entry.project.id === selectedProjectId);
  const selectedTask = taskById(selectedTaskId);
  const selectedAgent = selection?.kind === "agent" ? data.agents.find(agent => agent.id === selection.id) : undefined;
  const selectedLink = selection?.kind === "link" ? data.links.find(link => link.id === selection.id) : undefined;
  const selectedAgentTasks = selectedAgent?.taskIds.map(taskById).filter((row): row is NetworkTask => !!row) ?? [];
  const linkTasks = selectedLink?.taskIds.map(taskById).filter((row): row is NetworkTask => !!row) ?? [];
  const projectRows = projectEntry?.taskIds.map(taskById).filter((row): row is NetworkTask => !!row) ?? [];
  const taskPageCount = Math.max(1, Math.ceil(projectRows.length / TASK_PAGE_SIZE));
  const visibleProjectTasks = projectRows.slice(taskPage * TASK_PAGE_SIZE, (taskPage + 1) * TASK_PAGE_SIZE);
  const filteredProjects = data.projects.filter(entry => entry.project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const projectPageCount = Math.max(1, Math.ceil(filteredProjects.length / PROJECT_PAGE_SIZE));
  const visibleProjects = filteredProjects.slice(projectPage * PROJECT_PAGE_SIZE, (projectPage + 1) * PROJECT_PAGE_SIZE);
  const agentPageCount = Math.max(1, Math.ceil(data.agents.length / NETWORK_PAGE_SIZE));
  const hoverAgent = hover?.kind === "agent" ? data.agents.find(agent => agent.id === hover.id) : undefined;
  const hoverLink = hover?.kind === "link" ? data.links.find(link => link.id === hover.id) : undefined;

  const showNetwork = () => {
    focusBeforeOpen.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null;
    setLevel("network"); setExpanded(true); setHover(null);
  };
  const showProjects = () => {
    focusBeforeOpen.current = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null;
    setLevel("projects"); setExpanded(true); setHover(null); setProjectPage(0); setQuery("");
  };
  const openProject = (id: string) => { setSelectedProjectId(id); setSelectedTaskId(""); setTaskPage(0); setLevel("project"); setQuery(""); };
  const openTaskDetails = (id: string) => { const row = taskById(id); if (!row) return; setSelectedProjectId(row.project.id); setSelectedTaskId(id); setSelection(null); setLevel("task"); };
  const openWorkspaceTask = (id: string) => {
    if (!taskById(id)) return;
    selectTask(id);
    useControlStore.getState().setView("agentWorkspace");
    setExpanded(false);
  };
  const openAgentWorkspace = () => useControlStore.getState().setView("agentWorkspace");
  const changeQuery = (value: string) => {
    setQuery(value);
    if (level === "network" && value.trim()) {
      const needle = value.trim().toLocaleLowerCase();
      const index = data.agents.findIndex(agent => {
        const name = agentDisplayName(agent, t).toLocaleLowerCase();
        return name.includes(needle) || agent.taskIds.some(id => taskById(id)?.task.title.toLocaleLowerCase().includes(needle));
      });
      if (index >= 0) setAgentPage(Math.floor(index / NETWORK_PAGE_SIZE));
    }
    if (level === "projects") setProjectPage(0);
  };
  const navigateBack = () => {
    if (level === "task") setLevel("project");
    else if (level === "project") setLevel("projects");
    else if (level === "projects") setLevel("network");
    else setExpanded(false);
  };
  const toggleEnabled = () => setEnabled(value => !value);
  const scopeLabel = selectedRun ? t("agentNetwork.currentRun", { name: selectedRun.info.name }) : t("agentNetwork.noCurrentRun");

  const renderHover = () => {
    if (hoverAgent) {
      const tasks = hoverAgent.taskIds.map(taskById).filter((row): row is NetworkTask => !!row).slice(0, 3);
      return <div className="agentNetworkHoverCard" role="tooltip"><b>{agentDisplayName(hoverAgent, t)}</b><StatusTag status={hoverAgent.status} /><span>{t("agentNetwork.taskCount", { count: hoverAgent.taskIds.length })}</span>{tasks.map(row => <small key={row.task.id}>{row.task.title} · {t(`agentNetwork.status.${row.status}`)}</small>)}</div>;
    }
    if (hoverLink) {
      const first = data.agents.find(agent => agent.id === hoverLink.agentIds[0]);
      const second = data.agents.find(agent => agent.id === hoverLink.agentIds[1]);
      const tasks = hoverLink.taskIds.map(taskById).filter((row): row is NetworkTask => !!row);
      return <div className="agentNetworkHoverCard" role="tooltip"><b>{t("agentNetwork.sharedTasksTitle", { first: first ? agentDisplayName(first, t) : "", second: second ? agentDisplayName(second, t) : "" })}</b>{tasks.map(row => <small key={row.task.id}>{row.task.title} · {t(`agentNetwork.status.${row.status}`)}</small>)}</div>;
    }
    return null;
  };

  const renderAgentInspector = (agent: NetworkAgent) => <DetailPanel title={t("agentNetwork.agentDetails")}>
    <div className="agentNetworkInspectorBody"><div className="agentNetworkEntityTitle"><Bot size={17} /><div><b>{agentDisplayName(agent, t)}</b><StatusTag status={agent.status} /></div></div>
      {agent.runtime && <p className="agentNetworkMuted">{t(`agentNetwork.runtime.${agent.runtime}`)}{agent.kind === "child" ? ` · ${t("agentNetwork.child")}` : ""}</p>}
      <p className="agentNetworkMuted">{t("agentNetwork.agentProjectsAndTasks", { projects: agent.projectIds.length, tasks: agent.taskIds.length })}</p>
      {!!agent.projectIds.length && <section className="agentNetworkProjectNotes"><h4>{t("agentNetwork.projectsAssigned")}</h4>{agent.projectIds.map(id=>data.projects.find(row=>row.project.id===id)?.project).filter((project):project is NonNullable<typeof project>=>!!project).map(project=><p key={project.id}>{project.name}</p>)}</section>}
      <ul className="agentNetworkTaskLinks">{selectedAgentTasks.slice(0, 8).map(row => <li key={row.task.id}><button type="button" onClick={() => openTaskDetails(row.task.id)}><span>{row.task.title}</span><StatusTag status={row.status} /></button></li>)}</ul>
      {selectedAgentTasks.length > 8 && <p className="agentNetworkMuted">{t("agentNetwork.moreTasks", { count: selectedAgentTasks.length - 8 })}</p>}
    </div>
  </DetailPanel>;

  const renderLinkInspector = (link: NetworkLink) => {
    const first = data.agents.find(agent => agent.id === link.agentIds[0]);
    const second = data.agents.find(agent => agent.id === link.agentIds[1]);
    return <DetailPanel title={t("agentNetwork.linkDetails")}>
      <div className="agentNetworkInspectorBody"><p className="agentNetworkLinkNames">{first ? agentDisplayName(first, t) : ""}<span>↔</span>{second ? agentDisplayName(second, t) : ""}</p>
        <p className="agentNetworkMuted">{t("agentNetwork.sharedTaskEvidence", { count: linkTasks.length })}</p>
        <ul className="agentNetworkTaskLinks">{linkTasks.map(row => <li key={row.task.id}><button type="button" onClick={() => openTaskDetails(row.task.id)}><span>{row.task.title}</span><StatusTag status={row.status} /></button></li>)}</ul>
      </div>
    </DetailPanel>;
  };

  const renderProjectInspector = (entry: NetworkProject) => <DetailPanel title={t("agentNetwork.projectDetails")}>
    <div className="agentNetworkInspectorBody"><div className="agentNetworkEntityTitle"><FolderOpen size={17} /><b>{entry.project.name}</b></div>
      <code className="agentNetworkPath" title={entry.project.path}>{entry.project.path}</code>
      <ProjectStats entry={entry} data={data} />
      {!!entry.agentIds.length && <section className="agentNetworkProjectEvents"><h4>{t("agentNetwork.projectAgents")}</h4><ul className="agentNetworkTaskLinks">{entry.agentIds.map(id=>data.agents.find(agent=>agent.id===id)).filter((agent):agent is NetworkAgent=>!!agent).map(agent=><li key={agent.id}><button type="button" onClick={()=>{setSelection({kind:"agent",id:agent.id});setLevel("network");}}><span>{agentDisplayName(agent,t)}</span><StatusTag status={agent.status}/></button></li>)}</ul></section>}
      {entry.project.skills && <p className="agentNetworkProjectSkills">{t("agentNetwork.projectSkills")}: {entry.project.skills}</p>}
      {(() => {
        const notes = workspace.memory.filter(memory => memory.projectId === entry.project.id && memory.confirmed).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
        return notes.length ? <section className="agentNetworkProjectNotes"><h4>{t("agentNetwork.confirmedNotes")}</h4>{notes.map(note => <p key={note.id}>{note.text}</p>)}</section> : null;
      })()}
      {(() => {
        const timeline = entry.taskIds.flatMap(id => taskById(id)?.events ?? []).sort((a, b) => b.time - a.time).slice(0, 5);
        return timeline.length ? <section className="agentNetworkProjectEvents"><h4>{t("agentNetwork.projectEventHistory")}</h4><ol>{timeline.map(event => <ActivityLine key={event.id} event={event} language={i18n.language} />)}</ol></section> : null;
      })()}
    </div>
  </DetailPanel>;

  const renderTaskDetails = (row: NetworkTask) => {
    const answer = [...(row.thread?.entries ?? [])].reverse().find(entry => entry.kind === "assistant" && entry.text.trim())?.text;
    const artifacts = [...new Set((row.thread?.entries ?? []).filter(entry => entry.kind === "tool" && entry.status === "success").map(entry => toolPath(entry.args, entry.result)).filter(Boolean))].slice(-5);
    const timeline = row.events.slice(0, 8);
    return <div className="agentNetworkTaskDetail">
      <section className="agentNetworkTaskSummary"><div className="agentNetworkTaskTitle"><span><Bot size={17} /></span><div><h2>{row.task.title}</h2><StatusTag status={row.status} /></div></div>
        <dl><div><dt>{t("agentNetwork.project")}</dt><dd>{row.project.name}</dd></div><div><dt>{t("agentNetwork.assignedAgents")}</dt><dd>{taskAgentNames(row, data, t).join(", ") || t("agentNetwork.unassigned")}</dd></div><div><dt>{t("agentNetwork.updated")}</dt><dd>{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(row.task.updatedAt)}</dd></div></dl>
        {row.task.binding && <p className="agentNetworkMuted">{t("agentNetwork.boundRun", { name: row.task.binding.name })} · {row.task.binding.modelId}</p>}
        {row.thread?.requests.length ? <div className="agentNetworkNotice isWaiting"><CircleAlert size={15} /><span>{t("agentNetwork.pendingDecision", { count: row.thread.requests.length })}</span></div> : null}
        {row.thread?.error && <div className="agentNetworkNotice isBlocked"><CircleAlert size={15} /><span>{t("agentNetwork.taskError", { reason: t(`aw.error.${row.thread.error}`, { defaultValue: row.thread.error }) })}</span></div>}
        {row.task.instructions && <section className="agentNetworkFact"><h3>{t("agentNetwork.instructions")}</h3><p>{row.task.instructions}</p></section>}
        {answer && <section className="agentNetworkFact"><h3>{t("agentNetwork.latestResponse")}</h3><p>{answer.length > 1100 ? `${answer.slice(-1100)}…` : answer}</p></section>}
        {!!artifacts.length && <section className="agentNetworkFact"><h3>{t("agentNetwork.artifacts")}</h3><ul>{artifacts.map(path => <li key={path}><code>{path}</code></li>)}</ul><p>{t("agentNetwork.openWorkspaceForArtifacts")}</p></section>}
        <Button className="primary agentNetworkOpenTask" onClick={() => openWorkspaceTask(row.task.id)}><ArrowRight size={15} />{t("agentNetwork.openTask")}</Button>
      </section>
      <section className="agentNetworkTimeline"><h3>{t("agentNetwork.timeline")}</h3>{timeline.length ? <ol>{timeline.map(event => <ActivityLine key={event.id} event={event} language={i18n.language} />)}</ol> : <p className="agentNetworkMuted">{t("agentNetwork.noEvents")}</p>}</section>
    </div>;
  };

  const renderLevel = () => {
    if (level === "network") {
      const matching = selection?.kind === "agent" ? selectedAgent : undefined;
      const link = selection?.kind === "link" ? selectedLink : undefined;
      return <div className="agentNetworkNetworkLayout">
        <section className="agentNetworkStageColumn">
          <div className="agentNetworkStageHeader"><div><h2>{t("agentNetwork.networkTitle")}</h2><p>{t("agentNetwork.networkHelp")}</p></div>
            <div className="agentNetworkSearch"><Search size={14} /><input aria-label={t("agentNetwork.searchAgents")} placeholder={t("agentNetwork.searchAgents")} value={query} onChange={event => changeQuery(event.target.value)} /><button type="button" aria-label={t("agentNetwork.clearSearch")} disabled={!query} onClick={() => changeQuery("")}><X size={13} /></button></div>
          </div>
          <div className="agentNetworkStageMap"><AgentNetworkGraph data={data} page={agentPage} pageSize={NETWORK_PAGE_SIZE} query={query} selectedAgentId={selection?.kind === "agent" ? selection.id : undefined} selectedLinkId={selection?.kind === "link" ? selection.id : undefined} zoom={zoom} pan={pan} onZoomPan={setPan} onSelectAgent={id => setSelection({ kind: "agent", id })} onSelectLink={id => setSelection({ kind: "link", id })} onOpenProjects={() => setLevel("projects")} onHover={setHover} />{renderHover()}</div>
          <div className="agentNetworkStageTools"><Pager page={agentPage} pageCount={agentPageCount} onChange={setAgentPage} label={t("agentNetwork.agentPages")} /><div className="agentNetworkZoom" aria-label={t("agentNetwork.mapControls")}><button type="button" aria-label={t("agentNetwork.zoomOut")} onClick={() => setZoom(value => Math.max(.7, Math.round((value - .15) * 100) / 100))}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label={t("agentNetwork.zoomIn")} onClick={() => setZoom(value => Math.min(1.6, Math.round((value + .15) * 100) / 100))}><Plus size={14} /></button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{t("agentNetwork.resetView")}</button></div></div>
          <AgentNetworkLegend />
        </section>
        {matching ? renderAgentInspector(matching) : link ? renderLinkInspector(link) : <DetailPanel title={t("agentNetwork.inspectorTitle")} empty><p>{t("agentNetwork.selectNodeHint")}</p><Button onClick={() => setLevel("projects")}><FolderOpen size={14} />{t("agentNetwork.openProjectCloud")}</Button></DetailPanel>}
      </div>;
    }

    if (level === "projects") {
      return <div className="agentNetworkCloudView"><div className="agentNetworkCloudHeader"><div><h2>{t("agentNetwork.projectCloud")}</h2><p>{t("agentNetwork.projectCloudHint")}</p></div><div className="agentNetworkSearch"><Search size={14} /><input aria-label={t("agentNetwork.searchProjects")} placeholder={t("agentNetwork.searchProjects")} value={query} onChange={event => changeQuery(event.target.value)} /><button type="button" aria-label={t("agentNetwork.clearSearch")} disabled={!query} onClick={() => changeQuery("")}><X size={13} /></button></div></div>
        {visibleProjects.length ? <div className="agentNetworkProjectGrid">{visibleProjects.map(entry => <ProjectCard key={entry.project.id} entry={entry} data={data} onOpen={() => openProject(entry.project.id)} />)}</div> : <div className="agentNetworkEmpty"><FolderOpen size={24} /><b>{t(query ? "agentNetwork.noProjectMatches" : scopeToRun && workspace.projects.length ? "agentNetwork.noTasksForRun" : "agentNetwork.noProjects")}</b><p>{t(query ? "agentNetwork.noProjectMatchesHint" : scopeToRun && workspace.projects.length ? "agentNetwork.noTasksForRunHint" : "agentNetwork.noProjectsHint")}</p></div>}
        <Pager page={projectPage} pageCount={projectPageCount} onChange={setProjectPage} label={t("agentNetwork.projectPages")} />
      </div>;
    }

    if (level === "project" && projectEntry) {
      return <div className="agentNetworkProjectView"><section className="agentNetworkProjectWork"><header className="agentNetworkProjectHeading"><div><h2><FolderOpen size={18} />{projectEntry.project.name}</h2><code title={projectEntry.project.path}>{projectEntry.project.path}</code></div><ProjectStats entry={projectEntry} data={data} /></header>
        {visibleProjectTasks.length ? <div className="agentNetworkTaskList">{visibleProjectTasks.map(row => <button type="button" className="agentNetworkTaskCard" key={row.task.id} onClick={() => openTaskDetails(row.task.id)}><span className={`agentNetworkTaskMark state-${row.status}`} /><span className="agentNetworkTaskCardMain"><b>{row.task.title}</b><small>{taskAgentNames(row, data, t).join(", ") || t("agentNetwork.unassigned")}</small></span><StatusTag status={row.status} /><ChevronRight size={14} /></button>)}</div> : <div className="agentNetworkEmpty"><Bot size={24} /><b>{t("agentNetwork.noTasks")}</b><p>{t("agentNetwork.noTasksInProject")}</p></div>}
        <Pager page={taskPage} pageCount={taskPageCount} onChange={setTaskPage} label={t("agentNetwork.taskPages")} />
      </section>
      {renderProjectInspector(projectEntry)}</div>;
    }

    if (level === "task" && selectedTask) {
      return <div className="agentNetworkTaskView">{renderTaskDetails(selectedTask)}</div>;
    }

    return <div className="agentNetworkEmpty"><CircleAlert size={24} /><b>{t("agentNetwork.selectionUnavailable")}</b><Button onClick={() => setLevel("projects")}>{t("agentNetwork.projectCloud")}</Button></div>;
  };

  const currentSelectionStatus = selectedAgent?.status;
  const miniAgents = data.agents.slice(0, 8);

  return <>
    {!enabled ? <section className="agentNetworkDisabled deskHomePanel"><span><Activity size={15} />{t("agentNetwork.hidden")}</span><Button onClick={toggleEnabled}>{t("agentNetwork.show")}</Button></section> : <section className="agentNetworkCard deskHomePanel">
      <header className="agentNetworkCardHeader"><div><div className="agentNetworkTitleLine"><h2>{t("agentNetwork.title")}</h2><span className="agentNetworkSourceTag"><i />{t("agentNetwork.liveSource")}</span></div><p>{t("agentNetwork.subtitle")}</p></div>
        <div className="agentNetworkCardActions"><button type="button" className={`agentNetworkScope${scopeToRun ? " isOn" : ""}`} disabled={!selectedRunId} aria-pressed={scopeToRun} title={scopeLabel} onClick={() => setScopeToRun(value => !value)}>{scopeToRun ? t("agentNetwork.currentRunOnly", { name: selectedRun?.info.name ?? "" }) : t("agentNetwork.allRuns")}</button><button type="button" className="agentNetworkIconButton" aria-label={t("agentNetwork.expandNetwork")} title={t("agentNetwork.expandNetwork")} onClick={showNetwork}><Maximize2 size={14} /></button><button type="button" className="agentNetworkIconButton" aria-label={t("agentNetwork.hide")} title={t("agentNetwork.hide")} onClick={toggleEnabled}><X size={14} /></button></div>
      </header>
      {workspace.error ? <div className="agentNetworkEmpty isError" role="alert"><CircleAlert size={22} /><b>{t(workspace.error.toLowerCase().includes("permission") ? "agentNetwork.noPermission" : "agentNetwork.loadError")}</b><p>{workspace.error}</p></div> : !workspace.ready ? <div className="agentNetworkLoading" role="status"><span />{t("agentNetwork.loading")}</div> : <>
         {!data.agents.length && !data.tasks.length ? <div className="agentNetworkEmpty"><FolderOpen size={24} /><b>{t(scopeToRun && workspace.tasks.length ? "agentNetwork.noTasksForRun" : data.projects.length ? "agentNetwork.noTasks" : "agentNetwork.noProjects")}</b><p>{t(scopeToRun && workspace.tasks.length ? "agentNetwork.noTasksForRunHint" : data.projects.length ? "agentNetwork.noTasksHint" : "agentNetwork.noProjectsHint")}</p><Button onClick={data.projects.length ? showProjects : openAgentWorkspace}>{t(data.projects.length ? "agentNetwork.projectCloud" : "agentNetwork.openWorkspace")}</Button></div> : <>
          <div className="agentNetworkMiniMap"><AgentNetworkGraph data={data} compact query="" selectedAgentId={selection?.kind === "agent" ? selection.id : undefined} onSelectAgent={id => { setSelection({ kind: "agent", id }); setHover(null); }} onSelectLink={id => { setSelection({ kind: "link", id }); showNetwork(); }} onOpenProjects={showProjects} onHover={setHover} />{renderHover()}</div>
          <div className="agentNetworkCardFooter"><AgentNetworkLegend /><span>{t("agentNetwork.summary", { projects: data.projects.length, tasks: data.tasks.length, agents: data.agents.length })}</span><button type="button" onClick={showProjects}>{t("agentNetwork.openProjectCloud")}<ArrowRight size={14} /></button></div>
          {selection?.kind === "agent" && selectedAgent && <div className="agentNetworkCompactSelection"><div><Bot size={16} /><b>{agentDisplayName(selectedAgent, t)}</b><StatusTag status={currentSelectionStatus!} /><span>{t("agentNetwork.taskCount", { count: selectedAgent.taskIds.length })}</span></div><p>{selectedAgentTasks[0]?.task.title ?? t("agentNetwork.noAssignedTasks")}</p><button type="button" onClick={showNetwork}>{t("agentNetwork.inspectAgent")}<ArrowRight size={13} /></button></div>}
        </>}
      </>}
      <button type="button" className="agentNetworkOptions" onClick={showNetwork}>{t("agentNetwork.viewMapDetails")}</button>
    </section>}

    {expanded && <div className="agentNetworkOverlay">
      <div ref={dialog} className={`agentNetworkDialog level-${level}`} role="dialog" aria-modal="true" aria-labelledby="agent-network-dialog-title" tabIndex={-1}>
        <header className="agentNetworkDialogHeader"><div className="agentNetworkBreadcrumbs" aria-label={t("agentNetwork.breadcrumbs")}>
          <button type="button" onClick={() => setExpanded(false)}>{t("nav.dashboard")}</button><ChevronRight size={13} />
          <button type="button" className={level === "network" ? "isCurrent" : ""} onClick={() => setLevel("network")}>{t("agentNetwork.networkTitle")}</button>
          {level !== "network" && <><ChevronRight size={13} /><button type="button" className={level === "projects" ? "isCurrent" : ""} onClick={() => setLevel("projects")}>{t("agentNetwork.projectCloud")}</button></>}
          {(level === "project" || level === "task") && projectEntry && <><ChevronRight size={13} /><button type="button" className={level === "project" ? "isCurrent" : ""} onClick={() => setLevel("project")}>{projectEntry.project.name}</button></>}
          {level === "task" && selectedTask && <><ChevronRight size={13} /><span className="isCurrent">{selectedTask.task.title}</span></>}
        </div><div className="agentNetworkDialogActions"><span id="agent-network-dialog-title">{level === "network" ? t("agentNetwork.networkTitle") : level === "projects" ? t("agentNetwork.projectCloud") : level === "project" ? t("agentNetwork.projectDetails") : t("agentNetwork.taskDetails")}</span><button type="button" className={`agentNetworkScope${scopeToRun ? " isOn" : ""}`} disabled={!selectedRunId} aria-pressed={scopeToRun} title={scopeLabel} onClick={() => setScopeToRun(value => !value)}>{scopeToRun ? t("agentNetwork.currentRunOnly", { name: selectedRun?.info.name ?? "" }) : t("agentNetwork.allRuns")}</button><button type="button" onClick={navigateBack} aria-label={t("agentNetwork.back")}><ArrowLeft size={14} />{t("agentNetwork.back")}</button><button ref={closeButton} type="button" className="agentNetworkClose" onClick={() => setExpanded(false)} aria-label={t("actions.close")}><X size={16} /></button></div></header>
        <main className="agentNetworkDialogContent">{renderLevel()}</main>
      </div>
    </div>}
  </>;
}
