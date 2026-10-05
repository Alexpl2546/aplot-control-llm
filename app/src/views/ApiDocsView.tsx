import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import { fetchOpenApiSpec } from "../services/tauri";
import { Button, Panel, SectionTitle } from "../components/ui/Primitives";

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

export function ApiDocsView() {
  const { t } = useTranslation();
  const runtime = useControlStore(state => state.runtime);
  const runningConfig = useControlStore(state => state.runningConfig);
  const runningEngine = useControlStore(state => state.runningEngine);
  const runningMode = useControlStore(state => state.runningMode);
  const routerSettings = useControlStore(state => state.runningRouterSettings);
  const config = useControlStore(state => state.config);
  const settings = useControlStore(state => state.settings);
  const setView = useControlStore(state => state.setView);
  const [spec, setSpec] = useState<ApiSpecification>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const endpoint = runtime.endpoint.replace(/\/+$/, "");
  const engine = runningEngine ?? settings.serverEngine;
  const apiKey = engine === "qwfnfer" ? runningConfig?.apiKey ?? settings.qwfn.apiKey : engine === "strata" ? settings.strataApiKey : ((runningMode ?? settings.serverMode) === "router" ? routerSettings?.routerApiKey ?? settings.routerApiKey : runningConfig?.apiKey ?? config.apiKey ?? "");
  const running = !["stopped", "crashed"].includes(runtime.state);
  const operations = useMemo(() => Object.entries(spec?.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => httpMethods.has(method.toLowerCase()))
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  ), [spec]);

  const load = async () => {
    if (!running) {
      setError(t("apiDocs.serverStopped"));
      setSpec(undefined);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await fetchOpenApiSpec(endpoint, apiKey, engine);
      setSpec(result as ApiSpecification);
    } catch (reason) {
      setSpec(undefined);
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // `load` reads this view's current endpoint and credential; reload when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, apiKey, engine, running, t]);

  return <div className="page apiDocsPage">
    <SectionTitle
      title={t("apiDocs.title")}
      description={endpoint}
      action={<div className="toolbar"><Button onClick={() => setView("dashboard")}><ArrowLeft size={14}/>{t("apiDocs.back")}</Button><Button disabled={loading || !running} onClick={() => void load()}><RefreshCw size={14}/>{t("apiDocs.refresh")}</Button></div>}
    />
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
  </div>;
}
