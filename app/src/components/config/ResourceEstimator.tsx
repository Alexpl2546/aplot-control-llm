import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { estimateResources } from "../../lib/resources";
import { useControlStore } from "../../store/control";
import { Badge } from "../ui/Primitives";

export function ResourceEstimator() {
  const { t } = useTranslation();
  const config = useControlStore(state => state.config);
  const memoryTotalMiB = useControlStore(state => state.runtime.gpu.memoryTotalMiB);
  const estimate = useMemo(() => estimateResources(config, memoryTotalMiB / 1024 || 16), [config, memoryTotalMiB]);
  const deficit = estimate.headroomGiB < 0;
  return <div className="resourceEstimator">
    <div className="resourceHead"><b>{t("config.resources")}</b><Badge tone="orange">{t(estimate.confidence === "low" ? "resources.roughEstimate" : "resources.estimate")}</Badge></div>
    <div className="resourceGrid">
      <R l={t("resources.model")} v={`${estimate.modelGiB.toFixed(1)} GB`} />
      <R l={t("resources.kv")} v={`${estimate.kvCacheGiB.toFixed(1)} GB`} />
      <R l={t("resources.vram")} v={`${estimate.estimatedVramGiB.toFixed(1)} GB`} />
      <R l={t("resources.ram")} v={`${estimate.estimatedRamGiB.toFixed(1)} GB`} />
      <R l={t(deficit ? "resources.deficit" : "resources.headroom")} v={`${Math.abs(estimate.headroomGiB).toFixed(1)} GB`} warn={estimate.headroomGiB < 1} />
    </div>
    <p>{t(estimate.confidence === "low" ? "resources.genericNote" : "resources.metadataNote")}</p>
    {config.fit && <p>{t("resources.fitNote")}</p>}
  </div>;
}
function R({ l, v, warn }: { l: string; v: string; warn?: boolean }) {
  return <div className={warn ? "resource warn" : "resource"}><span>{l}</span><strong>{v}</strong></div>;
}
