import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { executeLaunchIntent, LaunchChangedError, planLaunchAction, type LaunchAction, type LaunchIntent } from "./launchActions";

const port = {
  read: useControlStore.getState,
  start: (runId?: string) => useControlStore.getState().startManagedRun(runId),
  restart: (runId: string) => useControlStore.getState().restartManagedRun(runId),
};

export function useLaunchAction() {
  const { t } = useTranslation();
  const [pendingLaunch, setPendingLaunch] = useState<LaunchIntent>();
  const [confirming, setConfirming] = useState(false);
  const report = useCallback((error: unknown) => useControlStore.getState().notify("error", error instanceof LaunchChangedError ? t("k.launch.changed") : String(error)), [t]);
  const requestLaunch = useCallback(async (action: LaunchAction, runId?: string) => {
    const intent = planLaunchAction(port.read(), action, runId);
    if (!intent) return;
    if (intent.needsConfirmation) { setPendingLaunch(intent); return; }
    try { await executeLaunchIntent(port, intent); } catch (error) { report(error); }
  }, [report]);
  const confirmLaunch = async () => {
    if (!pendingLaunch || confirming) return;
    setConfirming(true);
    try { await executeLaunchIntent(port, pendingLaunch, true); }
    catch (error) { report(error); }
    finally { setConfirming(false); setPendingLaunch(undefined); }
  };
  return { requestLaunch, pendingLaunch, confirming, confirmLaunch, cancelLaunch: () => setPendingLaunch(undefined) };
}
