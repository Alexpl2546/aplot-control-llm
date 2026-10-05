import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Panel } from "../ui/Primitives";

export function StrataModelCard() {
  const { t } = useTranslation();
  const { settings, runtime } = useControlStore();
  const configName = settings.strataConfigPath.split(/[\\/]/).pop() || t("settings.strataNoModels");
  return <Panel className="strataModelCard">
    <div className="modelGlyph" aria-hidden="true"><Cpu size={28}/></div>
    <div>
      <h3>{t("config.strataTitle")}</h3>
      <p>{runtime.modelName || configName}</p>
      <p className="mono subtle">{configName}</p>
      <p className="subtle">{t("config.strataText")}</p>
    </div>
  </Panel>;
}
