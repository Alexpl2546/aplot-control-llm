import { useTranslation } from "react-i18next";
import { LogPanel } from "../components/LogPanel";
import { SectionTitle } from "../components/ui/Primitives";
export function LogsView(){const{t}=useTranslation();return <div className="page logsPage"><SectionTitle title={t("nav.logs")} description={t("logs.description")}/><LogPanel/></div>}
