import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { Button } from "../components/ui/Primitives";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { useStrataRouter } from "../features/live/strataRouter";

/** The shared Strata address: where clients connect and which model is loaded now. */
export function StrataRouterState() {
  const { t } = useTranslation();
  const { status, error } = useStrataRouter();
  if (error) return <FriendlyInlineError error={error}/>;
  if (!status?.listening || !status.endpoint) return null;
  if (!status.models.length) return <p className="engineNote">{t("engine.strataRouterEmpty")}</p>;
  const endpoint = `${status.endpoint}/v1`;
  return <div className="strataRouterState">
    <code title={endpoint}>{endpoint}</code>
    <Button className="kIconBtn" title={t("actions.copy")} aria-label={t("actions.copy")} onClick={() => void navigator.clipboard?.writeText(endpoint)}><Copy size={14}/></Button>
    <span>{status.loaded ? t("engine.strataRouterLoaded", { model: status.loaded, count: status.models.length }) : t("engine.strataRouterIdle", { count: status.models.length })}</span>
  </div>;
}
