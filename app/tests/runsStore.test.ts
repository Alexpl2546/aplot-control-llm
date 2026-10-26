import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BenchmarkSuiteDefinition, type LaunchProfile } from "../src/types/app";
import { MOCK_BENCHMARKS } from "../src/mocks/runtime";
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG } from "../src/types/config";
import type { BenchmarkRequest } from "../src/types/app";
import { BenchmarkJobCancelledError, type BenchmarkJobCallbacks, type JobInfo } from "../src/types/jobs";
import type { LogLine, RunInfo, RuntimeSnapshot } from "../src/types/runtime";
import { MOCK_RUNTIME } from "../src/mocks/runtime";

const bridgeMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  detectLlama: vi.fn(),
  listRuns: vi.fn(),
  createRunStartRequest: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  removeRun: vi.fn(),
  restartRun: vi.fn(),
  stopAllRuns: vi.fn(),
  getRunRuntime: vi.fn(),
  runBenchmarkJob: vi.fn(),
  runBenchmarkSuite: vi.fn(),
  cancelJob: vi.fn(),
  saveProfile: vi.fn(),
  saveSettings: vi.fn(),
  refreshRouterProfiles: vi.fn(),
  validateLlamaModels: vi.fn(),
  markProfileGood: vi.fn(), loadLastKnownGood: vi.fn(),
  markRouterGood: vi.fn(), loadLastKnownGoodRouter: vi.fn(), listProfiles: vi.fn(),
  restoreLastKnownGoodProfile: vi.fn(),
}));
vi.mock("../src/services/tauri", () => bridgeMocks);
vi.mock("../src/services/desktop", () => ({ syncWindowsAutostart: vi.fn() }));

import { useControlStore } from "../src/store/control";
import { executeLaunchIntent, planLaunchAction } from "../src/features/launches/launchActions";

const info = (runId: string, name: string, generation: number, state: RunInfo["state"] = "ready"): RunInfo => ({
  runId, name, engine: "llama_cpp", mode: "single", endpoint: runId === "run-a" ? "http://127.0.0.1:8080" : "http://127.0.0.1:8081",
  modelId: runId, contextTokens: 65536, state, generation, managed: true,
});
const runtime = (run: RunInfo): RuntimeSnapshot => ({
  ...MOCK_RUNTIME, state: run.state, endpoint: run.endpoint, modelName: run.name,
  contextTotal: run.contextTokens, generationTps: run.runId === "run-a" ? 42 : 27,
});
const log = (id: string): LogLine => ({ id, timestamp: "2026-10-11T00:00:00.000Z", level: "INFO", source: "stdout", message: id });
const session = (run: RunInfo, logs: LogLine[] = []) => ({
  info: run, config: { ...DEFAULT_CONFIG, profileId: run.runId, profileName: run.name, host: "127.0.0.1", port: run.runId === "run-a" ? 8080 : 8081 },
  settings: { ...DEFAULT_SETTINGS, serverMode: "single" as const }, runtime: runtime(run), logs, history: [],
});

describe("multi-run control store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    bridgeMocks.isTauri.mockReturnValue(false);
    bridgeMocks.detectLlama.mockResolvedValue({ capabilities: { ...DEFAULT_CAPABILITIES, rawHelp: '--model --ctx-size' }, devices: [] });
    bridgeMocks.stopRun.mockResolvedValue(undefined);
    bridgeMocks.stopAllRuns.mockResolvedValue(undefined);
    bridgeMocks.saveProfile.mockImplementation(async (profile: unknown) => profile);
    bridgeMocks.saveSettings.mockImplementation(async (settings: unknown) => settings);
    bridgeMocks.refreshRouterProfiles.mockResolvedValue(undefined);
    bridgeMocks.createRunStartRequest.mockImplementation(async input => ({
      runId: input.runId, name: input.config.profileName, engine: input.settings.serverEngine, mode: input.settings.serverMode,
      modelId: input.config.modelPath, contextTokens: input.config.ctxSize, launch: { endpoint: "http://127.0.0.1:8082" },
    }));
    bridgeMocks.startRun.mockImplementation(async request => ({
      ...info(request.runId, request.name, 1, "ready"), endpoint: "http://127.0.0.1:8082", pid: 222,
    }));
    bridgeMocks.getRunRuntime.mockImplementation(async (runId: string) => ({
      ...MOCK_RUNTIME, state: "ready", endpoint: "http://127.0.0.1:8082", generationTps: runId.includes("trial") ? 19 : 37,
    }));
    const first = session(info("run-a", "Profile A", 4), [log("a-log")]);
    const second = session(info("run-b", "Profile B", 8), [log("b-log")]);
    useControlStore.setState({
      config: first.config, savedConfig: first.config, settings: first.settings, runtime: first.runtime,
      runningConfig: first.config, runningEngine: "llama_cpp", runningMode: "single",
      runs: [first, second], selectedRunId: "run-a", runDrafts: {}, runBusyById: {},
      logs: first.logs, history: first.history, profiles: [], dirty: false, busy: false, error: undefined,
      optimizerRunning: false, optimizerCancelRequested: false,
      capabilities: DEFAULT_CAPABILITIES,
    });
  });

  it("detects the selected llama binary on first native launch without a prior editor check", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    const capabilities = { ...DEFAULT_CAPABILITIES, rawHelp: '--model --ctx-size', version: 'selected-binary' };
    bridgeMocks.detectLlama.mockResolvedValue({ capabilities, devices: [] });
    const config = { ...DEFAULT_CONFIG, profileId: 'fresh', modelPath: 'C:\\models\\test.gguf' };
    useControlStore.setState({ runs: [], selectedRunId: undefined, config, settings: { ...DEFAULT_SETTINGS, serverEngine: 'llama_cpp', binaryPath: 'C:\\llama\\llama-server.exe' } });
    await useControlStore.getState().startManagedRun();
    expect(bridgeMocks.detectLlama).toHaveBeenCalledExactlyOnceWith('C:\\llama\\llama-server.exe');
    expect(bridgeMocks.createRunStartRequest).toHaveBeenCalledWith(expect.objectContaining({ capabilities, runId: 'profile:fresh' }));
    expect(bridgeMocks.startRun).toHaveBeenCalledOnce();
    expect(useControlStore.getState().error).toBeUndefined();
  });

  it("does not persist or create a server when native binary detection fails", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.detectLlama.mockRejectedValue(new Error('Cannot execute selected binary'));
    const config = { ...DEFAULT_CONFIG, profileId: 'fresh', modelPath: 'C:\\models\\test.gguf' };
    useControlStore.setState({ runs: [], selectedRunId: undefined, config });
    await useControlStore.getState().startManagedRun();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(bridgeMocks.startRun).not.toHaveBeenCalled();
    expect(useControlStore.getState()).toMatchObject({ runs: [], runBusyById: { 'profile:fresh': false }, error: 'Error: Cannot execute selected binary' });
  });

  it("keeps a working server running if the replacement binary cannot be checked", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.detectLlama.mockRejectedValue(new Error('Broken replacement binary'));
    useControlStore.getState().updateConfig('modelPath', 'C:\\models\\replacement.gguf');
    await useControlStore.getState().restartManagedRun('run-a');
    expect(bridgeMocks.stopRun).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().runs[0].info.state).toBe('ready');
  });

  it("launches the target Strata profile even when the last editor settings were llama.cpp", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    const config = { ...DEFAULT_CONFIG, profileId: 'flash', engine: 'strata' as const,
      engineOptions: { strata: { strataRootPath: 'C:\\Strata', strataConfigPath: 'C:\\Strata\\flash.json' } } };
    useControlStore.setState({ config, selectedRunId: undefined, runs: [], settings: { ...DEFAULT_SETTINGS, serverEngine: 'llama_cpp' } });
    await useControlStore.getState().startManagedRun();
    expect(bridgeMocks.detectLlama).not.toHaveBeenCalled();
    expect(bridgeMocks.createRunStartRequest).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ serverEngine: 'strata', strataConfigPath: 'C:\\Strata\\flash.json' }) }));
    expect(bridgeMocks.startRun).toHaveBeenCalledOnce();
  });

  it("keeps repeated profile choices out of the server list until Start is pressed", async () => {
    const strata = (id: string): LaunchProfile => ({ id, name: id, createdAt: 'now', updatedAt: 'now', lastKnownGood: false,
      config: { ...DEFAULT_CONFIG, profileId: id, profileName: id, engine: 'strata', modelAlias: id,
        engineOptions: { strata: { strataRootPath: 'C:\\Strata', strataConfigPath: `C:\\Strata\\strata-${id}.json` } } } });
    const profiles = [strata('flash'), strata('qwen')];
    useControlStore.setState({ profiles, runs: [], selectedRunId: undefined, runDrafts: {},
      runningEngine: undefined, runningConfig: undefined, runtime: { ...MOCK_RUNTIME, state: 'stopped' } });
    await useControlStore.getState().selectProfile('flash');
    await useControlStore.getState().selectProfile('qwen');
    await useControlStore.getState().selectProfile('flash');
    expect(useControlStore.getState()).toMatchObject({ runs: [], selectedRunId: undefined, config: { profileId: 'flash' }, settings: { serverEngine: 'strata', strataConfigPath: 'C:\\Strata\\strata-flash.json' }, runtime: { state: 'stopped', uptimeSeconds: 0 } });
    expect(bridgeMocks.startRun).not.toHaveBeenCalled();
    expect(planLaunchAction(useControlStore.getState(), 'start')).toBeDefined();
    await useControlStore.getState().startManagedRun();
    expect(bridgeMocks.startRun).toHaveBeenCalledOnce();
    expect(bridgeMocks.createRunStartRequest).toHaveBeenCalledWith(expect.objectContaining({ runId: 'profile:flash', settings: expect.objectContaining({ serverEngine: 'strata', strataConfigPath: 'C:\\Strata\\strata-flash.json' }) }));
    expect(useControlStore.getState().runs).toHaveLength(1);
  });

  it("leaves existing servers and their launch snapshots alone when choosing an unlaunched profile", async () => {
    const existing = structuredClone(useControlStore.getState().runs);
    const config = { ...DEFAULT_CONFIG, profileId: 'new-profile', profileName: 'New profile' };
    useControlStore.setState({ profiles: [{ id: config.profileId, name: config.profileName, config, createdAt: 'now', updatedAt: 'now', lastKnownGood: false }] });
    await useControlStore.getState().selectProfile(config.profileId);
    expect(useControlStore.getState().runs).toEqual(existing);
    expect(useControlStore.getState().selectedRunId).toBeUndefined();
    expect(useControlStore.getState().runtime.state).toBe('stopped');
    expect(useControlStore.getState().runningConfig).toBeUndefined();
    expect(bridgeMocks.stopRun).not.toHaveBeenCalled();
    expect(bridgeMocks.startRun).not.toHaveBeenCalled();
  });

  it("blocks a second Start while an unselected draft is being launched", () => {
    useControlStore.setState({ selectedRunId: undefined, runBusyById: { [`profile:${useControlStore.getState().config.profileId}`]: true } });
    expect(planLaunchAction(useControlStore.getState(), 'start')).toBeUndefined();
  });

  it("keeps launch drafts and persistence untouched until the common action is confirmed", async () => {
    const original = useControlStore.getState().runs[0].config;
    useControlStore.getState().updateConfig("ctxSize", 32768);
    const port = { read: useControlStore.getState, start: useControlStore.getState().startManagedRun, restart: useControlStore.getState().restartManagedRun };
    const intent = planLaunchAction(port.read(), "restart")!;
    await executeLaunchIntent(port, intent);
    expect(bridgeMocks.stopRun).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().runs[0].config).toEqual(original);
    await executeLaunchIntent(port, intent, true);
    expect(bridgeMocks.stopRun).toHaveBeenCalledExactlyOnceWith("run-a");
    expect(bridgeMocks.saveProfile).toHaveBeenCalledOnce();
    expect(bridgeMocks.startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-a", contextTokens: 32768 }));
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.info.generation).toBe(8);
  });

  it("preserves each run's unsaved configuration draft when switching selection", () => {
    useControlStore.getState().updateConfig("profileName", "Profile A draft");
    useControlStore.getState().selectRun("run-b");
    expect(useControlStore.getState()).toMatchObject({
      selectedRunId: "run-b", config: { profileName: "Profile B" }, runtime: { endpoint: "http://127.0.0.1:8081" },
      logs: [{ id: "b-log" }], dirty: false,
    });
    useControlStore.getState().updateConfig("profileName", "Profile B draft");
    useControlStore.getState().selectRun("run-a");
    expect(useControlStore.getState()).toMatchObject({
      selectedRunId: "run-a", config: { profileName: "Profile A draft" }, runtime: { endpoint: "http://127.0.0.1:8080" },
      logs: [{ id: "a-log" }], dirty: true,
    });
  });
  it("keeps a managed router's running preset immutable during profile synchronization", async () => {
    const first = session({ ...info("run-a", "Profile A", 4), mode: "router" });
    useControlStore.setState({ runs: [first], selectedRunId: "run-a", runningEngine: "llama_cpp", runningMode: "router", runningRouterSettings: { ...DEFAULT_SETTINGS, serverMode: "router" } });
    await useControlStore.getState().syncRouterProfiles();
    expect(bridgeMocks.refreshRouterProfiles).not.toHaveBeenCalled();
    expect(useControlStore.getState().error).toBeUndefined();
  });
  it("uses the assigned endpoint when restoring router run settings, preserving the saved preference", async () => {
    const config = { ...DEFAULT_CONFIG, profileId: "p", profileName: "P", engine: "llama_cpp" as const, port: 8080, engineOptions: { llama_cpp: { serverMode: "router", routerHost: "127.0.0.1", routerPort: 8080 } } };
    const profile = { id: "p", name: "P", config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    bridgeMocks.listRuns.mockResolvedValue([{ ...info("profile:p", "P", 1), mode: "router", endpoint: "http://127.0.0.1:8082" }]);
    useControlStore.setState({ profiles: [profile], runs: [], selectedRunId: undefined, runDrafts: {} });
    await useControlStore.getState().loadRuns();
    expect(useControlStore.getState().settings.routerPort).toBe(8082);
    expect(useControlStore.getState().runningRouterSettings?.routerPort).toBe(8082);
    expect(profile.config.engineOptions.llama_cpp.routerPort).toBe(8080);
    bridgeMocks.restartRun.mockResolvedValue({ ...info("profile:p", "P", 2), mode: "router", endpoint: "http://127.0.0.1:8082" });
    await useControlStore.getState().restartManagedRun("profile:p");
    expect(bridgeMocks.restartRun).toHaveBeenCalledExactlyOnceWith("profile:p");
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    await useControlStore.getState().stopManagedRun("profile:p");
    await useControlStore.getState().startManagedRun("profile:p");
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(profile.config.engineOptions.llama_cpp.routerPort).toBe(8080);
  });
  it("marks the launched profile revision once when its generation becomes ready", async () => {
    const first = { ...session(info("profile:p", "P", 2, "loading")), profileRevision: 7 };
    first.config.profileId = "p";
    const profile = { id: "p", name: "P", config: first.config, revision: 7, createdAt: "now", updatedAt: "now", lastKnownGood: true };
    bridgeMocks.loadLastKnownGood.mockResolvedValue(profile);
    bridgeMocks.listProfiles.mockResolvedValue([profile]);
    useControlStore.setState({ runs: [first], selectedRunId: "profile:p" });
    await useControlStore.getState().refreshManagedRuns();
    await useControlStore.getState().refreshManagedRuns();
    expect(bridgeMocks.markProfileGood).toHaveBeenCalledExactlyOnceWith("p", 7);
    expect(useControlStore.getState().knownGoodProfile).toEqual(profile);
  });
  it("discards a late metrics failure after stopping a run, but reports active failures", async () => {
    let failPoll!: (reason: Error) => void;
    bridgeMocks.getRunRuntime.mockImplementation((id: string) => id === "run-b"
      ? new Promise<RuntimeSnapshot>((_resolve, reject) => { failPoll = reject; })
      : Promise.resolve(runtime(info("run-a", "Profile A", 4))));
    useControlStore.getState().selectRun("run-b");
    const polling = useControlStore.getState().refreshManagedRuns();
    await useControlStore.getState().stopManagedRun("run-b");
    failPoll(new Error("The run changed while its metrics were being collected"));
    await polling;
    expect(useControlStore.getState().error).toBeUndefined();
    useControlStore.getState().selectRun("run-a");
    bridgeMocks.getRunRuntime.mockRejectedValue(new Error("Connection refused"));
    await useControlStore.getState().refreshManagedRuns();
    expect(useControlStore.getState().error).toContain("Connection refused");
  });
  it("does not mark optimizer trial generations as known-good", async () => {
    const trial = { ...session(info("trial:example", "Trial", 1, "loading")), profileRevision: 7 };
    useControlStore.setState({ runs: [trial], selectedRunId: "trial:example" });
    await useControlStore.getState().refreshManagedRuns();
    expect(bridgeMocks.markProfileGood).not.toHaveBeenCalled();
  });
  it("restores v2 into its target run while keeping another process and draft", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    const first = session(info("profile:p", "P", 2)); first.config.profileId = "p";
    const other = session(info("profile:other", "Other", 3));
    const restored = { id: "p", name: "Restored", config: { ...first.config, profileName: "Restored", modelPath: "model.gguf", ctxSize: 131072 }, revision: 9, createdAt: "now", updatedAt: "now", lastKnownGood: true };
    bridgeMocks.loadLastKnownGood.mockResolvedValue(restored);
    bridgeMocks.restoreLastKnownGoodProfile.mockResolvedValue(restored);
    bridgeMocks.listProfiles.mockResolvedValue([restored]);
    useControlStore.setState({ runs: [first, other], selectedRunId: "profile:p", config: first.config, settings: { ...first.settings, serverMode: "single" }, capabilities: { ...DEFAULT_CAPABILITIES, rawHelp: "--model --ctx-size" }, runDrafts: { "profile:other": { config: { ...other.config, ctxSize: 8192 }, settings: other.settings, dirty: true } } });
    await useControlStore.getState().rollback();
    expect(bridgeMocks.restoreLastKnownGoodProfile).toHaveBeenCalledOnce();
    expect(bridgeMocks.stopRun).toHaveBeenCalledExactlyOnceWith("profile:p");
    expect(bridgeMocks.startRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "profile:p", contextTokens: 131072 }));
    expect(useControlStore.getState().runs.find(run => run.info.runId === "profile:other")).toMatchObject({ config: other.config, info: { generation: 3, state: "ready" } });
    expect(useControlStore.getState().runDrafts["profile:other"].config.ctxSize).toBe(8192);
  });

  it("ignores late prior-generation logs and state events without leaking into the selected run", () => {
    useControlStore.getState().setManagedRunState({ runId: "run-b", generation: 7, state: "crashed" });
    useControlStore.getState().appendRunLog({ runId: "run-b", generation: 7, line: log("late") });
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.info.state).toBe("ready");
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.logs).toEqual([log("b-log")]);
    useControlStore.getState().setManagedRunState({ runId: "run-b", generation: 8, state: "busy" });
    useControlStore.getState().appendRunLog({ runId: "run-b", generation: 8, line: log("current") });
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.info.state).toBe("busy");
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.logs.at(-1)?.id).toBe("current");
    expect(useControlStore.getState()).toMatchObject({ selectedRunId: "run-a", runtime: { state: "ready" }, logs: [{ id: "a-log" }] });
  });

  it("uses a per-run operation lock and leaves the other launch and global busy state untouched", async () => {
    let finishStop!: () => void;
    bridgeMocks.stopRun.mockReturnValue(new Promise<void>(resolve => { finishStop = resolve; }));
    const stopping = useControlStore.getState().stopManagedRun("run-b");
    expect(useControlStore.getState().runBusyById).toMatchObject({ "run-b": true });
    expect(useControlStore.getState().busy).toBe(false);
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-a")?.info.state).toBe("ready");
    expect(useControlStore.getState().runtime.state).toBe("ready");
    finishStop();
    await stopping;
    expect(useControlStore.getState().runBusyById["run-b"]).toBe(false);
    expect(useControlStore.getState().runs.find(run => run.info.runId === "run-b")?.info.state).toBe("stopped");
  });

  it("runs a managed benchmark job for the selected run and records its job progress", async () => {
    useControlStore.setState(state => ({ runs: state.runs.map(run => run.info.runId === "run-b" ? { ...run, info: { ...run.info, state: "stopped" } } : run) }));
    const queued: JobInfo = { jobId: "job-1", runId: "run-a", generation: 4, engine: "llama_cpp", status: "queued", createdAt: "now", updatedAt: "now", evidence: {} };
    const completed: JobInfo = { ...queued, status: "completed", benchmarkId: MOCK_BENCHMARKS[0].id };
    bridgeMocks.runBenchmarkJob.mockImplementation(async (_runId: string, _request: BenchmarkRequest, callbacks: BenchmarkJobCallbacks) => {
      callbacks.onStarted?.(queued);
      callbacks.onProgress?.({ jobId: queued.jobId, runId: queued.runId, generation: queued.generation, progress: { phase: "sample", completed: 1, total: 1, sample: MOCK_BENCHMARKS[0].samples[0] } });
      callbacks.onState?.(completed);
      return MOCK_BENCHMARKS[0];
    });

    await useControlStore.getState().runBenchmark({ profileId: "run-a", promptTokens: 128, generationTokens: 16, runs: 1 });

    expect(bridgeMocks.runBenchmarkJob).toHaveBeenCalledWith("run-a", expect.objectContaining({ profileId: "run-a" }), expect.any(Object));
    expect(useControlStore.getState()).toMatchObject({
      activeBenchmarkJobId: undefined,
      benchmarkJob: { jobId: "job-1", status: "completed", benchmarkId: MOCK_BENCHMARKS[0].id },
      benchmarkProgress: { phase: "completed" },
      benchmarks: [MOCK_BENCHMARKS[0]],
      busy: false,
    });
  });

  it("cancels the active normal benchmark job", async () => {
    const job: JobInfo = { jobId: "job-2", runId: "run-a", generation: 4, engine: "llama_cpp", status: "running", createdAt: "now", updatedAt: "now", evidence: {} };
    bridgeMocks.cancelJob.mockResolvedValue(undefined);
    useControlStore.setState({ benchmarkJob: job, activeBenchmarkJobId: job.jobId });

    await useControlStore.getState().cancelBenchmark();

    expect(bridgeMocks.cancelJob).toHaveBeenCalledWith(job.jobId);
    expect(useControlStore.getState().benchmarkJob?.status).toBe("cancelling");
  });

  it("runs optimizer candidates on a managed trial run using benchmark jobs", async () => {
    const config = { ...DEFAULT_CONFIG, profileId: "profile-tune", profileName: "Tune me", modelPath: "C:/models/model.gguf", ctxSize: 65536, parallel: 1, fit: false };
    const profile: LaunchProfile = { id: config.profileId, name: config.profileName, config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    const suite = (id: string, kind: BenchmarkSuiteDefinition["kind"]): BenchmarkSuiteDefinition => ({ id, version: 1, kind, nameKey: "", descriptionKey: "", defaultPromptTokens: 2048, defaultGenerationTokens: 512, defaultRuns: 1, probeCount: 1, windowCount: 1, minimumAccuracy: 0.95 });
    useControlStore.setState({
      config, savedConfig: config, settings: { ...DEFAULT_SETTINGS, serverMode: "single" },
      runtime: { ...MOCK_RUNTIME, state: "stopped" }, runningConfig: undefined, runningEngine: undefined, runningMode: undefined,
      runs: [], selectedRunId: undefined, profiles: [profile], capabilities: { ...DEFAULT_CAPABILITIES, rawArguments: [], rawHelp: "", kvCacheTypes: [] },
      benchmarkSuites: [suite("context-recall-v1", "exact_recall"), suite("context-stability-v1", "context_continuity")],
      busy: false, optimizerRunning: false, optimizerCancelRequested: false,
    });
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.runBenchmarkJob.mockImplementation(async (runId: string, _request: BenchmarkRequest, callbacks: BenchmarkJobCallbacks) => {
      const job: JobInfo = { jobId: "trial-job", runId, generation: 1, engine: "llama_cpp", status: "queued", createdAt: "now", updatedAt: "now", evidence: {} };
      callbacks.onStarted?.(job);
      callbacks.onState?.({ ...job, status: "completed", benchmarkId: "trial-result" });
      return { ...MOCK_BENCHMARKS[0], id: "trial-result", meetsTargets: false };
    });

    await useControlStore.getState().runAutoTune({ profileId: profile.id, promptTokens: 2048, generationTokens: 512, runs: 1 });

    expect(bridgeMocks.runBenchmarkJob).toHaveBeenCalledWith(expect.stringMatching(/^trial:/), expect.objectContaining({ autoTuneCandidate: true }), expect.any(Object));
    expect(bridgeMocks.runBenchmarkSuite).not.toHaveBeenCalled();
    expect(bridgeMocks.stopRun).toHaveBeenCalledWith(expect.stringMatching(/^trial:/));
    expect(useControlStore.getState().optimizerRunning).toBe(false);
  });

  it("cancels the active optimizer job and cleans up its trial run", async () => {
    const config = { ...DEFAULT_CONFIG, profileId: "profile-tune", profileName: "Tune me", modelPath: "C:/models/model.gguf", ctxSize: 65536, parallel: 1, fit: false };
    const profile: LaunchProfile = { id: config.profileId, name: config.profileName, config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    const suite = (id: string, kind: BenchmarkSuiteDefinition["kind"]): BenchmarkSuiteDefinition => ({ id, version: 1, kind, nameKey: "", descriptionKey: "", defaultPromptTokens: 2048, defaultGenerationTokens: 512, defaultRuns: 1, probeCount: 1, windowCount: 1, minimumAccuracy: 0.95 });
    useControlStore.setState({
      config, savedConfig: config, settings: { ...DEFAULT_SETTINGS, serverMode: "single" },
      runtime: { ...MOCK_RUNTIME, state: "stopped" }, runningConfig: undefined, runningEngine: undefined, runningMode: undefined,
      runs: [], selectedRunId: undefined, profiles: [profile], capabilities: { ...DEFAULT_CAPABILITIES, rawArguments: [], rawHelp: "", kvCacheTypes: [] },
      benchmarkSuites: [suite("context-recall-v1", "exact_recall"), suite("context-stability-v1", "context_continuity")],
      busy: false, optimizerRunning: false, optimizerCancelRequested: false,
    });
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.cancelJob.mockResolvedValue(undefined);
    bridgeMocks.runBenchmarkJob.mockImplementation(async (runId: string, _request: BenchmarkRequest, callbacks: BenchmarkJobCallbacks) => {
      const job: JobInfo = { jobId: "trial-job-cancel", runId, generation: 1, engine: "llama_cpp", status: "queued", createdAt: "now", updatedAt: "now", evidence: {} };
      callbacks.onStarted?.(job);
      useControlStore.getState().cancelAutoTune();
      throw new BenchmarkJobCancelledError();
    });

    await useControlStore.getState().runAutoTune({ profileId: profile.id, promptTokens: 2048, generationTokens: 512, runs: 1 });

    expect(bridgeMocks.cancelJob).toHaveBeenCalledWith("trial-job-cancel");
    expect(bridgeMocks.stopRun).toHaveBeenCalledWith(expect.stringMatching(/^trial:/));
    expect(useControlStore.getState().optimizerProfiles).toEqual([]);
    expect(useControlStore.getState().optimizerRunning).toBe(false);
  });
});

describe('server list lifecycle',()=>{
  beforeEach(()=>{
    vi.resetAllMocks();bridgeMocks.listRuns.mockResolvedValue([]);bridgeMocks.saveSettings.mockImplementation(async settings=>settings);bridgeMocks.removeRun.mockResolvedValue(undefined);
    const profile:LaunchProfile={id:'saved',name:'Saved model',revision:1,config:{...DEFAULT_CONFIG,profileId:'saved',profileName:'Saved model',engine:'strata',engineOptions:{strata:{strataConfigPath:'C:/strata/model.json',strataHost:'127.0.0.1',strataPort:8090}}}} as LaunchProfile;
    useControlStore.setState({runs:[],selectedRunId:undefined,profiles:[profile],settings:{...DEFAULT_SETTINGS,pinnedServerIds:['profile:saved']},runDrafts:{},runBusyById:{},optimizerRunning:false,error:undefined});
  });
  it('restores only pinned profiles as stopped entries without starting or probing a process',async()=>{
    await useControlStore.getState().loadRuns();
    expect(useControlStore.getState().runs).toHaveLength(1);
    expect(useControlStore.getState().runs[0]).toMatchObject({remembered:true,info:{runId:'profile:saved',state:'stopped',generation:0,engine:'strata',mode:'single',endpoint:'http://127.0.0.1:8090'}});
    await useControlStore.getState().refreshManagedRuns();
    expect(bridgeMocks.startRun).not.toHaveBeenCalled();expect(bridgeMocks.getRunRuntime).not.toHaveBeenCalled();
  });
  it('removes and unpins a remembered entry without touching its saved profile',async()=>{
    await useControlStore.getState().loadRuns();
    await useControlStore.getState().removeRun('profile:saved');
    expect(useControlStore.getState()).toMatchObject({runs:[],selectedRunId:undefined,settings:{pinnedServerIds:[]}});
    expect(useControlStore.getState().profiles[0].id).toBe('saved');
    expect(bridgeMocks.removeRun).not.toHaveBeenCalled();
    await useControlStore.getState().loadRuns();expect(useControlStore.getState().runs).toEqual([]);
  });
  it('forgets stopped native entries but rejects removal while active',async()=>{
    const run=info('profile:saved','Saved model',3,'ready');
    useControlStore.setState({runs:[session(run)]});
    await useControlStore.getState().removeRun(run.runId);expect(bridgeMocks.removeRun).not.toHaveBeenCalled();
    useControlStore.setState({runs:[session({...run,state:'stopped'})]});
    await useControlStore.getState().removeRun(run.runId);expect(bridgeMocks.removeRun).toHaveBeenCalledWith(run.runId);
    expect(useControlStore.getState().runs).toEqual([]);
  });
  it('keeps an entry if native removal fails and avoids recreating a duplicate pinned row',async()=>{
    bridgeMocks.listRuns.mockResolvedValue([info('profile:saved','Saved model',3,'stopped')]);
    await useControlStore.getState().loadRuns();expect(useControlStore.getState().runs).toHaveLength(1);
    bridgeMocks.removeRun.mockRejectedValue(new Error('Server is starting'));
    // Runtime polling in this test must not promote the stopped entry.
    useControlStore.setState({runs:useControlStore.getState().runs.map(r=>({...r,info:{...r.info,state:'stopped'}}))});
    await useControlStore.getState().removeRun('profile:saved');
    expect(useControlStore.getState().runs).toHaveLength(1);expect(useControlStore.getState().settings.pinnedServerIds).toEqual(['profile:saved']);
  });
});
