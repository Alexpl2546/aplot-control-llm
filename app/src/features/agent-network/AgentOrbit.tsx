import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentNetworkSnapshot, NetworkAgent, NetworkStatus } from "./model";
import { agentDisplayName } from "./AgentNetworkGraph";

/**
 * «Орбита» — the agent map drawn as a small solar system.
 * Centre: the knowledge core, a slowly turning sphere of particles. Every coloured particle is a real
 * task (its colour is the task status); the grey dust and synapses are decoration.
 * Rings: one orbit per project. Planets: agents on the orbit of their first project; agents without a
 * project share the outer orbit. A working agent glows, leaves a trail and pulls a stream of particles
 * from the core; a waiting agent pulses amber; a blocked one is ringed red. Shared tasks draw a beam.
 *
 * Camera: zoom, pan, focus and side-panel inset are eased with a time-based spring (frame-rate
 * independent, so it stays smooth over Remote Desktop). The system drifts slowly like a lazy river;
 * dragging left/right spins it (with inertia), dragging up/down tilts it, the wheel zooms.
 *
 * Canvas keeps the animation off React and off the layout engine. A visually hidden button list mirrors
 * every planet so the map is fully usable from the keyboard and by screen readers.
 */

interface OrbitProps {
  data: AgentNetworkSnapshot;
  variant?: "card" | "stage";
  selectedAgentId?: string;
  selectedLinkId?: string;
  query?: string;
  zoom?: number;
  maxAgents?: number;
  page?: number;
  onSelectAgent: (id: string) => void;
  onOpenProjects: () => void;
  /** Focus mode: only this project's orbit stays lit, and the map zooms onto it. */
  focusProjectId?: string;
  onFocusProject?: (projectId?: string) => void;
  /** Time scrub: hide tasks (and agents without visible tasks) created after this moment. */
  cutoff?: number;
  onZoom?: (zoom: number) => void;
  /** Width covered on the right (an open side panel); the system re-centres into the free space. */
  insetRight?: number;
  /** Changing this number recentres the camera (pan back to the middle). */
  resetToken?: number;
}

type Palette = Record<"accent" | "ok" | "warn" | "danger" | "info" | "text" | "text2" | "text3" | "line" | "base" | "claude" | "codex", string> & { dark: boolean };
type Body = { id: string; x: number; y: number; r: number; depth: number };

const PROJECT_RINGS = 5;
const CORE_POINTS = 210;
const STARS = 90;

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function readPalette(element: Element): Palette {
  const css = getComputedStyle(element);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    dark,
    accent: get("--k-accent", "#c8f27c"), ok: get("--k-ok", "#c8f27c"), warn: get("--k-warn", "#f2b85b"),
    danger: get("--k-danger", "#ff7070"), info: get("--k-info", "#62c9ec"), text: get("--k-text", "#edf1f4"),
    text2: get("--k-text-2", "#acb6c1"), text3: get("--k-text-3", "#929da8"), line: dark ? "#ffffff" : "#1f3319",
    base: dark ? "#9fb7c4" : "#5f7a5a", claude: dark ? "#e7b08f" : "#b5643a", codex: dark ? "#8fb6ff" : "#2c5fb8",
  };
}

function statusColor(status: NetworkStatus, p: Palette) {
  switch (status) {
    case "running": return p.accent;
    case "waiting": return p.warn;
    case "blocked": return p.danger;
    case "completed": return p.info;
    case "ready": return p.text2;
    default: return p.text3;
  }
}

function agentColor(agent: NetworkAgent, p: Palette) {
  if (agent.color) return agent.color;
  if (agent.runtime === "claude") return p.claude;
  if (agent.runtime === "codex") return p.codex;
  if (agent.kind === "child") return p.text2;
  return p.accent;
}

const rgbCache = new Map<string, [number, number, number]>();
let probe: CanvasRenderingContext2D | null = null;
/** Normalises any CSS colour (hex, rgb, color-mix…) once through the canvas parser, then caches it. */
function rgb(color: string): [number, number, number] {
  const cached = rgbCache.get(color);
  if (cached) return cached;
  probe ??= document.createElement("canvas").getContext("2d");
  let value: [number, number, number] = [160, 170, 180];
  if (probe) {
    probe.fillStyle = "#000";
    probe.fillStyle = color;
    const parsed = String(probe.fillStyle);
    if (parsed.startsWith("#")) value = [parseInt(parsed.slice(1, 3), 16), parseInt(parsed.slice(3, 5), 16), parseInt(parsed.slice(5, 7), 16)];
    else { const parts = parsed.match(/[\d.]+/g)?.map(Number) ?? []; if (parts.length >= 3) value = [parts[0]!, parts[1]!, parts[2]!]; }
  }
  rgbCache.set(color, value);
  return value;
}

function alpha(color: string, a: number) {
  const [r, g, b] = rgb(color);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function shade(color: string, a: number) {
  const [r, g, b] = rgb(color);
  return `rgba(${Math.round(r * .42)},${Math.round(g * .42)},${Math.round(b * .42)},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Points on a sphere plus the neighbour pairs that become synapses; distances survive rotation. */
function buildSphere() {
  const points: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < CORE_POINTS; i++) {
    const y = 1 - (i / (CORE_POINTS - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const jitter = 0.86 + hash(`p${i}`) * 0.2;
    points.push([Math.cos(theta) * radius * jitter, y * jitter, Math.sin(theta) * radius * jitter]);
  }
  const pairs: [number, number][] = [];
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
    const [ax, ay, az] = points[a]!, [bx, by, bz] = points[b]!;
    if ((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 < 0.075) pairs.push([a, b]);
  }
  return { points, pairs };
}

export function AgentOrbit({ data, variant = "card", selectedAgentId, selectedLinkId, query = "", zoom = 1, maxAgents, page = 0, onSelectAgent, onOpenProjects, focusProjectId, onFocusProject, cutoff, onZoom, insetRight = 0, resetToken = 0 }: OrbitProps) {
  const { t } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const bodies = useRef<Body[]>([]);
  const clock = useRef<number | null>(null);
  const core = useRef({ x: 0, y: 0, r: 0 });
  /* Spin: angle offset added to every planet, driven by drag with inertia. Tilt: vertical drag. */
  const spin = useRef({ angle: 0, target: 0, velocity: 0, tilt: 1 });
  const drag = useRef<{ x: number; y: number; lastX: number; lastT: number; startTilt: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const sphere = useMemo(buildSphere, []);
  const limit = maxAgents ?? (variant === "card" ? 10 : 24);
  const visibleTasks = useMemo(() => cutoff === undefined ? data.tasks : data.tasks.filter(row => row.task.createdAt <= cutoff), [data.tasks, cutoff]);
  const agents = useMemo(() => {
    const shown = new Set(visibleTasks.map(row => row.task.id));
    const pool = cutoff === undefined ? data.agents : data.agents.filter(agent => agent.taskIds.some(id => shown.has(id)));
    return pool.slice(page * limit, page * limit + limit);
  }, [data.agents, visibleTasks, cutoff, page, limit]);
  const needle = query.trim().toLocaleLowerCase();

  /* Orbit assignment: busiest projects get the inner rings, then the shared and the base-agent orbits. */
  const layout = useMemo(() => {
    const projectOrder = [...data.projects].sort((a, b) => b.agentIds.length - a.agentIds.length || b.taskIds.length - a.taskIds.length).slice(0, PROJECT_RINGS);
    const rings = projectOrder.map(entry => ({ id: entry.project.id, label: entry.project.name, agents: [] as NetworkAgent[] }));
    const free = { id: "__free", label: t("agentNetwork.freeOrbit"), agents: [] as NetworkAgent[] };
    for (const agent of agents) {
      const ring = rings.find(entry => agent.projectIds.includes(entry.id));
      (ring ?? free).agents.push(agent);
    }
    const used = rings.filter(ring => ring.agents.length || rings.length <= 3);
    if (free.agents.length) used.push(free);
    return used.length ? used : [{ id: "__ghost1", label: "", agents: [] }, { id: "__ghost2", label: "", agents: [] }, { id: "__ghost3", label: "", agents: [] }];
  }, [agents, data.projects, t]);

  const taskColors = useMemo(() => visibleTasks.slice(0, 90).map(row => row.status), [visibleTasks]);
  const matches = useMemo(() => new Set(needle ? data.agents.filter(agent => agentDisplayName(agent, t).toLocaleLowerCase().includes(needle)
    || agent.taskIds.some(id => data.tasks.find(row => row.task.id === id)?.task.title.toLocaleLowerCase().includes(needle))).map(agent => agent.id) : []), [data, needle, t]);
  const linkPairs = useMemo(() => data.links.map(link => ({ id: link.id, a: link.agentIds[0], b: link.agentIds[1], weight: link.taskIds.length })), [data.links]);

  /* Everything the long-lived render loop reads; refreshed every render without restarting the loop. */
  const live = useRef({ layout, taskColors, linkPairs, matches, needle, selectedAgentId, selectedLinkId, hoverId, focusId, focusProjectId, zoom, insetRight, taskCount: data.tasks.length, t });
  live.current = { layout, taskColors, linkPairs, matches, needle, selectedAgentId, selectedLinkId, hoverId, focusId, focusProjectId, zoom, insetRight, taskCount: data.tasks.length, t };

  useEffect(() => { spin.current.tilt = 1; spin.current.velocity = 0; }, [resetToken]);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick(value => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current, host = wrap.current;
    if (!element || !host) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const palette = readPalette(host);
    const stars = Array.from({ length: STARS }, (_, index) => ({ x: hash(`sx${index}`), y: hash(`sy${index}`), s: hash(`ss${index}`), p: hash(`sp${index}`) * Math.PI * 2 }));
    let width = 0, height = 0, dpr = 1, frame = 0, visible = true, last = performance.now();
    let time = clock.current ?? (reduced ? 12 : 6 + hash(String(Date.now())) * 40);
    /* Eased camera state: every value glides toward its target. */
    const cam = { zoom: live.current.zoom, focus: 1, inset: live.current.insetRight, panX: 0, panY: 0, tilt: spin.current.tilt };

    const resize = () => {
      // Layout size (clientWidth) stays correct under CSS zoom; the visual box only sharpens the backing store.
      const box = host.getBoundingClientRect();
      const visual = host.clientWidth ? box.width / host.clientWidth : 1;
      dpr = Math.min(2.5, (window.devicePixelRatio || 1) * visual);
      width = Math.max(320, host.clientWidth); height = Math.max(220, host.clientHeight);
      element.width = Math.round(width * dpr); element.height = Math.round(height * dpr);
      element.style.width = `${width}px`; element.style.height = `${height}px`;
    };

    const draw = (dt: number) => {
      const L = live.current;
      const ease = (current: number, target: number, rate: number) => reduced ? target : current + (target - current) * (1 - Math.exp(-dt * rate));
      cam.zoom = ease(cam.zoom, L.zoom, 9);
      cam.inset = ease(cam.inset, L.insetRight, 8);
      cam.tilt = ease(cam.tilt, spin.current.tilt, drag.current ? 18 : 6);
      /* Spin: follow the drag closely, then coast with friction like water carrying it on */
      const S = spin.current;
      if (!drag.current && !reduced) { S.target += S.velocity * dt; S.velocity *= Math.exp(-dt * 1.6); if (Math.abs(S.velocity) < 0.002) S.velocity = 0; }
      S.angle = ease(S.angle, S.target, drag.current ? 16 : 5);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const usable = Math.max(240, width - cam.inset);
      const cx = usable / 2 + cam.panX, cy = height / 2 + cam.panY;
      const scale = cam.zoom;
      const coreR = Math.min(height * (variant === "card" ? 0.15 : 0.12), usable * 0.1) * scale;
      core.current = { x: cx, y: cy, r: coreR };
      const lighter = palette.dark ? "lighter" : "source-over";
      const font = (weight: number, size: number) => `${weight} ${size}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;

      /* Stars drift a little with the camera for depth */
      for (const star of stars) {
        const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(time * (0.4 + star.s) + star.p));
        const sx = ((star.x * width - S.angle * 40 * star.s) % width + width) % width, sy = star.y * height;
        ctx.fillStyle = alpha(palette.dark ? "#cfe3ff" : palette.text3, (palette.dark ? 0.5 : 0.25) * twinkle * (0.4 + star.s * 0.6));
        ctx.fillRect(sx, sy, star.s > 0.85 ? 1.6 : 1, star.s > 0.85 ? 1.6 : 1);
      }

      /* Orbit geometry */
      const maxRx = Math.min(usable * 0.42, (height * 0.44) / 0.42) * scale;
      const minRx = coreR * 2.1;
      const ringCount = L.layout.length;
      const tilt = Math.min(0.46, (height * 0.43) / Math.max(maxRx / scale, 1)) * cam.tilt;
      const rings = L.layout.map((ring, index) => {
        const rx = ringCount === 1 ? (minRx + maxRx) / 2 : minRx + (maxRx - minRx) * (index / (ringCount - 1));
        return { ...ring, rx, ry: rx * tilt, speed: 0.028 / (1 + index * 0.28), phase: hash(ring.id) * Math.PI * 2 };
      });

      /* Focus mode: ease the focused orbit out to the outer radius */
      const focusRing = L.focusProjectId ? rings.find(ring => ring.id === L.focusProjectId) : undefined;
      cam.focus = ease(cam.focus, focusRing ? Math.min(2.2, (maxRx * 0.9) / Math.max(1, focusRing.rx)) : 1, 7);
      rings.forEach(ring => { ring.rx *= cam.focus; ring.ry *= cam.focus; });
      const ringDim = (id: string) => L.focusProjectId && id !== L.focusProjectId ? 0.18 : 1;

      /* Planet positions */
      const placed: (Body & { agent: NetworkAgent; ringIndex: number; angle: number; color: string })[] = [];
      rings.forEach((ring, ringIndex) => ring.agents.forEach((agent, index) => {
        const angle = ring.phase + (Math.PI * 2 * index) / ring.agents.length + time * ring.speed + S.angle;
        const depth = Math.sin(angle);
        const size = (variant === "card" ? 5 : 6.5) + Math.min(5, Math.sqrt(agent.taskIds.length) * 1.6);
        placed.push({
          id: agent.id, agent, ringIndex, angle, depth, color: agentColor(agent, palette),
          x: cx + Math.cos(angle) * ring.rx, y: cy + Math.sin(angle) * ring.ry,
          r: size * (0.78 + 0.22 * (depth + 1) / 2) * Math.sqrt(scale),
        });
      }));
      bodies.current = placed.map(({ id, x, y, r, depth }) => ({ id, x, y, r, depth }));
      const byId = new Map(placed.map(body => [body.id, body]));
      const active = L.hoverId ?? L.focusId;

      /* Rings */
      rings.forEach((ring, index) => {
        const selectedRing = placed.some(body => body.ringIndex === index && (body.id === L.selectedAgentId || body.id === active));
        const dashed = ring.id === "__free" || ring.id.startsWith("__ghost");
        ctx.beginPath();
        ctx.ellipse(cx, cy, ring.rx, ring.ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = alpha(palette.line, (selectedRing || ring.id === L.focusProjectId ? 0.24 : ring.id.startsWith("__ghost") ? 0.06 : 0.09) * ringDim(ring.id));
        ctx.lineWidth = 1;
        ctx.setLineDash(dashed ? [2, 6] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (ring.label) {
          const labelAngle = -Math.PI * 0.1 - index * 0.21;
          const lx = cx + Math.cos(labelAngle) * ring.rx, ly = cy + Math.sin(labelAngle) * ring.ry;
          ctx.font = font(500, variant === "card" ? 10.5 : 11.5);
          ctx.fillStyle = alpha(ring.id === L.focusProjectId ? palette.text : palette.text3, 0.85 * ringDim(ring.id));
          ctx.textAlign = "left";
          const text = ring.label.length > 26 ? `${ring.label.slice(0, 25)}…` : ring.label;
          ctx.fillText(text, Math.min(lx + 6, usable - ctx.measureText(text).width - 10), Math.max(14, ly - 5));
        }
      });

      const drawPlanet = (body: typeof placed[number]) => {
        const { agent, x, y, r, color, depth } = body;
        const base = 1;
        const dim = (L.needle && !L.matches.has(agent.id) ? 0.25 : 1) * ringDim(rings[body.ringIndex]!.id) * base;
        const fade = (0.55 + 0.45 * (depth + 1) / 2) * dim;
        const selected = agent.id === L.selectedAgentId, hovered = agent.id === active;
        const running = agent.status === "running";

        if (running) { /* trail along the orbit */
          const ring = rings[body.ringIndex]!;
          ctx.globalCompositeOperation = lighter;
          for (let step = 1; step <= 14; step++) {
            const a = body.angle - step * 0.035;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * ring.rx, cy + Math.sin(a) * ring.ry, Math.max(0.6, r * 0.42 * (1 - step / 15)), 0, Math.PI * 2);
            ctx.fillStyle = alpha(color, 0.32 * (1 - step / 15) * fade);
            ctx.fill();
          }
          ctx.globalCompositeOperation = "source-over";
        }
        if (running || hovered || selected) { /* halo */
          const halo = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * (running ? 4.2 : 3));
          halo.addColorStop(0, alpha(color, (running ? 0.42 : 0.28) * fade));
          halo.addColorStop(1, alpha(color, 0));
          ctx.globalCompositeOperation = lighter;
          ctx.fillStyle = halo;
          ctx.beginPath(); ctx.arc(x, y, r * 4.2, 0, Math.PI * 2); ctx.fill();
          ctx.globalCompositeOperation = "source-over";
        }
        const body3d = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
        body3d.addColorStop(0, alpha("#ffffff", 0.85 * fade));
        body3d.addColorStop(0.35, alpha(color, fade));
        body3d.addColorStop(1, shade(color, fade));
        ctx.fillStyle = body3d;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();

        if (agent.status === "waiting" || agent.status === "blocked") {
          const pulse = agent.status === "waiting" ? 0.5 + 0.5 * Math.sin(time * 4) : 1;
          ctx.strokeStyle = alpha(statusColor(agent.status, palette), (0.45 + 0.55 * pulse) * fade);
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(x, y, r + 3.5 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
        }
        if (selected || hovered) {
          ctx.strokeStyle = alpha(palette.text, selected ? 0.9 : 0.55);
          ctx.lineWidth = 1.2;
          ctx.setLineDash(selected ? [] : [3, 3]);
          ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
        const showLabel = variant === "stage" || depth > -0.35 || selected || hovered || placed.length <= 6;
        if (showLabel) {
          const name = agentDisplayName(agent, L.t);
          ctx.font = font(selected || hovered ? 600 : 500, variant === "card" ? 11 : 12);
          ctx.textAlign = "center";
          ctx.fillStyle = alpha(palette.text, (selected || hovered ? 1 : 0.78) * fade);
          ctx.fillText(name.length > 22 ? `${name.slice(0, 21)}…` : name, x, y + r + 15);
        }
      };

      /* Back planets, then the core, then front planets: the core occludes what's behind it */
      const back = placed.filter(body => body.depth < 0).sort((a, b) => a.depth - b.depth);
      const front = placed.filter(body => body.depth >= 0).sort((a, b) => a.depth - b.depth);
      back.forEach(drawPlanet);

      /* Streams from the core into working agents */
      ctx.globalCompositeOperation = lighter;
      for (const body of placed) {
        if (body.agent.status !== "running" || ringDim(rings[body.ringIndex]!.id) < 1) continue;
        const dx = body.x - cx, dy = body.y - cy, length = Math.hypot(dx, dy) || 1;
        const sx = cx + (dx / length) * coreR * 0.9, sy = cy + (dy / length) * coreR * 0.9;
        const line = ctx.createLinearGradient(sx, sy, body.x, body.y);
        line.addColorStop(0, alpha(body.color, 0.0));
        line.addColorStop(1, alpha(body.color, 0.28));
        ctx.strokeStyle = line; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(body.x, body.y); ctx.stroke();
        for (let k = 0; k < 4; k++) {
          const p = (time * 0.55 + k / 4 + hash(body.id)) % 1;
          ctx.fillStyle = alpha(body.color, 0.9 * Math.sin(p * Math.PI));
          ctx.beginPath(); ctx.arc(sx + (body.x - sx) * p, sy + (body.y - sy) * p, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }

      /* Shared-task beams */
      for (const link of L.linkPairs) {
        const a = byId.get(link.a), b = byId.get(link.b);
        if (!a || !b) continue;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        /* bow the beam away from the core so it never cuts through it */
        const away = Math.hypot(mx - cx, my - cy) < coreR * 2.2 ? -1 : 1;
        const nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1;
        const side = Math.sign((mx - cx) * nx + (my - cy) * ny) || 1;
        const bow = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.28) * (away < 0 ? 1.6 : 1);
        const qx = mx + (nx / nl) * bow * side, qy = my + (ny / nl) * bow * side;
        const selectedLink = link.id === L.selectedLinkId;
        const linkDim = Math.min(ringDim(rings[a.ringIndex]!.id), ringDim(rings[b.ringIndex]!.id));
        ctx.strokeStyle = alpha(palette.info, (selectedLink ? 0.75 : 0.28) * linkDim);
        ctx.lineWidth = selectedLink ? 2 : 1 + Math.min(1.5, link.weight * 0.3);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(qx, qy, b.x, b.y); ctx.stroke();
        const p = (time * 0.3 + hash(link.id)) % 1, u = 1 - p;
        ctx.fillStyle = alpha(palette.info, 0.95 * linkDim);
        ctx.beginPath(); ctx.arc(u * u * a.x + 2 * u * p * qx + p * p * b.x, u * u * a.y + 2 * u * p * qy + p * p * b.y, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      /* Knowledge core */
      const breath = 1 + 0.035 * Math.sin(time * 1.3);
      const glow = ctx.createRadialGradient(cx, cy, coreR * 0.2, cx, cy, coreR * 2.4);
      glow.addColorStop(0, alpha(palette.accent, palette.dark ? 0.22 : 0.16));
      glow.addColorStop(0.45, alpha(palette.info, palette.dark ? 0.08 : 0.06));
      glow.addColorStop(1, alpha(palette.info, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2); ctx.fill();
      const occluder = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.05);
      occluder.addColorStop(0, alpha(palette.dark ? "#0b1218" : "#f4f7f2", 0.92));
      occluder.addColorStop(1, alpha(palette.dark ? "#0b1218" : "#f4f7f2", 0));
      ctx.fillStyle = occluder;
      ctx.beginPath(); ctx.arc(cx, cy, coreR * 1.05, 0, Math.PI * 2); ctx.fill();

      const rotY = time * 0.22, rotX = 0.42 + Math.sin(time * 0.1) * 0.08;
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY), cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const projected = sphere.points.map(([px, py, pz]) => {
        const x1 = px * cosY + pz * sinY, z1 = -px * sinY + pz * cosY;
        const y2 = py * cosX - z1 * sinX, z2 = py * sinX + z1 * cosX;
        return { x: cx + x1 * coreR * breath, y: cy + y2 * coreR * breath, z: z2 };
      });
      ctx.globalCompositeOperation = lighter;
      ctx.lineWidth = 0.7;
      for (const [a, b] of sphere.pairs) {
        const pa = projected[a]!, pb = projected[b]!;
        const depth = (pa.z + pb.z) / 2;
        if (depth < -0.3) continue;
        ctx.strokeStyle = alpha(palette.base, (palette.dark ? 0.2 : 0.22) * (depth + 1) / 2);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      projected.forEach((point, index) => {
        const status = index < L.taskColors.length ? L.taskColors[index] : undefined;
        const near = (point.z + 1) / 2;
        const color = status ? statusColor(status, palette) : palette.base;
        const size = (status ? 1.9 : 1.1) * (0.6 + near * 0.8);
        ctx.fillStyle = alpha(color, (status ? 0.95 : palette.dark ? 0.55 : 0.6) * (0.25 + near * 0.75));
        ctx.beginPath(); ctx.arc(point.x, point.y, size, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalCompositeOperation = "source-over";

      front.forEach(drawPlanet);

      /* Core caption on a glass pill, above everything so passing planets never hide it */
      {
        const title = L.t("agentNetwork.core"), sub = L.t("agentNetwork.taskCluster", { count: L.taskCount });
        const ly = cy + coreR * 1.35 + 12;
        ctx.font = font(600, variant === "card" ? 11 : 12);
        const w = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width + 4) + 22;
        ctx.fillStyle = palette.dark ? "rgba(10,14,18,.62)" : "rgba(250,252,248,.78)";
        ctx.beginPath(); ctx.roundRect(cx - w / 2, ly - 13, w, 34, 11); ctx.fill();
        ctx.textAlign = "center";
        ctx.fillStyle = alpha(palette.text, active === "__core" ? 1 : 0.88);
        ctx.fillText(title, cx, ly);
        ctx.font = font(400, variant === "card" ? 10.5 : 11);
        ctx.fillStyle = alpha(palette.text3, 0.95);
        ctx.fillText(sub, cx, ly + 14);
      }

      /* Tooltip follows its planet without a React render per frame */
      const tipBody = active && active !== "__core" ? byId.get(active) : undefined;
      if (tip.current) {
        if (tipBody && !drag.current) {
          tip.current.style.transform = `translate(${Math.round(Math.min(usable - 230, Math.max(8, tipBody.x + tipBody.r + 14)))}px, ${Math.round(Math.max(8, tipBody.y - 30))}px)`;
          tip.current.dataset.on = "true";
        } else tip.current.dataset.on = "false";
      }
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      if (!reduced) time += Math.min(0.05, dt);
      clock.current = time;
      draw(dt);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    const intersection = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); });
    intersection.observe(host);
    resize();
    frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); resizeObserver.disconnect(); intersection.disconnect(); };
  }, [variant, sphere, themeTick]);

  /* Wheel zoom: proportional to the scroll distance, so touchpads glide and wheels step evenly. */
  const zoomTarget = useRef(zoom);
  zoomTarget.current = zoom;
  useEffect(() => {
    const host = wrap.current;
    if (!host || !onZoom) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      const next = Math.max(0.5, Math.min(2.5, zoomTarget.current * Math.exp(-delta * 0.0016)));
      zoomTarget.current = next;
      onZoom(Math.round(next * 100) / 100);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [onZoom]);

  const point = (clientX: number, clientY: number) => {
    const box = canvas.current?.getBoundingClientRect(), host = wrap.current;
    if (!box || !host) return { x: 0, y: 0, ratio: 1 };
    const ratio = box.width ? host.clientWidth / box.width : 1;
    return { x: (clientX - box.left) * ratio, y: (clientY - box.top) * ratio, ratio };
  };
  const pick = (clientX: number, clientY: number) => {
    const { x, y } = point(clientX, clientY);
    const hit = [...bodies.current].sort((a, b) => b.depth - a.depth).find(body => Math.hypot(body.x - x, body.y - y) <= body.r + 9);
    if (hit) return hit.id;
    const { x: cx, y: cy, r } = core.current;
    return Math.hypot(cx - x, cy - y) <= r * 1.15 ? "__core" : null;
  };

  const hovered = hoverId && hoverId !== "__core" ? data.agents.find(agent => agent.id === hoverId) ?? null : focusId ? data.agents.find(agent => agent.id === focusId) ?? null : null;
  const hoveredTasks = hovered ? hovered.taskIds.map(id => data.tasks.find(row => row.task.id === id)).filter(Boolean).slice(0, 3) : [];
  const pannable = variant === "stage";

  return <div ref={wrap} className={`agentOrbit is-${variant}${hoverId ? " isPointing" : ""}${panning ? " isPanning" : pannable ? " isPannable" : ""}`}
    onPointerDown={event => {
      if (!pannable || event.button !== 0 || pick(event.clientX, event.clientY)) return;
      event.preventDefault(); // no text selection while spinning
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastT: performance.now(), startTilt: spin.current.tilt, moved: false, id: event.pointerId };
      spin.current.velocity = 0;
    }}
    onPointerMove={event => {
      const state = drag.current;
      if (state) {
        const { ratio } = point(event.clientX, event.clientY);
        const dx = (event.clientX - state.x) * ratio, dy = (event.clientY - state.y) * ratio;
        if (!state.moved && Math.hypot(dx, dy) > 4) { state.moved = true; setPanning(true); setHoverId(null); }
        if (state.moved) {
          const S = spin.current, now = performance.now(), step = (event.clientX - state.lastX) * ratio;
          const k = 2.4 / Math.max(400, wrap.current?.clientWidth ?? 1000); // a full drag across ≈ 2.4 rad
          // Dragging right carries the near (lower) side of the orbit to the right.
          S.target -= step * k;
          const dtMs = Math.max(8, now - state.lastT);
          S.velocity = S.velocity * 0.6 + (-step * k / (dtMs / 1000)) * 0.4;
          state.lastX = event.clientX; state.lastT = now;
          S.tilt = Math.max(0.45, Math.min(1.9, state.startTilt * Math.exp(dy * 0.004)));
        }
        return;
      }
      const id = pick(event.clientX, event.clientY); if (id !== hoverId) setHoverId(id);
    }}
    onPointerUp={() => {
      const state = drag.current;
      if (state?.moved) { suppressClick.current = true; if (performance.now() - state.lastT > 90) spin.current.velocity = 0; spin.current.velocity = Math.max(-3, Math.min(3, spin.current.velocity)); }
      drag.current = null; setPanning(false);
    }}
    onPointerCancel={() => { drag.current = null; setPanning(false); }}
    onPointerLeave={() => { if (!drag.current) setHoverId(null); }}
    onClick={event => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      const id = pick(event.clientX, event.clientY); if (id === "__core") onOpenProjects(); else if (id) onSelectAgent(id);
    }}
    onDoubleClick={event => {
      if (!onFocusProject) return;
      const id = pick(event.clientX, event.clientY);
      const agent = id && id !== "__core" ? data.agents.find(item => item.id === id) : undefined;
      const project = agent ? layout.find(ring => !ring.id.startsWith("__") && agent.projectIds.includes(ring.id))?.id : undefined;
      onFocusProject(project && project !== focusProjectId ? project : undefined);
    }}>
    <canvas ref={canvas} aria-hidden="true"/>
    <div ref={tip} className="agentOrbitTip" role="tooltip" data-on="false">
      {hovered && <><b>{agentDisplayName(hovered, t)}</b>
        <span className={`agentNetworkStatus state-${hovered.status}`}><i aria-hidden="true"/>{t(`agentNetwork.status.${hovered.status}`)}</span>
        {hoveredTasks.map(row => <small key={row!.task.id}>{row!.task.title}</small>)}
        {!hoveredTasks.length && <small>{t("agentNetwork.noAssignedTasks")}</small>}</>}
    </div>
    <div className="agentOrbitA11y" aria-label={t("agentNetwork.graphLabel")} role="group">
      <button type="button" onFocus={() => setFocusId("__core")} onBlur={() => setFocusId(null)} onClick={onOpenProjects}>
        {t("agentNetwork.coreAria", { tasks: data.tasks.length, projects: data.projects.length })}</button>
      {agents.map(agent => <button key={agent.id} type="button" aria-pressed={agent.id === selectedAgentId}
        onFocus={() => setFocusId(agent.id)} onBlur={() => setFocusId(null)} onClick={() => onSelectAgent(agent.id)}>
        {t("agentNetwork.agentAria", { name: agentDisplayName(agent, t), status: t(`agentNetwork.status.${agent.status}`), count: agent.taskIds.length })}</button>)}
    </div>
  </div>;
}
