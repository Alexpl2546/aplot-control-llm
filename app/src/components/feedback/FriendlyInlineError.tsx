import { useTranslation } from "react-i18next";
import { classifyError } from "../../lib/errors";

export function FriendlyInlineError({ error }: { error: string }) {
  const { t } = useTranslation();
  const friendly = classifyError(error);
  return <div className="friendlyInlineError" role="alert">
    <strong>{t(friendly.titleKey)}</strong>
    <span>{t(friendly.messageKey)}</span>
    <details><summary>{t("error.showDetails")}</summary><pre>{friendly.technical}</pre></details>
  </div>;
}
