import { memo, useMemo, type CSSProperties } from "react";
import { useControlStore } from "../../store/control";
import { isActive, runColor } from "../../features/launches/presentation";

/** Anchor points for server auras; chosen so 1–4 lights never stack on top of each other. */
const SPOTS = [
  { x: "78%", y: "18%" },
  { x: "22%", y: "88%" },
  { x: "92%", y: "82%" },
  { x: "46%", y: "-6%" },
];

/**
 * The light field behind the glass. Each running server tints one aura with its channel colour;
 * a server that is generating right now glows stronger and breathes. Pure CSS transforms and
 * opacity — no canvas, no blur filters — so it costs nothing while idle.
 */
export const AmbientField = memo(function AmbientField() {
  const runs = useControlStore(state => state.runs);
  const lights = useMemo(() => runs
    .filter(run => isActive(run.info.state))
    .slice(0, SPOTS.length)
    .map((run, index) => ({
      id: run.info.runId,
      color: runColor(run.info.runId),
      working: run.info.state === "busy" || run.runtime.generationTps > 0,
      spot: SPOTS[index]!,
    })), [runs]);

  return <div className="kAmbient" aria-hidden="true">
    <span className="kAura isBase" style={{ "--x": "8%", "--y": "6%" } as CSSProperties}/>
    {lights.map((light, index) => <span key={light.id}
      className={`kAura isRun${light.working ? " isWorking" : ""}`}
      style={{ "--x": light.spot.x, "--y": light.spot.y, "--c": light.color, "--d": `${38 + index * 9}s` } as CSSProperties}/>)}
    <span className="kAmbientHorizon"/>
  </div>;
});
