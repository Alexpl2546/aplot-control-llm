import { Select } from '../../components/ui/Primitives';
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Panel } from "../../components/ui/Primitives";
import {
  buildLegacyConnectionTarget,
  hermesAvailable, openInHermes,
  isConnectionRunReady,
  listManagedRuns,
  ManagerCommandUnsupportedError,
  runConnectionTarget,
  verifyConnectionTarget,
  type ConnectionTarget,
  type ConnectionVerification,
  type ManagedRunInfo,
} from "../../services/connections";
import {
  HARNESS_ADAPTERS,
  previewJsonProviderMerge,
  previewJsonProviderUndo,
  renderHarnessSnippet,
  type HarnessId,
  type JsonProviderMergePreview,
} from "./harnesses";
import "./connection.css";
import { isTauri } from "../../services/tauri";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import type { TFunction } from "i18next";

type LanguageCopy = {
  run: string; source: string; legacy: string; noRuns: string; loading: string; refreshRuns: string; state: string;
  managed: string; external: string; baseUrl: string; modelId: string; context: string;
  auth: string; authConfigured: string; authNone: string; copyFields: string; copyKey: string;
  hiddenKey: string; readyNeeded: string; verify: string; cancel: string; timeout: string;
  snippets: string; preview: string; copySnippet: string; merge: string; pasteJson: string;
  makePreview: string; previewOnly: string; mergeResult: string; undo: string; undoResult: string;
  noConfiguredModel: string; managerUnavailable: string; runConnectionMissing: string;
  copied: string; copyFailed: string; secretWarning: string; protocolUnsupported: string;
  environment: string; crossNetwork: string; fallbackButton: string; legacySelected: string;
};

const languageKeys = ["run","source","legacy","noRuns","loading","refreshRuns","state","managed","external","baseUrl","modelId","context","auth","authConfigured","authNone","copyFields","copyKey","hiddenKey","readyNeeded","verify","cancel","timeout","snippets","preview","copySnippet","merge","pasteJson","makePreview","previewOnly","mergeResult","undo","undoResult","noConfiguredModel","managerUnavailable","runConnectionMissing","copied","copyFailed","secretWarning","protocolUnsupported","environment","crossNetwork","fallbackButton","legacySelected"] as const;

export interface ConnectionPanelProps {
  initialRunId?: string;
  legacyTarget: ConnectionTarget | null;
  legacyState: string;
  legacyRefreshKey: string;
  onTargetChange: (target: ConnectionTarget | null, state: string, source: "manager" | "legacy") => void;
}

function stateText(value: string, t: TFunction): string {
  return t(`connectionDetail.state.${value}`, { defaultValue: value });
}

function runLabel(run: ManagedRunInfo, fallback: string, t: TFunction): string {
  return `${run.name || fallback} · ${ENGINE_NAMES[run.engine as keyof typeof ENGINE_NAMES] ?? run.engine} · ${stateText(run.state, t)}`;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /api.?key|token|secret|password|authorization/i.test(key)
        ? typeof child === "string" && /^\$\{?APLOT_API_KEY\}?$/.test(child) ? child : "[redacted]"
        : redactSecrets(child),
    ]));
  }
  return value;
}

function checkStatusText(status: string, t: TFunction): string {
  return t(`connectionDetail.check.${status}`, { defaultValue: status });
}

export function ConnectionPanel({ initialRunId, legacyTarget, legacyState, legacyRefreshKey, onTargetChange }: ConnectionPanelProps) {
  const { t } = useTranslation();
  const copy = Object.fromEntries(languageKeys.map(key => [key, t(`connectionDetail.${key}`)])) as LanguageCopy;
  const [runs, setRuns] = useState<ManagedRunInfo[]>([]);
  const [managerSupported, setManagerSupported] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(initialRunId ?? "");
  const selectedRunIdRef = useRef(initialRunId ?? "");
  const [listRevision, setListRevision] = useState(0);
  const [selectedState, setSelectedState] = useState(legacyState);
  const [target, setTarget] = useState<ConnectionTarget | null>(null);
  const [source, setSource] = useState<"manager" | "legacy">("legacy");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [legacyFallbackAvailable, setLegacyFallbackAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<ConnectionVerification>();
  const [verifying, setVerifying] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [harnessId, setHarnessId] = useState<HarnessId>("hermes");
  const [snippet, setSnippet] = useState("");
  const [existingJson, setExistingJson] = useState("");
  const [previewJson, setPreviewJson] = useState("");
  const [mergePlan, setMergePlan] = useState<JsonProviderMergePreview>();
  const [mergeMessage, setMergeMessage] = useState("");
  const [undoMessage, setUndoMessage] = useState("");
  const [hasHermes, setHasHermes] = useState(false);
  const [openingHermes, setOpeningHermes] = useState(false);
  const [hermesNotice, setHermesNotice] = useState("");
  useEffect(() => { void hermesAvailable().then(setHasHermes).catch(() => setHasHermes(false)); }, []);

  const currentAdapter = useMemo(() => HARNESS_ADAPTERS.find(adapter => adapter.id === harnessId)!, [harnessId]);

  const selectRun = (runId: string) => {
    setHermesNotice("");
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
  };
  useEffect(() => {
    if (initialRunId && initialRunId !== selectedRunIdRef.current) {
      selectedRunIdRef.current = initialRunId;
      setSelectedRunId(initialRunId);
      setHermesNotice('');
    }
  }, [initialRunId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void listManagedRuns().then(listing => {
      if (!active) return;
      if (listing.mode === "manager") {
        setManagerSupported(true);
        setRuns(listing.runs);
        const defaultRun = listing.runs.find(run => isConnectionRunReady(run.state)) ?? listing.runs[0];
        const retainedRun = listing.runs.find(run => run.runId === selectedRunIdRef.current);
        const chosenRunId = selectedRunIdRef.current === "legacy-current" && legacyTarget
          ? "legacy-current"
          : retainedRun?.runId ?? defaultRun?.runId ?? (legacyTarget ? "legacy-current" : "");
        selectRun(chosenRunId);
        setLegacyFallbackAvailable(Boolean(legacyTarget));
      } else {
        setManagerSupported(false);
        setRuns([]);
        selectRun(legacyTarget ? "legacy-current" : "");
        setNotice(copy.managerUnavailable);
      }
    }).catch(reason => {
      if (!active) return;
      setManagerSupported(false);
      setRuns([]);
      selectRun(legacyTarget ? "legacy-current" : "");
      setError(String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [legacyRefreshKey, legacyTarget, copy.managerUnavailable, listRevision]);

  useEffect(() => {
    let active = true;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setVerifying(false);
    setError("");
    setVerification(undefined);
    setMergePlan(undefined);
    setMergeMessage("");
    setUndoMessage("");
    if (selectedRunId === "legacy-current") {
      setTarget(legacyTarget);
      setSelectedState(legacyState);
      setSource("legacy");
      setNotice(managerSupported ? copy.legacySelected : copy.managerUnavailable);
      onTargetChange(legacyTarget, legacyState, "legacy");
      return () => { active = false; };
    }
    const selected = runs.find(run => run.runId === selectedRunId);
    if (!selected) {
      setTarget(null);
      setSelectedState("stopped");
      onTargetChange(null, "stopped", "manager");
      return () => { active = false; };
    }
    setTarget(null);
    onTargetChange(null, selected.state, "manager");
    setSelectedState(selected.state);
    setSource("manager");
    if (!isConnectionRunReady(selected.state)) {
      setError(t('connections.startServer'));
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void runConnectionTarget(selected.runId).then(connection => {
      if (!active) return;
      setTarget(connection);
      onTargetChange(connection, selected.state, "manager");
      setNotice("");
    }).catch(reason => {
      if (!active) return;
      setTarget(null);
      onTargetChange(null, selected.state, "manager");
      if (reason instanceof ManagerCommandUnsupportedError) {
        setLegacyFallbackAvailable(Boolean(legacyTarget));
        setNotice(copy.runConnectionMissing);
      } else setError(String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedRunId, runs, legacyTarget, legacyState, managerSupported, onTargetChange, copy.managerUnavailable, copy.runConnectionMissing, t]);

  useEffect(() => {
    if (!target) { setSnippet(""); return; }
    try { setSnippet(renderHarnessSnippet(harnessId, target).text); }
    catch (reason) { setSnippet(String(reason)); }
  }, [harnessId, target]);

  const isReady = isConnectionRunReady(selectedState);
  const sourceLabel = source === "manager" ? "run_connection" : "legacy single-run fallback";

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(copy.copied);
    } catch {
      setNotice(copy.copyFailed);
    }
  };

  const copyFields = () => {
    if (!target) return;
    void copyText([
      `Base URL: ${target.baseUrl}`,
      `Model: ${target.modelId}`,
      `Context tokens: ${target.contextTokens > 0 ? target.contextTokens : "unknown"}`,
      `Authentication: ${target.apiKey ? "Bearer API key configured; copy separately" : "No API key configured"}`,
    ].join("\n"));
  };

  const verify = async () => {
    if (!target || !isReady) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setVerifying(true);
    setVerification(undefined);
    setNotice("");
    try {
      setVerification(await verifyConnectionTarget(target, { timeoutMs: 30_000, signal: controller.signal }));
    } finally {
      abortRef.current = undefined;
      setVerifying(false);
    }
  };

  const createMergePreview = () => {
    if (!target) return;
    try {
      const existing = JSON.parse(existingJson);
      const plan = previewJsonProviderMerge(harnessId, existing, target);
      setMergePlan(plan);
      setMergeMessage(plan.detail);
      setUndoMessage("");
      setPreviewJson("");
      if (plan.mergedConfig) setPreviewJson(JSON.stringify(redactSecrets(plan.mergedConfig), null, 2));
    } catch (reason) {
      setMergePlan(undefined);
      setMergeMessage(`Invalid JSON: ${String(reason)}`);
      setPreviewJson("");
    }
  };

  const previewUndo = () => {
    if (!mergePlan) return;
    try {
      const result = previewJsonProviderUndo(mergePlan, JSON.parse(previewJson));
      setUndoMessage(result.detail);
      if (result.config) setPreviewJson(JSON.stringify(redactSecrets(result.config), null, 2));
    } catch (reason) {
      setUndoMessage(`Invalid JSON: ${String(reason)}`);
    }
  };

  return <Panel className="apiConnectionPanel">
    <div className="apiConnectionHeader">
      <div><h3>{t('connections.title')}</h3><p>{t('connections.description')}</p></div>
      <div className="toolbar apiConnectionRunActions">
      <Button disabled={loading} onClick={() => setListRevision(revision => revision + 1)}>{t('connections.refreshServers')}</Button>
      {managerSupported && runs.length > 0 && <ChoiceSelect label={t('connections.server')} value={selectedRunId} disabled={openingHermes} onChange={selectRun} options={runs.map((run, index) => ({ value: run.runId, label: runLabel(run, t('k.serverNumber', { number: index + 1 }), t) }))}/>}

      </div>
    </div>
    {loading && <p className="subtle">{copy.loading}</p>}
    {!loading && !target && !error && <p className="apiConnectionNotice">{managerSupported && runs.length === 0 && legacyTarget ? copy.noRuns : copy.noConfiguredModel}</p>}
    {error && <p className="apiConnectionError">{error}</p>}
    {notice && source !== "legacy" && <p className="apiConnectionNotice">{notice}</p>}
    {!target && legacyFallbackAvailable && selectedRunId !== "legacy-current" && legacyTarget && <Button onClick={() => selectRun("legacy-current")}>{copy.fallbackButton}</Button>}
    {target && <>
      <div className="apiConnectSummary">
        <div><span>{t('connections.model')}</span><strong>{target.modelId}</strong></div>
        <div><span>{t('connections.address')}</span><code>{target.baseUrl}</code></div>
        <div><span>{copy.state}</span><strong className={isReady ? 'connectionReady' : 'connectionNotReady'}>{stateText(selectedState, t)}</strong></div>
      </div>
      <div className="apiConnectApp">
        <div><h4>Hermes Agent</h4><p>{t('connections.hermesDescription')}</p></div>
        <Button className="primary" disabled={!isReady || !hasHermes || source !== 'manager' || openingHermes} onClick={() => {
          setOpeningHermes(true); setHermesNotice('');
          void openInHermes(target.runId).then(result => setHermesNotice(t('connections.hermesOpened', { model: result.modelId }))).catch(reason => {
            const code = String(reason).replace(/^Error: /, '');
            setHermesNotice(t(['not-installed', 'server-unavailable', 'server-changed', 'configuration-failed', 'launch-failed'].includes(code) ? `connections.hermesErrors.${code}` : 'connections.hermesErrors.launch-failed'));
          }).finally(() => setOpeningHermes(false));
        }}>{t(openingHermes ? 'connections.openingHermes' : 'connections.openHermes')}</Button>
      </div>
      {!hasHermes && <p className="apiConnectionNotice">{t(isTauri() ? 'connections.hermesUnavailable' : 'connections.desktopPreview')}</p>}
      {hermesNotice && <p role="status" className="apiConnectionNotice">{hermesNotice}</p>}
      <details className="apiConnectionDetails"><summary>{t('connections.manual')}</summary>
      <div className="apiConnectionFacts">
        <div><small>{copy.source}</small><code>{sourceLabel}</code></div>
        <div><small>{copy.state}</small><strong className={isReady ? "connectionReady" : "connectionNotReady"}>{stateText(selectedState, t)}</strong></div>
        <div><small>{t("connectionDetail.ownership")}</small><strong>{target.managed ? copy.managed : copy.external}</strong></div>
        <div><small>{copy.baseUrl}</small><code>{target.baseUrl}</code></div>
        <div><small>{copy.modelId}</small><code>{target.modelId || copy.noConfiguredModel}</code></div>
        <div><small>{copy.context}</small><code>{target.contextTokens > 0 ? target.contextTokens.toLocaleString() : "—"}</code></div>
        <div><small>{copy.auth}</small><strong>{target.apiKey ? copy.authConfigured : copy.authNone}</strong></div>
      </div>
      <div className="toolbar apiConnectionActions">
        <Button onClick={copyFields}>{copy.copyFields}</Button>
        {target.apiKey && <Button onClick={() => void copyText(target.apiKey)}>{copy.copyKey}</Button>}
        {verifying
          ? <Button onClick={() => abortRef.current?.abort()}>{copy.cancel}</Button>
          : <Button disabled={!isReady || !target.modelId} onClick={() => void verify()}>{copy.verify}</Button>}
        <small>{copy.timeout}</small>
      </div>
      {!isReady && <p className="apiConnectionNotice">{copy.readyNeeded}</p>}
      {!target.modelId && <p className="apiConnectionNotice">{copy.noConfiguredModel}</p>}
      <p className="apiConnectionNetworkHint">{copy.environment} {copy.crossNetwork}</p>
      {verification && <div className="apiVerification" aria-live="polite">
        <div className={`apiVerificationSummary ${verification.status}`}>{t("connectionDetail.verification")}: {checkStatusText(verification.status, t)}</div>
        {verification.checks.map(check => <div className="apiVerificationRow" key={check.level}>
          <strong>{check.level === "health" ? t("connectionDetail.health") : check.level === "model-list" ? t("connectionDetail.modelList") : t("connectionDetail.streaming")}</strong>
          <span className={`apiVerificationStatus ${check.status}`}>{checkStatusText(check.status, t)}</span>
          <span>{check.detail}</span>
        </div>)}
      </div>}
      <div className="apiHarnessPreview">
        <div className="apiHarnessHeading"><h4>{copy.snippets}</h4><Select aria-label={copy.snippets} className="uiSelect" value={harnessId} onChange={event => { setHarnessId(event.target.value as HarnessId); setMergePlan(undefined); setMergeMessage(""); setUndoMessage(""); }}>
          {HARNESS_ADAPTERS.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.displayName}</option>)}
        </Select></div>
        <div className="apiHarnessMeta"><code>{currentAdapter.configLocation}</code><a href={currentAdapter.docsUrl} target="_blank" rel="noreferrer">{t("connectionDetail.schema")}</a><span>{t("connectionDetail.harnessUnchecked")}</span></div>
        <pre className="apiHarnessSnippet">{snippet || copy.protocolUnsupported}</pre>
        <div className="toolbar"><Button disabled={!snippet || !target} onClick={() => void copyText(snippet)}>{copy.copySnippet}</Button></div>
        {renderHarnessSnippet(harnessId, target).notes.map(note => <small className="apiHarnessNote" key={note}>{note}</small>)}
        {currentAdapter.mergeMode === "json-provider-add" && <div className="apiJsonMergePreview">
          <h4>{copy.merge}</h4>
          <p>{copy.previewOnly}</p>
          <textarea className="uiTextarea mono" rows={5} value={existingJson} placeholder={copy.pasteJson} onChange={event => setExistingJson(event.target.value)}/>
          <Button disabled={!existingJson.trim()} onClick={createMergePreview}>{copy.makePreview}</Button>
          {mergeMessage && <p className={mergePlan?.status === "conflict" ? "apiConnectionError" : "apiConnectionNotice"}>{mergePlan ? `${mergePlan.status}: ${mergeMessage} (${mergePlan.path})` : mergeMessage}</p>}
          {previewJson && <label className="apiPreviewJsonLabel">{copy.mergeResult}<textarea className="uiTextarea mono" rows={7} value={previewJson} onChange={event => setPreviewJson(event.target.value)}/></label>}
          {mergePlan?.status === "added" && previewJson && <Button onClick={previewUndo}>{copy.undo}</Button>}
          {undoMessage && <p className={undoMessage.toLowerCase().includes("changed") ? "apiConnectionError" : "apiConnectionNotice"}>{copy.undoResult}: {undoMessage}</p>}
        </div>}
      </div>
      </details>
    </>}
  </Panel>;
}
