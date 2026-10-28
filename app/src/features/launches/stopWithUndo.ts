import i18n from "../../lib/i18n";
import { useControlStore } from "../../store/control";

/**
 * Stops a server right away and offers "Start again" for a few seconds instead of asking "Are you sure?".
 * Stopping is reversible (the saved session config relaunches it), so a confirmation would only add a click.
 */
export async function stopRunWithUndo(runId: string) {
  const state = useControlStore.getState();
  const run = state.runs.find(item => item.info.runId === runId);
  if (!run) return;
  await state.stopManagedRun(runId);
  const after = useControlStore.getState().runs.find(item => item.info.runId === runId);
  if (after?.info.state !== "stopped") return;
  useControlStore.getState().notifyAction("info", i18n.t("undo.serverStopped", { name: run.info.name }), {
    label: i18n.t("undo.startAgain"),
    run: () => useControlStore.getState().startManagedRun(runId),
  }, 7000);
}
