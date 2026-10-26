import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Panel } from "../../components/ui/Primitives";
import { isTauri } from "../../services/tauri";
import type { ArtifactCatalog } from "./artifactCatalog";
import { loadArtifactCatalog } from "./artifactCatalogBridge";

const size = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 3 })} GiB`;

export function ArtifactCatalogPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ArtifactCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const refresh = async () => {
    const token = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await loadArtifactCatalog();
      if (token === request.current) setCatalog(result);
    } catch (cause) {
      if (token === request.current) setError(String(cause));
    } finally { if (token === request.current) setLoading(false); }
  };
  return <Panel><details open={open} onToggle={event => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (expanded && isTauri() && !catalog && !loading && !error) void refresh();
  }}>
    <summary>{t("artifactCatalog.title")}</summary>
    <p>{t("artifactCatalog.hint")}</p>
    {!isTauri() ? <p>{t("artifactCatalog.nativeOnly")}</p> : <>
      <Button disabled={loading} onClick={() => void refresh()}><RefreshCw size={14}/>{t("models.rescan")}</Button>
      {loading && <p role="status">{t("artifactCatalog.scanning")}</p>}
      {error && <p role="alert">{error}</p>}
      {catalog && <>
        <p>{t("artifactCatalog.scannedAt")}: {catalog.scannedAt} · {t("artifactCatalog.logical")}: {size(catalog.logicalBytes)} · {t("artifactCatalog.physical")}: {size(catalog.uniquePhysicalBytes)}</p>
        <details><summary>{t("artifactCatalog.roots")} ({catalog.roots.length})</summary><ul>{catalog.roots.map(path => <li key={path} style={{ overflowWrap: "anywhere" }}><code>{path}</code></li>)}</ul></details>
        {!catalog.artifacts.length && <p>{t("artifactCatalog.empty")}</p>}
        {catalog.artifacts.map(artifact => <details key={artifact.id}>
          <summary>{artifact.displayName} · <Badge tone={artifact.state === "complete" ? "green" : "orange"}>{t(`artifactCatalog.state.${artifact.state}`)}</Badge> · {artifact.files.length} {t("artifactCatalog.files")} · {size(artifact.logicalBytes)}</summary>
          <p>{artifact.kind} · {t("artifactCatalog.physical")}: {size(artifact.uniquePhysicalBytes)} · {t("artifactCatalog.identity")}: {artifact.identityConfidence}</p>
          <p>{t("artifactCatalog.dependencies")}: {artifact.dependencyIds.map(id => catalog.artifacts.find(item => item.id === id)?.displayName ?? id).join(", ") || "—"}</p>
          <p style={{ overflowWrap: "anywhere" }}>{t("artifactCatalog.consumers")}: {artifact.consumerIds.join(", ") || "—"}</p>
          <ul>{artifact.files.map(file => <li key={file.path} style={{ overflowWrap: "anywhere" }}>
            <code>{file.path}</code> · {file.role} · {t(`artifactCatalog.state.${file.state}`)} · {size(file.sizeBytes)}
            {file.hardlinkAliases.length > 0 && <div>{t("artifactCatalog.aliases")}: {file.hardlinkAliases.join(", ")}</div>}
            {file.consumerIds.length > 0 && <div>{t("artifactCatalog.consumers")}: {file.consumerIds.join(", ")}</div>}
          </li>)}</ul>
        </details>)}
        <details><summary>{t("artifactCatalog.missing")} ({catalog.missingReferences.length})</summary><ul>{catalog.missingReferences.map((reference, index) => <li key={`${reference.consumerId}:${reference.path}:${index}`} style={{ overflowWrap: "anywhere" }}><code>{reference.path}</code> · {reference.consumerKind}: {reference.consumerId}</li>)}</ul></details>
        {catalog.issues.length > 0 && <ul role="status">{catalog.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      </>}
    </>}
  </details></Panel>;
}
