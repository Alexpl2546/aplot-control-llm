import { DASHBOARD_WIDGET_IDS, type DashboardLayout, type DashboardRect, type DashboardWidgetId } from "../types/app";
import baseline from "./dashboardBaseline.json";

// Horizontal coordinates are stored at a reference width; vertical sizes stay
// in CSS pixels so changing the window width does not shrink text and charts.
export const DASHBOARD_WIDTH = 1200;
export const TILE_GAP = 14;
export type DashboardRects = Partial<Record<DashboardWidgetId, DashboardRect>>;
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export interface SnapGuide { axis: "x" | "y"; value: number; }

export function tileMinimum(id: DashboardWidgetId) {
  if (id.startsWith("charts.")) return { w: 300, h: 220 };
  if (id.startsWith("hardware.")) return { w: 240, h: 180 };
  if (id === "inference.slots") return { w: 270, h: 180 };
  if (id === "inference.context") return { w: 240, h: 180 };
  return { w: 180, h: 170 };
}

export function defaultDashboardLayout(ids: readonly DashboardWidgetId[]): DashboardLayout {
  return { version: 1, items: defaultDashboardRects(ids, DASHBOARD_WIDTH) };
}

function defaultDashboardRects(ids: readonly DashboardWidgetId[], width: number): DashboardRects {
  const items: DashboardRects = {};
  const rows: readonly (readonly DashboardWidgetId[])[] = [
    ["hardware.gpu", "hardware.cpu", "hardware.memory"],
    ["inference.generation", "inference.prompt", "inference.slots", "inference.ttft", "inference.activeRequests", "inference.queuedRequests"],
    ["inference.context", "charts.throughput", "charts.requests"],
    ["charts.thermals", "charts.hardware", "charts.memory"],
  ];
  const scale = width / DASHBOARD_WIDTH;
  let y = 0;
  for (const row of rows) {
    const visible = row.filter(id => ids.includes(id));
    if (!visible.length) continue;
    // Preserve the user's exact horizontal proportions when every card fits.
    // Missing cards and narrow windows reflow in the same reading order.
    const fits = visible.length === row.length && visible.every(id => baseline.items[id].w * scale >= tileMinimum(id).w);
    if (fits) {
      for (const id of visible) {
        const r = baseline.items[id];
        items[id] = { x: r.x * scale, y, w: r.w * scale, h: r.h };
      }
      y += Math.max(...visible.map(id => baseline.items[id].h)) + TILE_GAP;
      continue;
    }
    const minimumWidth = Math.max(...visible.map(id => tileMinimum(id).w));
    const columns = Math.min(visible.length, Math.max(1, Math.floor((width + TILE_GAP) / (minimumWidth + TILE_GAP))));
    const w = (width - TILE_GAP * (columns - 1)) / columns;
    for (let index = 0; index < visible.length; index += columns) {
      const line = visible.slice(index, index + columns);
      line.forEach((id, column) => { items[id] = { x: column * (w + TILE_GAP), y, w, h: baseline.items[id].h }; });
      y += Math.max(...line.map(id => baseline.items[id].h)) + TILE_GAP;
    }
  }
  return items;
}

export function normalizeDashboardLayout(value: unknown): DashboardLayout | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("items" in value) || !value.items || typeof value.items !== "object") return null;
  const items: DashboardRects = {};
  for (const id of DASHBOARD_WIDGET_IDS) {
    const rect = (value.items as Record<string, unknown>)[id];
    if (!rect || typeof rect !== "object") continue;
    const r = rect as DashboardRect;
    if (![r.x, r.y, r.w, r.h].every(n => typeof n === "number" && Number.isFinite(n)) || r.w <= 0 || r.h <= 0) continue;
    const w = Math.min(DASHBOARD_WIDTH, Math.max(60, r.w));
    items[id] = { x: Math.max(0, Math.min(DASHBOARD_WIDTH - w, r.x)), y: Math.max(0, Math.min(100_000, r.y)), w, h: Math.max(tileMinimum(id).h, Math.min(2000, r.h)) };
  }
  return { version: 1, items };
}

export function overlaps(a: DashboardRect, b: DashboardRect) {
  return a.x < b.x + b.w - .1 && a.x + a.w > b.x + .1 && a.y < b.y + b.h - .1 && a.y + a.h > b.y + .1;
}

export function resolveDashboardCollisions(rects: DashboardRects, active?: DashboardWidgetId): DashboardRects {
  const entries = Object.entries(rects) as [DashboardWidgetId, DashboardRect][];
  entries.sort(([a, ar], [b, br]) => a === active ? -1 : b === active ? 1 : ar.y - br.y || ar.x - br.x);
  const placed: DashboardRects = {};
  for (const [id, original] of entries) {
    const rect = { ...original };
    let conflicts = Object.values(placed).filter(other => overlaps(rect, other));
    while (conflicts.length) {
      rect.y = Math.max(...conflicts.map(other => other.y + other.h + TILE_GAP));
      conflicts = Object.values(placed).filter(other => overlaps(rect, other));
    }
    placed[id] = rect;
  }
  return placed;
}

export function projectDashboardLayout(saved: DashboardLayout | null, ids: readonly DashboardWidgetId[], width: number): DashboardRects {
  const defaults = defaultDashboardRects(ids, width);
  const source = normalizeDashboardLayout(saved)?.items ?? {};
  const rects: DashboardRects = {};
  const scale = width / DASHBOARD_WIDTH;
  for (const id of ids) {
    const stored = source[id];
    const r = stored ?? defaults[id]!;
    const w = Math.min(width, Math.max(tileMinimum(id).w, r.w * (stored ? scale : 1)));
    rects[id] = { x: Math.max(0, Math.min(width - w, r.x * (stored ? scale : 1))), y: r.y, w, h: Math.max(tileMinimum(id).h, r.h) };
  }
  return resolveDashboardCollisions(rects);
}

export function saveDashboardRects(rects: DashboardRects, width: number, previous: DashboardLayout | null): DashboardLayout {
  const items = { ...normalizeDashboardLayout(previous)?.items };
  const scale = DASHBOARD_WIDTH / Math.max(1, width);
  for (const [id, r] of Object.entries(rects) as [DashboardWidgetId, DashboardRect][]) {
    items[id] = { x: r.x * scale, y: r.y, w: r.w * scale, h: r.h };
  }
  return { version: 1, items };
}

function nearest(value: number, candidates: number[], threshold: number): number | undefined {
  let best: number | undefined, distance = threshold;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - value);
    if (delta <= distance) { best = candidate; distance = delta; }
  }
  return best;
}

export function moveDashboardTile(rect: DashboardRect, dx: number, dy: number, others: DashboardRect[], width: number, bottom: number, snap = true) {
  const result = { ...rect, x: Math.max(0, Math.min(width - rect.w, rect.x + dx)), y: Math.max(0, rect.y + dy) };
  const guides: SnapGuide[] = [];
  if (snap) {
    const xs = [0, width - rect.w];
    const ys = [0, bottom - rect.h];
    for (const other of others) {
      xs.push(other.x, other.x + other.w - rect.w, other.x + other.w + TILE_GAP, other.x - rect.w - TILE_GAP);
      ys.push(other.y, other.y + other.h - rect.h, other.y + other.h + TILE_GAP, other.y - rect.h - TILE_GAP);
    }
    const x = nearest(result.x, xs.filter(v => v >= 0 && v + rect.w <= width + .1), 10);
    const y = nearest(result.y, ys.filter(v => v >= 0), 10);
    if (x !== undefined) { result.x = x; guides.push({ axis: "x", value: x }); }
    if (y !== undefined) { result.y = y; guides.push({ axis: "y", value: y }); }
  }
  return { rect: result, guides };
}

export function resizeDashboardTile(rect: DashboardRect, edge: ResizeEdge, dx: number, dy: number, others: DashboardRect[], width: number, minimum: { w: number; h: number }, snap = true) {
  let left = rect.x, top = rect.y, right = rect.x + rect.w, bottom = rect.y + rect.h;
  const guides: SnapGuide[] = [];
  if (edge.includes("w")) left = Math.max(0, Math.min(right - minimum.w, left + dx));
  if (edge.includes("e")) right = Math.min(width, Math.max(left + minimum.w, right + dx));
  if (edge.includes("n")) top = Math.max(0, Math.min(bottom - minimum.h, top + dy));
  if (edge.includes("s")) bottom = Math.min(top + 2000, Math.max(top + minimum.h, bottom + dy));
  if (snap) {
    const xs = [0, width, ...others.flatMap(r => [r.x, r.x + r.w, r.x - TILE_GAP, r.x + r.w + TILE_GAP])];
    const ys = [0, ...others.flatMap(r => [r.y, r.y + r.h, r.y - TILE_GAP, r.y + r.h + TILE_GAP])];
    const x = edge.includes("w") ? nearest(left, xs.filter(v => v >= 0 && v <= right - minimum.w), 10) : edge.includes("e") ? nearest(right, xs.filter(v => v <= width && v >= left + minimum.w), 10) : undefined;
    const y = edge.includes("n") ? nearest(top, ys.filter(v => v >= 0 && v <= bottom - minimum.h), 10) : edge.includes("s") ? nearest(bottom, ys.filter(v => v >= top + minimum.h && v <= top + 2000), 10) : undefined;
    if (x !== undefined) { if (edge.includes("w")) left = x; else right = x; guides.push({ axis: "x", value: x }); }
    if (y !== undefined) { if (edge.includes("n")) top = y; else bottom = y; guides.push({ axis: "y", value: y }); }
  }
  return { rect: { x: left, y: top, w: right - left, h: bottom - top }, guides };
}
