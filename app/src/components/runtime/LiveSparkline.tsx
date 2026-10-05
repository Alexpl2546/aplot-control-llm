import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import "./LiveSparkline.css";

interface LiveSparklineProps {
  values: number[];
  timestamps?: number[];
  tone: "green" | "blue" | "violet" | "orange" | "muted";
  label: string;
  unit?: string;
  fractionDigits?: number;
  secondaryValues?: (number | null | undefined)[];
  secondaryLabel?: string;
}

export function LiveSparkline({ values, timestamps, tone, label, unit, fractionDigits = 1, secondaryValues, secondaryLabel }: LiveSparklineProps) {
  const { i18n } = useTranslation();
  const tooltipId = useId();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const pointsWithTime = values.map((value, index) => ({ value, timestamp: timestamps?.[index], secondary: secondaryValues?.[index] })).filter(point => Number.isFinite(point.value));
  const samples = timestamps ? pointsWithTime : pointsWithTime.slice(-72);
  if (!samples.length || (!timestamps && samples.length < 2)) return <span className="liveSparkline empty" aria-hidden="true" />;

  const low = Math.min(...samples.map(point => point.value));
  const range = Math.max(1, Math.max(...samples.map(point => point.value)) - low);
  const start = samples[0].timestamp;
  const end = samples[samples.length - 1].timestamp;
  const timed = start != null && end != null && end > start;
  const positions = samples.map(({ value, timestamp }, index) => ({
    x: timed && timestamp != null ? (timestamp - start) / (end - start) * 100 : samples.length === 1 ? 50 : index / (samples.length - 1) * 100,
    y: 24 - (value - low) / range * 19,
  }));
  const points = positions.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const activeIndex = hoverX == null ? -1 : positions.reduce((nearest, point, index) => Math.abs(point.x - hoverX) < Math.abs(positions[nearest].x - hoverX) ? index : nearest, 0);
  const active = samples[activeIndex];
  const activePosition = positions[activeIndex];
  const formattedValue = active ? `${active.value.toLocaleString(i18n.language, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}${unit ? ` ${unit}` : ""}` : "";

  const chart = (
    <svg className={`liveSparkline ${tone}`} viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label={label}
      tabIndex={timestamps ? 0 : undefined}
      aria-describedby={active ? tooltipId : undefined}
      onPointerMove={timestamps ? event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width) setHoverX(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)));
      } : undefined}
      onPointerLeave={() => setHoverX(null)}
      onFocus={timestamps ? () => setHoverX(positions[positions.length - 1].x) : undefined}
      onBlur={() => setHoverX(null)}
      onKeyDown={timestamps ? event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Escape") { setHoverX(null); return; }
        const current = activeIndex < 0 ? samples.length - 1 : activeIndex;
        const next = event.key === "Home" ? 0 : event.key === "End" ? samples.length - 1 : Math.max(0, Math.min(samples.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1)));
        setHoverX(positions[next].x);
      } : undefined}>
      <polyline points={points} />
    </svg>
  );
  return timestamps ? <div className="timedSparkline"><div className={`sparklinePlot ${tone}`}>
    {chart}
    {(activePosition || samples.length === 1) && <span className="sparklineMarker" aria-hidden="true" style={{ left: `${(activePosition ?? positions[0]).x}%`, top: `${(activePosition ?? positions[0]).y / 28 * 100}%` }}/>}
    {active && <>
      <span className="sparklineCursor" aria-hidden="true" style={{ left: `${activePosition.x}%` }}/>
      <div className={`sparklineTooltip ${activePosition.x > 50 ? "alignRight" : ""}`} id={tooltipId} role="tooltip">
        {active.timestamp != null && <time dateTime={new Date(active.timestamp).toISOString()}>{formatTime(active.timestamp)}</time>}
        <span>{label}: <strong>{formattedValue}</strong></span>
        {active.secondary != null && Number.isFinite(active.secondary) && <span className="sparklineSecondary">{secondaryLabel}: <strong>{active.secondary.toLocaleString(i18n.language, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}{unit ? ` ${unit}` : ""}</strong></span>}
      </div>
    </>}
  </div>{timed && <div className="sparklineTimeAxis"><span>{formatTime(start)}</span><span>{formatTime((start + end) / 2)}</span><span>{formatTime(end)}</span></div>}</div> : chart;
}
