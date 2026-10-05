import { GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DashboardLayout, DashboardRect, DashboardWidgetId } from "../../types/app";
import { moveDashboardTile, projectDashboardLayout, resizeDashboardTile, resolveDashboardCollisions, saveDashboardRects, tileMinimum, type DashboardRects, type ResizeEdge, type SnapGuide } from "../../lib/dashboardLayout";
import "./DashboardCanvas.css";

interface Props {
  widgets: DashboardWidgetId[];
  layout: DashboardLayout | null;
  editing: boolean;
  disabled: boolean;
  label: (id: DashboardWidgetId) => string;
  renderWidget: (id: DashboardWidgetId) => ReactNode;
  onChange: (layout: DashboardLayout) => void;
}
interface Gesture {
  id: DashboardWidgetId;
  edge?: ResizeEdge;
  startX: number; startY: number;
  clientX: number; clientY: number;
  zoom: number; scrollTop: number;
  rect: DashboardRect; rects: DashboardRects;
  width: number; bottom: number;
  altKey: boolean;
  scroller: HTMLElement | null;
}
const edges: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function DashboardCanvas({ widgets, layout, editing, disabled, label, renderWidget, onChange }: Props) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef<DashboardRects | null>(null);
  const [width, setWidth] = useState(1200);
  const [preview, setPreview] = useState<DashboardRects | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [active, setActive] = useState<DashboardWidgetId | null>(null);
  const projected = useMemo(() => projectDashboardLayout(layout, widgets, width), [layout, widgets, width]);
  const rects = preview ?? projected;
  const height = Math.max(200, ...Object.values(rects).map(r => r.y + r.h)) + (editing ? 240 : 0);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const cancelGesture = () => {
    gesture.current = null; latest.current = null; cancelFrame();
    setPreview(null); setGuides([]); setActive(null);
  };

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && gesture.current) { event.preventDefault(); cancelGesture(); } };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);

  const updateGesture = () => {
    const g = gesture.current;
    if (!g) return;
    const dx = (g.clientX - g.startX) / g.zoom;
    const dy = (g.clientY - g.startY) / g.zoom + (g.scroller?.scrollTop ?? 0) - g.scrollTop;
    const others = Object.entries(g.rects).filter(([id]) => id !== g.id).map(([, r]) => r);
    const minimum = tileMinimum(g.id);
    minimum.w = Math.min(minimum.w, g.width);
    const moved = g.edge
      ? resizeDashboardTile(g.rect, g.edge, dx, dy, others, g.width, minimum, !g.altKey)
      : moveDashboardTile(g.rect, dx, dy, others, g.width, g.bottom, !g.altKey);
    latest.current = resolveDashboardCollisions({ ...g.rects, [g.id]: moved.rect }, g.id);
    setPreview(latest.current); setGuides(moved.guides);
  };
  const autoScroll = () => {
    const g = gesture.current;
    if (!g) return;
    if (g.scroller) {
      const bounds = g.scroller.getBoundingClientRect();
      const delta = g.clientY < Math.max(0, bounds.top) + 55 ? -12 : g.clientY > Math.min(window.innerHeight, bounds.bottom) - 55 ? 12 : 0;
      if (delta) { g.scroller.scrollTop += delta / g.zoom; updateGesture(); }
    }
    frame.current = requestAnimationFrame(autoScroll);
  };
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, id: DashboardWidgetId, edge?: ResizeEdge) => {
    if (!editing || disabled || event.button !== 0 || !canvas.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const bounds = canvas.current.getBoundingClientRect();
    let scroller: HTMLElement | null = canvas.current.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    gesture.current = { id, edge, startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY, zoom: bounds.width / width, scrollTop: scroller?.scrollTop ?? 0, rect: { ...rects[id]! }, rects, width, bottom: height - 240, altKey: event.altKey, scroller };
    latest.current = rects;
    setActive(id); frame.current = requestAnimationFrame(autoScroll);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g) return;
    g.clientX = event.clientX; g.clientY = event.clientY; g.altKey = event.altKey;
    updateGesture();
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!gesture.current) return;
    move(event);
    const next = latest.current;
    gesture.current = null; cancelFrame(); latest.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (next) onChange(saveDashboardRects(next, width, layout));
    setPreview(null); setGuides([]); setActive(null);
  };

  return <div ref={canvas} className={`dashboardCanvas${editing ? " isEditing" : ""}`} aria-label={t("dashboard.tiles")} style={{ height }}>
    {widgets.map(id => {
      const rect = rects[id]!;
      return <article key={id} data-widget-id={id} className={`dashboardTile canvasTile tile-${id.split(".")[0]} tile-${id.replace(".", "-")}${active === id ? " isManipulating" : ""}`} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
        <div className="dashboardTileContent">{renderWidget(id)}</div>
        {editing && <>
          <button type="button" className="canvasMove" disabled={disabled} aria-label={t("dashboard.dragTile", { name: label(id) })} title={t("dashboard.moveHelp")} onPointerDown={event => begin(event, id)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}
            onKeyDown={event => {
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || gesture.current) return;
              event.preventDefault();
              const step = event.altKey ? 1 : 10;
              const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
              const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
              const others = Object.entries(rects).filter(([key]) => key !== id).map(([, r]) => r);
              const minimum = tileMinimum(id); minimum.w = Math.min(width, minimum.w);
              const next = event.shiftKey ? resizeDashboardTile(rect, "se", dx, dy, others, width, minimum, false) : moveDashboardTile(rect, dx, dy, others, width, height - 240, false);
              onChange(saveDashboardRects(resolveDashboardCollisions({ ...rects, [id]: next.rect }, id), width, layout));
            }}><GripVertical size={17}/></button>
          {edges.map(edge => <button key={edge} type="button" className={`canvasResize resize-${edge}`} disabled={disabled} tabIndex={edge === "se" ? 0 : -1} aria-label={t("dashboard.resizeTile", { name: label(id) })} title={t("dashboard.resizeHelp")} onPointerDown={event => begin(event, id, edge)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}
            onKeyDown={event => {
              if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || gesture.current) return;
              event.preventDefault();
              const step = event.altKey ? 1 : 10;
              const minimum = tileMinimum(id); minimum.w = Math.min(width, minimum.w);
              const next = resizeDashboardTile(rect, "se", event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, [], width, minimum, false);
              onChange(saveDashboardRects(resolveDashboardCollisions({ ...rects, [id]: next.rect }, id), width, layout));
            }}/>) }
        </>}
      </article>;
    })}
    {guides.map((guide, index) => <div key={index} aria-hidden="true" className={`canvasGuide guide-${guide.axis}`} style={guide.axis === "x" ? { left: guide.value } : { top: guide.value }}/>) }
    {editing && <div className="canvasFreeSpace" style={{ top: height - 200 }}>{t("dashboard.freeSpace")}</div>}
  </div>;
}
