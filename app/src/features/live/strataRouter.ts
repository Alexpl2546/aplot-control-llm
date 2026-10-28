import { create } from "zustand";
import { useControlStore } from "../../store/control";
import * as bridge from "../../services/tauri";
import { profileRunId } from "../launches/profiles";
import type { AppSettings, LaunchProfile } from "../../types/app";

/** The shared Strata address as the backend last reported it. */
export const useStrataRouter = create<{ status?: bridge.StrataRouterStatus; error?: string }>(() => ({}));

const strataConfigPath = (profile: LaunchProfile) => String(profile.config.engineOptions?.strata?.strataConfigPath ?? "").trim();

/** Strata profiles that can sit behind the shared address, with the model name clients send. */
export function strataRouterModels(profiles: readonly LaunchProfile[]) {
  const used = new Set<string>();
  return profiles.filter(profile => profile.config.engine === "strata" && !profile.unsupportedEngine && strataConfigPath(profile)).map(profile => {
    const base = profile.name.trim() || profile.id;
    let model = base;
    for (let suffix = 2; used.has(model.toLocaleLowerCase("en-US")); suffix++) model = `${base} (${suffix})`;
    used.add(model.toLocaleLowerCase("en-US"));
    return { profile, model };
  });
}

export async function strataRouterConfig(settings: AppSettings, profiles: LaunchProfile[]): Promise<bridge.StrataRouterConfig> {
  const enabled = settings.strataServerMode === "router";
  const members = enabled ? await Promise.all(strataRouterModels(profiles).map(async ({ profile, model }) => {
    const request = await bridge.createRunStartRequest({ runId: profileRunId(profile.id), config: profile.config, settings: { ...settings, serverEngine: "strata" }, profiles, capabilities: {} });
    // Models run on loopback ports after the shared one; only the shared port faces clients.
    return { model, request: { ...request, launch: { ...request.launch, host: "127.0.0.1", port: settings.strataPort + 1 } } };
  })) : [];
  return { enabled, host: settings.strataHost, port: settings.strataPort, apiKey: settings.strataApiKey, members };
}

/** Keeps the backend listener in step with settings and profiles; returns the unsubscribe function. */
export function startStrataRouter() {
  let applied = "";
  let queue = Promise.resolve();
  let watched: { settings?: AppSettings; profiles?: LaunchProfile[] } = {};
  const sync = (settings: AppSettings, profiles: LaunchProfile[]) => {
    queue = queue.then(async () => {
      try {
        const config = await strataRouterConfig(settings, profiles);
        const key = JSON.stringify(config);
        if (key === applied) return;
        applied = key;
        useStrataRouter.setState({ status: await bridge.configureStrataRouter(config), error: undefined });
      } catch (error) {
        useStrataRouter.setState({ status: undefined, error: String(error) });
      }
    });
  };
  const unsubscribe = useControlStore.subscribe(state => {
    if (!state.initialized || (watched.settings === state.settings && watched.profiles === state.profiles)) return;
    watched = { settings: state.settings, profiles: state.profiles };
    sync(state.settings, state.profiles);
  });
  // Runs the shared address starts or stops appear in the server list.
  const unlisten = bridge.subscribeRunsChanged(() => {
    void useControlStore.getState().loadRuns();
    void bridge.strataRouterStatus().then(status => useStrataRouter.setState(current => current.error ? current : { status }), () => undefined);
  });
  return () => { unsubscribe(); void unlisten.then(stop => stop()); };
}
