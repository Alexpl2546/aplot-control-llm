import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import { fetchOpenApiSpec } from "../services/tauri";
import { buildLegacyConnectionTarget, type ConnectionTarget } from "../services/connections";
import { ConnectionPanel } from "../features/connections/ConnectionPanel";
import { Button, Panel, SectionTitle } from "../components/ui/Primitives";
import type { ServerEngine } from "../types/app";
import { routerModelId } from "../lib/router";
import { isSupportedProfileEngine } from "../features/launches/profiles";

type ApiOperation = {
  summary?: string;
  description?: string;
  operationId?: string;
  security?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
};
type ApiSpecification = {
  "x-aplot-source"?: string;
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, ApiOperation>>;
};
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

export function ApiDocsView({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const runtime = useControlStore(state => state.runtime);
  const runningConfig = useControlStore(state => state.runningConfig);
  const runningEngine = useControlStore(state => state.runningEngine);
  const runningMode = useControlStore(state => state.runningMode);
  const routerSettings = useControlStore(state => state.runningRouterSettings);
  const config = useControlStore(state => state.config);
  const profiles = useControlStore(state => state.profiles);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const settings = useControlStore(state => state.settings);
  const setView = useControlStore(state => state.setView);
  const [spec, setSpec] = useState<ApiSpecification>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null);
  const [connectionState, setConnectionState] = useState<string>(runtime.state);
  const [connectionResolved, setConnectionResolved] = useState(false);
  const loadVersion = useRef(0);
  const legacyEngine = runningEngine ?? settings.serverEngine;
  const supportedLegacyEngine = isSupportedProfileEngine(legacyEngine) ? legacyEngine : undefined;
  const legacyApiKey = supportedLegacyEngine === "strata" ? settings.strataApiKey : ((runningMode ?? settings.serverMode) === "router" ? routerSettings?.routerApiKey ?? settings.routerApiKey : runningConfig?.apiKey ?? config.apiKey ?? "");
  const legacyRouterMode = legacyEngine === "llama_cpp" && (runningMode ?? settings.serverMode) === "router";
  const legacyProfile = profiles.find(profile => profile.id === (runningConfig ?? config).profileId);
  const legacyModelId = legacyRouterMode
    ? legacyProfile ? routerModelId(legacyProfile, profiles) : runningConfig?.profileName || config.profileName
    : runtime.modelName
      || runningConfig?.modelAlias
      || runningConfig?.profileName || "";
  const legacyContext = runningConfig?.ctxSize || config.ctxSize;
  const legacyTarget = useMemo(() => supportedLegacyEngine ? buildLegacyConnectionTarget({
    engine: supportedLegacyEngine,
    endpoint: runtime.endpoint,
    modelId: legacyModelId,
    contextTokens: legacyContext,
    apiKey: legacyApiKey,
    managed: true,
  }) : null, [supportedLegacyEngine, runtime.endpoint, legacyModelId, legacyContext, legacyApiKey]);
  const onConnectionTargetChange = useCallback((target: ConnectionTarget | null, state: string, _source: "manager" | "legacy") => {
    loadVersion.current += 1;
    setConnectionTarget(target);
    setConnectionState(state);

    setConnectionResolved(true);
  }, []);
  const baseUrl = connectionTarget?.baseUrl ?? legacyTarget?.baseUrl ?? "";
  const endpoint = baseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
  const engine = connectionTarget?.engine ?? legacyEngine;
  const apiKey = connectionTarget?.apiKey ?? legacyApiKey;
  const running = Boolean(connectionTarget) && ["ready", "busy"].includes(connectionState);
  const operations = useMemo(() => Object.entries(spec?.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => httpMethods.has(method.toLowerCase()))
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  ), [spec]);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    if (!connectionResolved) return;
    if (!connectionTarget || !running) {
      setLoading(false);
      setError(t("apiDocs.serverStopped"));
      setSpec(undefined);
      return;
    }
    setLoading(true);
    setError("");
    try {
      if (!isSupportedProfileEngine(engine)) throw new Error(t("profiles.unsupportedEngine", { engine }));
      const result = await fetchOpenApiSpec(endpoint, apiKey, engine);
      if (version === loadVersion.current) setSpec(result as ApiSpecification);
    } catch (reason) {
      if (version === loadVersion.current) {
        setSpec(undefined);
        setError(String(reason));
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [connectionResolved, connectionTarget, running, engine, endpoint, apiKey, t]);

  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
  }, [load]);

  return <div className="page apiDocsPage">
    {!embedded && <SectionTitle
      title={t("apiDocs.title")}
      action={<div className="toolbar"><Button onClick={() => setView("dashboard")}><ArrowLeft size={14}/>{t("apiDocs.back")}</Button></div>}
    />}
    <ConnectionPanel
      initialRunId={selectedRunId ?? undefined}
      legacyTarget={legacyTarget}
      legacyState={runtime.state}
      legacyRefreshKey={`${runtime.state}|${runtime.endpoint}|${legacyEngine}|${legacyModelId}|${legacyContext}`}
      onTargetChange={onConnectionTargetChange}
    />
    <details className="apiDocumentation"><summary>{t('connections.documentation')}</summary><Button disabled={loading || !running} onClick={() => void load()}><RefreshCw size={14}/>{t("apiDocs.refresh")}</Button>
    {loading && <Panel className="apiDocsMessage">{t("apiDocs.loading")}</Panel>}
    {!loading && error && <Panel className="apiDocsMessage apiDocsError"><b>{t("apiDocs.unavailable")}</b><p>{error}</p></Panel>}
    {!loading && spec && <>
      <Panel className="apiDocsIntro">
        <div><h2>{spec.info?.title ?? t("apiDocs.title")}</h2><span>{t("apiDocs.version", { version: spec.info?.version ?? "—" })}</span></div>
        {spec.info?.description && <p>{spec.info.description}</p>}
        <small>{spec["x-aplot-source"] ? t("apiDocs.bundled") : t("apiDocs.authenticated")}</small>
      </Panel>
      <div className="apiOperations">
        {operations.length ? operations.map(({ path, method, operation }) => <details className="apiOperation" key={`${method}:${path}`}>
          <summary><span className={`apiMethod ${method.toLowerCase()}`}>{method}</span><code>{path}</code><b>{operation.summary ?? operation.operationId ?? ""}</b></summary>
          <div className="apiOperationBody">
            {operation.description && <p>{operation.description}</p>}
            {operation.security?.length ? <small>{t("apiDocs.requiresKey")}</small> : <small>{t("apiDocs.noKey")}</small>}
            {operation.requestBody != null && <pre>{JSON.stringify(operation.requestBody, null, 2)}</pre>}
            {operation.responses && <pre>{JSON.stringify(operation.responses, null, 2)}</pre>}
          </div>
        </details>) : <Panel className="apiDocsMessage">{t("apiDocs.noOperations")}</Panel>}
      </div>
      <details className="apiRawSpec"><summary>{t("apiDocs.rawSpec")}</summary><pre>{JSON.stringify(spec, null, 2)}</pre></details>
    </>}
    </details>
  </div>;
}
