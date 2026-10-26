import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Panel } from "../../components/ui/Primitives";
import { isTauri } from "../../services/tauri";
import type { StartRunRequest } from "../../types/runtime";
import type { ByteRange, ResourceEstimate, ResourcePlan } from "./types";

export interface NativeResourcePlan extends ResourcePlan {
  warnings: string[];
  activeRuns: Array<{ runId: string; generation: number; state: string; estimate: ResourceEstimate; accountingMode: string }>;
}
export interface ResourcePlanPanelProps { request: StartRunRequest | null; disabled?: boolean }
const labelsKeys = ["title","action","loading","note","desktop","pending","stale","context","ram","gpu","status","variant","reasons","warnings","active","confidence","unknown","advisory","withinEstimate","insufficient","configured","allGpu","hybrid","cpu","reducedContext","engineManaged","low","medium","failed"] as const;
const GiB = 1024 ** 3;
function formatRange(range: ByteRange): string {
  const number = (bytes: number) => (bytes / GiB).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return range.max === null ? `${number(range.min)}–?` : range.min === range.max ? number(range.min) : `${number(range.min)}–${number(range.max)}`;
}
/** Explicit read-only request; no demo hardware results and no configuration writes. */
export function ResourcePlanPanel({ request, disabled = false }: ResourcePlanPanelProps) {
  const { t } = useTranslation();
  const copy = Object.fromEntries(labelsKeys.map(key => [key, t(`resourcePlan.${key}`)])) as Record<typeof labelsKeys[number], string>;
  const fingerprint = useMemo(() => JSON.stringify(request), [request]);
  const epoch = useRef(0);
  const planPresent = useRef(false);
  const [plan, setPlan] = useState<NativeResourcePlan>(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  useEffect(() => { epoch.current += 1; setStale(planPresent.current); planPresent.current = false; setPlan(undefined); setError(""); setBusy(false); }, [fingerprint]);
  useEffect(() => () => { epoch.current += 1; }, []);
  const calculate = async () => {
    if (!request || disabled || !isTauri()) return;
    const token = ++epoch.current; planPresent.current = false; setBusy(true); setError(""); setStale(false); setPlan(undefined);
    try {
      const result = await invoke<NativeResourcePlan>("plan_run_resources", { request });
      if (epoch.current === token) {
        if (result.contractVersion !== 1 || result.automaticApplication !== false || !Array.isArray(result.candidates)) throw new Error(copy.failed);
        planPresent.current = true; setPlan(result);
      }
    } catch (reason) { if (epoch.current === token) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (epoch.current === token) setBusy(false); }
  };
  const cell = { padding: "7px 9px", textAlign: "left" as const, verticalAlign: "top" as const, borderBottom: "1px solid var(--line)" };
  return <Panel className="resourcePlanPanel">
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{copy.title}</h3>
      <Button disabled={disabled || busy || !request || !isTauri()} onClick={() => void calculate()}>{busy ? copy.loading : copy.action}</Button>
    </div>
    <p className="subtle" style={{ margin: "8px 0", fontSize: 11 }}>{!isTauri() ? copy.desktop : !request ? copy.pending : stale ? copy.stale : copy.note}</p>
    {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{error}</p>}
    {plan && <>
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: 11 }}>
        <thead><tr>{[copy.variant, copy.context, copy.ram, copy.gpu, copy.status].map(label => <th style={cell} key={label}>{label}</th>)}</tr></thead>
        <tbody>{plan.candidates.map(candidate => <tr key={candidate.id}>
          <td style={cell}>{copy[candidate.id]}<small className="subtle" style={{ display: "block" }}>{copy[candidate.placement]}{candidate.gpuLayers !== null ? ` · ${candidate.gpuLayers}` : ""}</small></td>
          <td style={cell}>{candidate.contextTokens.toLocaleString()}</td>
          <td style={cell}>{formatRange(candidate.estimate.ram)}</td>
          <td style={cell}>{Object.entries(candidate.estimate.gpus).length ? Object.entries(candidate.estimate.gpus).map(([id, value]) => <div key={id}>{id}: {formatRange(value)}</div>) : "0"}</td>
          <td style={cell}><Badge tone={candidate.status === "insufficient" ? "red" : candidate.status === "withinEstimate" ? "blue" : "orange"}>{copy[candidate.status]}</Badge>
            <small className="subtle" style={{ display: "block", marginTop: 4 }}>{copy.confidence}: {copy[candidate.estimate.confidence]}</small>
            <details style={{ marginTop: 5 }}><summary>{copy.reasons}</summary><ul style={{ paddingLeft: 14, maxWidth: 360 }}>{candidate.estimate.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>
          </td>
        </tr>)}</tbody>
      </table></div>
      <details style={{ marginTop: 9, fontSize: 11 }}><summary>{copy.warnings} · {copy.active}: {plan.activeRuns.length}</summary>
        <ul style={{ paddingLeft: 17 }}>{plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </details>
    </>}
  </Panel>;
}
