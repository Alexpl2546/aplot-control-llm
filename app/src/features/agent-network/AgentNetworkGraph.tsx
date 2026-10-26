import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AgentNetworkSnapshot, NetworkAgent, NetworkLink, NetworkStatus } from "./model";

export type NetworkHover = { kind: "agent" | "link"; id: string } | null;

interface NetworkGraphProps {
  data: AgentNetworkSnapshot;
  compact?: boolean;
  page?: number;
  pageSize?: number;
  query?: string;
  selectedAgentId?: string;
  selectedLinkId?: string;
  zoom?: number;
  pan?: { x: number; y: number };
  onZoomPan?: (pan: { x: number; y: number }) => void;
  onSelectAgent: (id: string) => void;
  onSelectLink: (id: string) => void;
  onOpenProjects: () => void;
  onHover: (target: NetworkHover) => void;
}

const STATUS_ORDER: NetworkStatus[] = ["running", "waiting", "blocked", "completed", "stopped", "inactive", "ready"];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function pointOnRing(index: number, count: number, radiusX: number, radiusY: number, cx: number, cy: number) {
  const angle = -Math.PI / 2 + Math.PI * 2 * index / Math.max(count, 1);
  return { x: cx + Math.cos(angle) * radiusX, y: cy + Math.sin(angle) * radiusY };
}

function taskPoint(index: number, count: number, radius: number, cx: number, cy: number) {
  const distance = radius * Math.sqrt((index + 0.5) / Math.max(count, 1));
  const angle = index * GOLDEN_ANGLE;
  return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance };
}

function shortLabel(value: string, max = 18) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function agentLabel(agent: NetworkAgent, t: (key: string) => string) {
  if (agent.name) return agent.name;
  if (agent.runtime) return t(`agentNetwork.runtime.${agent.runtime}`);
  return agent.kind === "child" ? t("agentNetwork.child") : t("agentNetwork.unknownAgent");
}

function activate(event: React.KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

export function AgentNetworkGraph({
  data,
  compact = false,
  page = 0,
  pageSize,
  query = "",
  selectedAgentId,
  selectedLinkId,
  zoom = 1,
  pan = { x: 0, y: 0 },
  onZoomPan,
  onSelectAgent,
  onSelectLink,
  onOpenProjects,
  onHover,
}: NetworkGraphProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [compactSize, setCompactSize] = useState({ width: 720, height: 214 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const width = compact ? compactSize.width : 1200;
  const height = compact ? compactSize.height : 560;
  const cx = width / 2;
  const cy = compact ? height / 2 : 278;
  const hubRadius = compact ? Math.min(46, height * 0.22) : 70;
  const maxAgents = pageSize ?? (compact ? 8 : 20);
  const start = page * maxAgents;
  const agents = data.agents.slice(start, start + maxAgents);
  const positions = new Map(agents.map((agent, index) => [agent.id, pointOnRing(index, agents.length, compact ? width * 0.42 : 440, compact ? height * 0.34 : 196, cx, cy)]));
  const projectsByTask = new Set(data.tasks.map(row => row.task.id));
  const hubDots = data.tasks.slice(0, compact ? 65 : 110);
  const matchingAgentIds = new Set(data.agents.filter(agent => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return false;
    if (agentLabel(agent, t).toLocaleLowerCase().includes(needle)) return true;
    return agent.taskIds.some(id => data.tasks.find(row => row.task.id === id)?.task.title.toLocaleLowerCase().includes(needle));
  }).map(agent => agent.id));

  useEffect(() => {
    if (!compact || !svgRef.current) return;
    const svg = svgRef.current;
    const update = () => {
      const bounds = svg.getBoundingClientRect();
      setCompactSize(current => Math.abs(current.width - bounds.width) < 1 && Math.abs(current.height - bounds.height) < 1
        ? current
        : { width: Math.max(320, bounds.width), height: Math.max(160, bounds.height) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    update();
    return () => observer.disconnect();
  }, [compact]);

  const setPanFrame = () => {
    frame.current = null;
    if (pending.current) onZoomPan?.(pending.current);
  };

  const beginPan = (event: ReactPointerEvent<SVGRectElement>) => {
    if (compact || !onZoomPan || event.button !== 0 || !svgRef.current) return;
    event.preventDefault();
    svgRef.current.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
  };

  const movePan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const startPoint = drag.current;
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!startPoint || !bounds || !onZoomPan) return;
    pending.current = {
      x: Math.max(-width * 0.32, Math.min(width * 0.32, startPoint.originX + (event.clientX - startPoint.x) * width / bounds.width)),
      y: Math.max(-height * 0.32, Math.min(height * 0.32, startPoint.originY + (event.clientY - startPoint.y) * height / bounds.height)),
    };
    if (frame.current === null) frame.current = requestAnimationFrame(setPanFrame);
  };

  const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    movePan(event);
    drag.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
      setPanFrame();
    }
  };

  return <svg
    ref={svgRef}
    className={`agentNetworkGraph${compact ? " isCompact" : " isDetailed"}${drag.current ? " isPanning" : ""}`}
    viewBox={`0 0 ${width} ${height}`}
    preserveAspectRatio="xMidYMid meet"
    role="group"
    aria-label={t("agentNetwork.graphLabel")}
    onPointerMove={movePan}
    onPointerUp={endPan}
    onPointerCancel={endPan}
    onLostPointerCapture={() => { drag.current = null; }}
  >
    <rect className="agentNetworkPanSurface" x="0" y="0" width={width} height={height} data-pan-surface="true" onPointerDown={beginPan} />
    <g transform={compact ? undefined : `translate(${pan.x} ${pan.y}) translate(${cx} ${cy}) scale(${zoom}) translate(${-cx} ${-cy})`}>
      {[0.52, 0.73, 1].map((fraction, index) => <ellipse key={fraction} className={`agentNetworkFrame frame-${index + 1}`} cx={cx} cy={cy} rx={(compact ? width * 0.47 : 520) * fraction} ry={(compact ? height * 0.44 : 228) * fraction} />)}

      {agents.map((agent, index) => {
        const point = positions.get(agent.id)!;
        const matches = matchingAgentIds.has(agent.id);
        return <line key={`structure:${agent.id}`} className={`agentNetworkStructure${query && !matches ? " isDimmed" : ""}`} x1={cx} y1={cy} x2={point.x} y2={point.y} />;
      })}

      {data.links.map(link => {
        const first = positions.get(link.agentIds[0]);
        const second = positions.get(link.agentIds[1]);
        if (!first || !second) return null;
        const tasks = link.taskIds.map(id => data.tasks.find(row => row.task.id === id)).filter(Boolean);
        const firstName = agentLabel(data.agents.find(agent => agent.id === link.agentIds[0])!, t);
        const secondName = agentLabel(data.agents.find(agent => agent.id === link.agentIds[1])!, t);
        const label = t("agentNetwork.linkAria", { first: firstName, second: secondName, count: tasks.length });
        return <g
          key={link.id}
          className={`agentNetworkSharedLink${selectedLinkId === link.id ? " isSelected" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={label}
          onPointerEnter={() => onHover({ kind: "link", id: link.id })}
          onPointerLeave={() => onHover(null)}
          onFocus={() => onHover({ kind: "link", id: link.id })}
          onBlur={() => onHover(null)}
          onClick={() => onSelectLink(link.id)}
          onKeyDown={event => activate(event, () => onSelectLink(link.id))}
        >
          <line className="agentNetworkLinkHit" x1={first.x} y1={first.y} x2={second.x} y2={second.y} />
          <line className="agentNetworkLinkLine" x1={first.x} y1={first.y} x2={second.x} y2={second.y} />
          <circle className="agentNetworkLinkMark" cx={(first.x + second.x) / 2} cy={(first.y + second.y) / 2} r="8" />
          <text className="agentNetworkLinkCount" x={(first.x + second.x) / 2} y={(first.y + second.y) / 2 + 3}>{tasks.length}</text>
        </g>;
      })}

      <g className="agentNetworkHub" role="button" tabIndex={0} aria-label={t("agentNetwork.openProjectCloud")} onClick={onOpenProjects} onKeyDown={event => activate(event, onOpenProjects)}>
        <circle className="agentNetworkHubHit" cx={cx} cy={cy} r={hubRadius + 16} />
        <circle className="agentNetworkHubRing" cx={cx} cy={cy} r={hubRadius + 3} />
        {hubDots.map((row, index) => <circle key={row.task.id} className={`agentNetworkTaskDot state-${row.status}`} {...taskPoint(index, hubDots.length, hubRadius, cx, cy)} r={compact ? 2 : 2.6} />)}
        <circle className="agentNetworkHubCore" cx={cx} cy={cy} r={compact ? 3.5 : 4.5} />
        <text className="agentNetworkHubLabel" x={cx} y={cy + hubRadius + (compact ? 22 : 26)}>{t("agentNetwork.taskCluster", { count: projectsByTask.size })}</text>
      </g>

      {agents.map(agent => {
        const point = positions.get(agent.id)!;
        const matches = matchingAgentIds.has(agent.id);
        const title = agentLabel(agent, t);
        const taskCount = agent.taskIds.length;
        const label = t("agentNetwork.agentAria", { name: title, status: t(`agentNetwork.status.${agent.status}`), count: taskCount });
        return <g
          key={agent.id}
          className={`agentNetworkNode state-${agent.status}${selectedAgentId === agent.id ? " isSelected" : ""}${query && !matches ? " isDimmed" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-pressed={selectedAgentId === agent.id}
          onPointerEnter={() => onHover({ kind: "agent", id: agent.id })}
          onPointerLeave={() => onHover(null)}
          onFocus={() => onHover({ kind: "agent", id: agent.id })}
          onBlur={() => onHover(null)}
          onClick={() => onSelectAgent(agent.id)}
          onKeyDown={event => activate(event, () => onSelectAgent(agent.id))}
        >
          <circle className="agentNetworkNodeHalo" cx={point.x} cy={point.y} r={compact ? 13 : 19} />
          <circle className="agentNetworkNodeCore" cx={point.x} cy={point.y} r={compact ? 5.5 : 8} />
          <text className="agentNetworkNodeLabel" x={point.x} y={point.y + (compact ? 25 : 34)} textAnchor="middle">{shortLabel(title, compact ? 15 : 22)}</text>
          {!compact && <text className="agentNetworkNodeMeta" x={point.x} y={point.y + 49} textAnchor="middle">{t("agentNetwork.taskCount", { count: taskCount })}</text>}
        </g>;
      })}
    </g>
  </svg>;
}

export function ProjectDotGraph({ tasks, label }: { tasks: readonly { id: string; status: NetworkStatus }[]; label: string }) {
  const shown = tasks.slice(0, 18);
  const cx = 82, cy = 36, radius = 28;
  return <svg className="agentNetworkProjectDots" viewBox="0 0 164 72" role="img" aria-label={label}>
    {shown.map((task, index) => {
      const point = taskPoint(index, shown.length, radius, cx, cy);
      return <g key={task.id}><line className="agentNetworkMiniLink" x1={cx} y1={cy} x2={point.x} y2={point.y} /><circle className={`agentNetworkMiniDot state-${task.status}`} cx={point.x} cy={point.y} r="2.5" /></g>;
    })}
    <circle className="agentNetworkMiniCore" cx={cx} cy={cy} r="4" />
    {tasks.length > shown.length && <text className="agentNetworkMiniMore" x="145" y="41">+{tasks.length - shown.length}</text>}
  </svg>;
}

export function AgentNetworkLegend() {
  const { t } = useTranslation();
  return <div className="agentNetworkLegend" aria-label={t("agentNetwork.legend")}>
    <span><i className="isStructural" />{t("agentNetwork.structureLine")}</span>
    <span><i className="isShared" />{t("agentNetwork.sharedLine")}</span>
    <span><i className="isWaiting" />{t("agentNetwork.status.waiting")}</span>
    <span><i className="isBlocked" />{t("agentNetwork.status.blocked")}</span>
  </div>;
}

export function agentDisplayName(agent: NetworkAgent, t: (key: string) => string) {
  return agentLabel(agent, t);
}

export function networkStatusOrder(status: NetworkStatus) {
  return STATUS_ORDER.indexOf(status);
}
