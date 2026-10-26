import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { Button } from "../../components/ui/Primitives";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import type { ServerState } from "../../types/runtime";

const active = (state: ServerState) => !["stopped", "crashed"].includes(state);

export function RunSelector({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const runs = useControlStore(state => state.runs);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const selectRun = useControlStore(state => state.selectRun);
  const stopAllManagedRuns = useControlStore(state => state.stopAllManagedRuns);
  const activeCount = runs.filter(run => active(run.info.state) && run.info.managed).length;
  return <div className="runSelector">
    <label>
      <span>{t("launches.selected")}</span>
      <ChoiceSelect label={t("launches.selected")} value={selectedRunId ?? ""} disabled={disabled || !runs.length} onChange={selectRun} options={[...(!selectedRunId ? [{ value: '', label: t('launches.draft') }] : []), ...runs.map((run, index) => ({ value: run.info.runId, label: `${t("k.serverNumber", { number: index + 1 })} · ${run.info.name} · ${ENGINE_NAMES[run.info.engine]}` }))]}/>
    </label>
    {!compact && <div className="runSelectorStatus">
      <span role="status">{t("launches.activeCount", { count: activeCount })}</span>
      {activeCount > 1 && <Button className="dangerGhost" onClick={() => void stopAllManagedRuns()}>{t("launches.stopAll")}</Button>}
    </div>}
  </div>;
}
