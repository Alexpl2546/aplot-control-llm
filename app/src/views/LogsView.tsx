import { useTranslation } from "react-i18next";
import { LogPanel } from "../components/LogPanel";
import { SectionTitle } from "../components/ui/Primitives";
import { ActivityFeed } from '../features/activity/ActivityFeed';
import { useActivityStore } from '../features/activity/store';
export function LogsView(){const{t}=useTranslation();const mode=useActivityStore(s=>s.mode),setMode=useActivityStore(s=>s.setMode);return <div className="page logsPage deskLogsPage"><SectionTitle title={t("nav.logs")}/><div className="deskTabs" role="group" aria-label={t('nav.logs')}>{(['events','technical'] as const).map(value=><button type="button" aria-pressed={mode===value} key={value} onClick={()=>setMode(value)}>{t(`desk.logs.${value}`)}</button>)}</div>{mode==='technical'?<LogPanel/>:<ActivityFeed/>}</div>}
