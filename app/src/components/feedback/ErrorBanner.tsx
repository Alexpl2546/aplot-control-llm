import { AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { classifyError } from "../../lib/errors";
import { useControlStore } from "../../store/control";

export function ErrorBanner() {
  const { t } = useTranslation();
  const { error, clearError } = useControlStore();
  const [details, setDetails] = useState(false);
  if (!error) return null;
  const friendly = classifyError(error);
  return <div className="errorBanner" role="alert">
    <AlertTriangle size={18}/>
    <div className="errorBannerBody">
      <b>{t(friendly.titleKey)}</b>
      <span>{t(friendly.messageKey)}</span>
      {details && <pre>{friendly.technical}</pre>}
      <button className="linkButton" onClick={() => setDetails(value => !value)}>{details ? <ChevronUp size={13}/> : <ChevronDown size={13}/>} {details ? t("error.hideDetails") : t("error.showDetails")}</button>
    </div>
    <button className="iconButton" aria-label={t("actions.close")} onClick={clearError}><X size={15}/></button>
  </div>;
}
