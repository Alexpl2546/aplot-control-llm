import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchProfile } from "../src/types/app";
import { DEFAULT_SETTINGS, type BenchmarkRequest } from "../src/types/app";
import { DEFAULT_CAPABILITIES } from "../src/types/config";
import { TEST_CONFIG } from "./fixtures";
import { MOCK_BENCHMARKS, MOCK_RUNTIME } from "../src/mocks/runtime";

const bridgeMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  validateLlamaModels: vi.fn(),
  saveSettings: vi.fn(),
  stopServer: vi.fn(),
  startServer: vi.fn(),
  restartServer: vi.fn(),
  startStrataServer: vi.fn(),
  restartStrataServer: vi.fn(),
  startQwfnServer: vi.fn(),
  startRouter: vi.fn(),
  restartRouter: vi.fn(),
  getRuntime: vi.fn(),
  saveProfile: vi.fn(),
  refreshRouterProfiles: vi.fn(),
  deleteProfile: vi.fn(),
  importProfile: vi.fn(),
  markProfileGood: vi.fn(),
  loadLastKnownGood: vi.fn(),
  markRouterGood: vi.fn(),
  runBenchmark: vi.fn(),
  runBenchmarkSuite: vi.fn(),
  scanModels: vi.fn(),
  discoverStrataModels: vi.fn(),
}));

const ollamaMocks = vi.hoisted(() => ({ startOllama: vi.fn(), ollamaAction: vi.fn(), ollamaRuntime: vi.fn(), benchmarkOllama: vi.fn(), ollamaLibrary: vi.fn(), ollamaCachedLibrary: vi.fn() }));
vi.mock("../src/services/ollama", () => ollamaMocks);
vi.mock("../src/services/tauri", () => bridgeMocks);
vi.mock("../src/services/desktop", () => ({ syncWindowsAutostart: vi.fn() }));

import { useControlStore } from "../src/store/control";

const stableConfig = {
  ...TEST_CONFIG,
  profileId: "stable-profile",
  profileName: "Stable profile",
};

const stableProfile: LaunchProfile = {
  id: stableConfig.profileId,
  name: stableConfig.profileName,
  config: structuredClone(stableConfig),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastKnownGood: true,
};

describe("control store last-known-good recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    bridgeMocks.isTauri.mockReturnValue(false);
    vi.stubGlobal("crypto", { randomUUID: () => "test-notice-id" });
    bridgeMocks.validateLlamaModels.mockResolvedValue(undefined);
    bridgeMocks.saveSettings.mockImplementation(async settings => settings);
    ollamaMocks.startOllama.mockResolvedValue(undefined);
    ollamaMocks.ollamaLibrary.mockResolvedValue([{name:"fixture:latest",size:1,capabilities:["completion"]}]);
    bridgeMocks.refreshRouterProfiles.mockResolvedValue(undefined);
    ollamaMocks.ollamaAction.mockResolvedValue({});
    ollamaMocks.ollamaRuntime.mockResolvedValue({ ...MOCK_RUNTIME, state: "ready", backend: "Ollama" });
    ollamaMocks.benchmarkOllama.mockResolvedValue(MOCK_BENCHMARKS[0]);
    bridgeMocks.stopServer.mockResolvedValue(undefined);
    bridgeMocks.startServer.mockResolvedValue({ pid: 111 });
    bridgeMocks.restartServer.mockRejectedValueOnce(new Error("invalid runtime setting"));
    bridgeMocks.restartServer.mockResolvedValueOnce({ pid: 222 });
    bridgeMocks.startStrataServer.mockResolvedValue({ pid: 777 });
    bridgeMocks.restartStrataServer.mockResolvedValue({ pid: 778 });
    bridgeMocks.startQwfnServer.mockResolvedValue({ pid: 779 });
    bridgeMocks.startRouter.mockResolvedValue({ pid: 333, unsupportedParameters: [] });
    bridgeMocks.restartRouter.mockResolvedValue({ pid: 444, unsupportedParameters: [] });
    bridgeMocks.getRuntime
      .mockResolvedValueOnce({ ...MOCK_RUNTIME, state: "ready", pid: 111 })
      .mockResolvedValueOnce({ ...MOCK_RUNTIME, state: "ready", pid: 222 });
    bridgeMocks.saveProfile.mockImplementation(async (profile: LaunchProfile) => structuredClone(profile));
    bridgeMocks.markProfileGood.mockResolvedValue(undefined);
    bridgeMocks.markRouterGood.mockResolvedValue(undefined);
    bridgeMocks.runBenchmark.mockResolvedValue(MOCK_BENCHMARKS[0]);
    bridgeMocks.loadLastKnownGood.mockResolvedValue(structuredClone(stableProfile));

    useControlStore.setState({
      config: structuredClone(stableConfig),
      savedConfig: structuredClone(stableConfig),
      capabilities: { ...DEFAULT_CAPABILITIES, rawHelp: "--model", rawArguments: ["--model"] },
      runtime: { ...MOCK_RUNTIME, state: "stopped", pid: undefined },
      runningConfig: undefined,
      runningEngine: undefined, runningMode: undefined, runningRouterSettings: undefined, runningOllamaSettings: undefined, libraryModels: [], ollamaModels: [], models: [], optimizerProfiles: [], optimizerRecommendation: undefined, optimizerRunning: false, optimizerCancelRequested: false,
      launchPid: undefined,
      launchAttempt: 0,
      readyAttempt: 0,
      profiles: [structuredClone(stableProfile)],
      knownGoodProfile: undefined,
      settings: { ...DEFAULT_SETTINGS, serverMode: "single" },
      notices: [],
      dirty: false,
      busy: false,
      error: undefined,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["llama_cpp", "strata", "qwfnfer", "ollama"] as const)("keeps %s stopped when telemetry from before shutdown arrives late", async engine => {
    let finishPoll!: (runtime: typeof MOCK_RUNTIME) => void;
    let finishStop!: () => void;
    bridgeMocks.isTauri.mockReturnValue(true);
    const polling = new Promise<typeof MOCK_RUNTIME>(resolve => { finishPoll = resolve; });
    const stopping = new Promise<void>(resolve => { finishStop = resolve; });
    bridgeMocks.getRuntime.mockReset().mockReturnValue(polling);
    ollamaMocks.ollamaRuntime.mockReturnValue(polling);
    bridgeMocks.stopServer.mockReturnValue(stopping);
    ollamaMocks.ollamaAction.mockReturnValue(stopping);
    useControlStore.setState({ runningEngine: engine, runningConfig: stableConfig, launchPid: 111, launchAttempt: 1, history: [],
      runtime: { ...MOCK_RUNTIME, state: "ready", pid: 111, activeRequests: 2, contextUsed: 500 } });
    const poll = useControlStore.getState().refreshRuntime();
    const stop = useControlStore.getState().stop();
    expect(useControlStore.getState().runtime.state).toBe("stopping");
    expect(useControlStore.getState().busy).toBe(true);
    useControlStore.getState().setServerState("ready");
    useControlStore.getState().setServerState("stopped");
    expect(useControlStore.getState().runtime.state).toBe("stopping");
    await useControlStore.getState().refreshRuntime();
    await useControlStore.getState().stop();
    expect(engine === "ollama" ? ollamaMocks.ollamaAction : bridgeMocks.stopServer).toHaveBeenCalledTimes(1);
    finishStop();
    await stop;
    finishPoll({ ...MOCK_RUNTIME, state: "ready", pid: 111 });
    await poll;
    const result = useControlStore.getState();
    expect(result.runtime).toMatchObject({ state: "stopped", pid: undefined, generationTps: 0, promptTps: 0,
      activeRequests: 0, contextUsed: 0, contextTotal: 0, slots: [], metricsAvailable: false });
    expect(result.busy).toBe(false);
    expect(result.runningEngine).toBeUndefined();
    expect(result.runningConfig).toBeUndefined();
    expect(result.history).toEqual([]);
    expect(bridgeMocks.markProfileGood).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
  });

  it("keeps the stop button pending while an old poll completes and recovers after a shutdown error", async () => {
    let finishPoll!: (runtime: typeof MOCK_RUNTIME) => void;
    let rejectStop!: (error: Error) => void;
    bridgeMocks.getRuntime.mockReset().mockReturnValue(new Promise(resolve => { finishPoll = resolve; }));
    bridgeMocks.stopServer.mockReturnValue(new Promise((_, reject) => { rejectStop = reject; }));
    useControlStore.setState({ runningEngine: "strata", runningConfig: stableConfig, runtime: { ...MOCK_RUNTIME, state: "ready" } });
    const poll = useControlStore.getState().refreshRuntime();
    const stop = useControlStore.getState().stop();
    finishPoll({ ...MOCK_RUNTIME, state: "ready" });
    await poll;
    expect(useControlStore.getState().runtime.state).toBe("stopping");
    expect(useControlStore.getState().busy).toBe(true);
    rejectStop(new Error("shutdown failed"));
    await stop;
    expect(useControlStore.getState().runtime.state).toBe("ready");
    expect(useControlStore.getState().runningConfig).toEqual(stableConfig);
    expect(useControlStore.getState().busy).toBe(false);
    expect(useControlStore.getState().error).toBe("Error: shutdown failed");
    bridgeMocks.getRuntime.mockResolvedValue({ ...MOCK_RUNTIME, state: "ready" });
    await useControlStore.getState().refreshRuntime();
    expect(bridgeMocks.getRuntime).toHaveBeenCalledTimes(2);
  });

  it("drops errors from a telemetry request invalidated by stop", async () => {
    let rejectPoll!: (error: Error) => void;
    bridgeMocks.getRuntime.mockReset().mockReturnValue(new Promise((_, reject) => { rejectPoll = reject; }));
    const poll = useControlStore.getState().refreshRuntime();
    await useControlStore.getState().stop();
    rejectPoll(new Error("endpoint closed"));
    await poll;
    expect(useControlStore.getState().error).toBeUndefined();
    expect(useControlStore.getState().runtime.state).toBe("stopped");
  });

  it("restores the immutable ready snapshot after a failed restart", async () => {
    const store = useControlStore.getState();

    await store.start();
    await useControlStore.getState().refreshRuntime();

    expect(bridgeMocks.markProfileGood).toHaveBeenCalledWith(stableConfig.profileId);
    expect(useControlStore.getState().knownGoodProfile?.config.ctxSize).toBe(stableConfig.ctxSize);

    useControlStore.setState({ config: { ...stableConfig, ctxSize: 32768 }, dirty: true });
    await useControlStore.getState().restart();

    expect(useControlStore.getState().runtime.state).toBe("crashed");
    expect(useControlStore.getState().knownGoodProfile?.config.ctxSize).toBe(stableConfig.ctxSize);

    await useControlStore.getState().rollback();
    await useControlStore.getState().refreshRuntime();

    expect(bridgeMocks.restartServer).toHaveBeenNthCalledWith(2, stableConfig, expect.anything());
    expect(useControlStore.getState().config.ctxSize).toBe(stableConfig.ctxSize);
    expect(useControlStore.getState().runningConfig?.ctxSize).toBe(stableConfig.ctxSize);
    expect(useControlStore.getState().runtime.state).toBe("ready");
    expect(useControlStore.getState().knownGoodProfile?.config.ctxSize).toBe(stableConfig.ctxSize);
  });

  it("reports launch success only at READY and preserves a crashed state", async () => {
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({
      ...MOCK_RUNTIME,
      state: "crashed",
      pid: undefined,
      lastError: "llama-server exited with code 1",
    });

    await useControlStore.getState().start();
    expect(useControlStore.getState().notices).toEqual([]);

    await useControlStore.getState().refreshRuntime();
    expect(useControlStore.getState().runtime.state).toBe("crashed");
    expect(useControlStore.getState().error).toContain("exited with code 1");
    expect(useControlStore.getState().notices.filter(notice => notice.kind === "error")).toHaveLength(1);

    await useControlStore.getState().refreshRuntime();
    expect(useControlStore.getState().runtime.state).toBe("crashed");
    expect(useControlStore.getState().notices.filter(notice => notice.kind === "error")).toHaveLength(1);
  });

  it("starts one router with every saved profile and snapshots the full route list at READY", async () => {
    const secondConfig = { ...stableConfig, profileId: "second-profile", profileName: "second-model", modelPath: "C:\\Models\\second.gguf" };
    const secondProfile: LaunchProfile = { ...stableProfile, id: secondConfig.profileId, name: secondConfig.profileName, config: secondConfig };
    const routerHelp = "--model --models-preset --models-max --models-autoload --no-models-autoload --host --port --metrics --no-webui";
    useControlStore.setState({
      settings: { ...DEFAULT_SETTINGS, serverMode: "router", routerMaxLoadedModels: 1, routerAutoload: true },
      profiles: [structuredClone(stableProfile), secondProfile],
      capabilities: { ...DEFAULT_CAPABILITIES, modelsRouter: true, rawHelp: routerHelp, rawArguments: routerHelp.split(/\s+/) },
      runtime: { ...MOCK_RUNTIME, state: "stopped", pid: undefined },
    });
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({ ...MOCK_RUNTIME, state: "ready", pid: 333 });

    await useControlStore.getState().start();
    expect(bridgeMocks.startRouter).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 8080 }),
      expect.objectContaining({ routerMaxLoadedModels: 1, routerAutoload: true }),
      expect.arrayContaining([expect.objectContaining({ name: stableProfile.name }), expect.objectContaining({ name: secondProfile.name })]),
      expect.objectContaining({ modelsRouter: true }),
    );
    expect(useControlStore.getState().runningMode).toBe("router");

    await useControlStore.getState().refreshRuntime();
    expect(bridgeMocks.markRouterGood).toHaveBeenCalledWith(expect.objectContaining({
      profiles: expect.arrayContaining([expect.objectContaining({ name: secondProfile.name })]),
      settings: expect.objectContaining({ routerMaxLoadedModels: 1 }),
    }));
  });

  it("sends the selected profile name as the router benchmark model", async () => {
    const secondConfig = { ...stableConfig, profileId: "second-profile", profileName: "second-model", modelPath: "C:\\Models\\second.gguf" };
    const secondProfile: LaunchProfile = { ...stableProfile, id: secondConfig.profileId, name: secondConfig.profileName, config: secondConfig };
    useControlStore.setState({
      settings: { ...DEFAULT_SETTINGS, serverMode: "router", routerHost: "192.168.1.117", routerPort: 8080, routerApiKey: "shared" },
      profiles: [structuredClone(stableProfile), secondProfile],
      runningConfig: { ...stableConfig, host: "192.168.1.117", port: 8080, apiKey: "shared" },
      runningMode: "router",
      runtime: { ...MOCK_RUNTIME, state: "ready", pid: 555 },
    });
    const request: BenchmarkRequest = { profileId: secondProfile.id, promptTokens: 100, generationTokens: 20, runs: 1 };

    await useControlStore.getState().runBenchmark(request);

    expect(bridgeMocks.runBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: secondProfile.id, model: secondProfile.name }),
      expect.objectContaining({ host: "192.168.1.117", port: 8080, apiKey: "shared" }),
      secondProfile.name,
    );
  });

  it("starts Strata without llama.cpp capability detection and records READY without a llama profile snapshot", async () => {
    const strataSettings = {
      ...DEFAULT_SETTINGS,
      serverEngine: "strata" as const,
      strataRootPath: "C:\\Strata",
      strataConfigPath: "C:\\Strata\\strata-qwen-iq2_xs.json",
      strataPort: 8095,
    };
    useControlStore.setState({ settings: strataSettings, capabilities: DEFAULT_CAPABILITIES, strataModels: [{ configPath: strataSettings.strataConfigPath, modelName: "Qwen IQ2_XS · 200,074 context", contextLength: 200074 }] });
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({
      ...MOCK_RUNTIME,
      state: "ready",
      pid: 777,
      backend: "Strata (local)",
      modelName: "qwen3.8-flash-next-iq2_xs",
    });

    await useControlStore.getState().start();

    expect(bridgeMocks.startStrataServer).toHaveBeenCalledWith(strataSettings);
    expect(bridgeMocks.startServer).not.toHaveBeenCalled();
    expect(useControlStore.getState().runningEngine).toBe("strata");
    expect(useControlStore.getState().runningConfig?.ctxSize).toBe(200074);
    await useControlStore.getState().refreshRuntime();
    expect(useControlStore.getState().runtime.modelName).toBe("qwen3.8-flash-next-iq2_xs");
    expect(useControlStore.getState().notices.some(notice => notice.kind === "success")).toBe(true);
    expect(bridgeMocks.markProfileGood).not.toHaveBeenCalled();
  });

  it("benchmarks Strata using the running engine model and API key", async () => {
    useControlStore.setState({
      settings: { ...DEFAULT_SETTINGS, serverEngine: "strata", strataApiKey: "strata-secret" },
      runningEngine: "strata",
      runningMode: "single",
      runningConfig: { ...stableConfig, host: "127.0.0.1", port: 8095, apiKey: "strata-secret" },
      runtime: { ...MOCK_RUNTIME, state: "ready", modelName: "qwen3.8-flash-next-iq2_xs" },
    });

    await useControlStore.getState().runBenchmark({ promptTokens: 100, generationTokens: 20, runs: 1 });

    expect(bridgeMocks.runBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "strata", model: "qwen3.8-flash-next-iq2_xs" }),
      expect.objectContaining({ host: "127.0.0.1", port: 8095, apiKey: "strata-secret" }),
      "qwen3.8-flash-next-iq2_xs",
    );
  });

  it("screens one candidate and verifies both configured context stability runs before recommending it", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.restartServer.mockReset().mockResolvedValue({ pid: 222 });
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({ ...MOCK_RUNTIME, state: "ready", pid: 222 });

    const recallSuite = {
      id: "context-recall-v1",
      version: 2,
      kind: "exact_recall" as const,
      nameKey: "benchmark.suite.recall.name",
      descriptionKey: "benchmark.suite.recall.description",
      defaultPromptTokens: 16384,
      defaultGenerationTokens: 384,
      defaultRuns: 3,
      probeCount: 20,
      windowCount: 1,
      minimumAccuracy: 0.95,
    };
    const stabilitySuite = {
      id: "context-stability-v1",
      version: 2,
      kind: "context_continuity" as const,
      nameKey: "benchmark.suite.continuity.name",
      descriptionKey: "benchmark.suite.continuity.description",
      defaultPromptTokens: 65536,
      defaultGenerationTokens: 512,
      defaultRuns: 2,
      probeCount: 20,
      windowCount: 3,
      minimumAccuracy: 0.95,
    };
    const passingResult = {
      ...MOCK_BENCHMARKS[0],
      autoTuneCandidate: true,
      meetsTargets: true,
      recommendationScore: 0.9,
      configSnapshot: stableConfig,
      suiteSummary: {
        completedWindows: 6,
        requestedWindows: 6,
        currentAccuracy: 1,
        carryoverAccuracy: 1,
        checkpointAccuracy: 1,
        passed: true,
        randomSeed: 42,
      },
    };
    bridgeMocks.runBenchmarkSuite
      .mockResolvedValueOnce({ ...passingResult, suiteId: recallSuite.id, suiteVersion: recallSuite.version })
      .mockResolvedValueOnce({ ...passingResult, suiteId: stabilitySuite.id, suiteVersion: stabilitySuite.version });
    useControlStore.setState({
      settings: { ...DEFAULT_SETTINGS, binaryPath: stableConfig.binaryPath, serverMode: "single" },
      capabilities: { ...DEFAULT_CAPABILITIES, rawHelp: "--model --jinja", rawArguments: ["--model", "--jinja"] },
      benchmarkSuites: [recallSuite, stabilitySuite],
      profiles: [structuredClone(stableProfile)],
      runningConfig: structuredClone(stableConfig),
      runningMode: "single",
      runningEngine: "llama_cpp",
      runtime: { ...MOCK_RUNTIME, state: "ready", pid: 111 },
    });

    await useControlStore.getState().runAutoTune({
      profileId: stableProfile.id,
      promptTokens: 4096,
      generationTokens: 128,
      runs: 1,
      minimumQuality: 0.95,
    });

    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ suiteId: recallSuite.id, runs: 1, autoTuneCandidate: true }),
      expect.anything(),
      expect.any(String),
    );
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ suiteId: stabilitySuite.id, runs: 2, windowCount: 3, autoTuneCandidate: true }),
      expect.anything(),
      expect.any(String),
    );
    expect(useControlStore.getState().optimizerRecommendation?.suiteId).toBe(stabilitySuite.id);
    expect(bridgeMocks.restartServer).toHaveBeenCalledTimes(3);
    expect(bridgeMocks.restartServer).toHaveBeenNthCalledWith(1, expect.objectContaining({jinja:true}), expect.anything());
    expect(bridgeMocks.restartServer).toHaveBeenLastCalledWith(stableConfig, expect.anything());
    expect(useControlStore.getState().runtime.state).toBe("ready");
  });
  it("blocks a saved Ollama profile on llama.cpp before any profile write or process start", async () => {
    useControlStore.setState({config:{...stableConfig,engine:"ollama",engineModel:"fixture:latest"}});
    await useControlStore.getState().start();
    expect(bridgeMocks.startServer).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().error).toContain("llama.cpp");
  });
  it("blocks an unregistered Ollama model after refreshing the live registry", async () => {
    useControlStore.setState({settings:{...DEFAULT_SETTINGS,serverEngine:"ollama",ollamaModel:"missing:latest"}});
    await useControlStore.getState().start();
    expect(ollamaMocks.startOllama).toHaveBeenCalled();
    expect(ollamaMocks.ollamaAction).not.toHaveBeenCalled();
  });
  it("unloads the running Ollama model using its immutable endpoint and context snapshot", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    useControlStore.setState({settings:{...DEFAULT_SETTINGS,serverEngine:"ollama",ollamaModel:"fixture:latest",ollamaContext:4096},ollamaModels:[{name:"fixture:latest",size:123,capabilities:["completion"]}]});
    await useControlStore.getState().start();
    await useControlStore.getState().updateSettings({ollamaEndpoint:"http://localhost:9999",ollamaModel:"other:latest",ollamaContext:8192,serverEngine:"llama_cpp"});
    await useControlStore.getState().stop();
    expect(ollamaMocks.ollamaAction).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.ollamaEndpoint,"fixture:latest","unload",4096);
    expect(bridgeMocks.stopServer).not.toHaveBeenCalled();
    expect(useControlStore.getState().runningEngine).toBeUndefined();
  });
  it("keeps Ollama profiles out of a llama.cpp router route list", async () => {
    const help="--model --models-preset --models-max --models-autoload --no-models-autoload --host --port --metrics --no-webui";
    const ollamaProfile:LaunchProfile={...stableProfile,id:"ollama-profile",config:{...stableConfig,profileId:"ollama-profile",engine:"ollama",engineModel:"fixture:latest"}};
    useControlStore.setState({settings:{...DEFAULT_SETTINGS,serverMode:"router"},profiles:[stableProfile,ollamaProfile],capabilities:{...DEFAULT_CAPABILITIES,modelsRouter:true,rawHelp:help,rawArguments:help.split(/\s+/)}});
    await useControlStore.getState().start();
    expect(bridgeMocks.startRouter.mock.calls[0][2]).toHaveLength(1);
    expect(useControlStore.getState().profiles).toContainEqual(ollamaProfile);
  });

  it("launches QwFNfer and keeps its endpoint while another engine is selected", async () => {
    const qwfn = { ...DEFAULT_SETTINGS.qwfn, binaryPath: "C:/engine/qwfn-server.exe", modelPath: "C:/models/flash.gguf", port: 8092, context: 32768 };
    useControlStore.setState({ settings: { ...DEFAULT_SETTINGS, serverEngine: "qwfnfer", qwfn } });
    await useControlStore.getState().start();
    expect(bridgeMocks.startQwfnServer).toHaveBeenCalledWith(expect.objectContaining({ qwfn }), false);
    expect(bridgeMocks.startServer).not.toHaveBeenCalled();
    expect(useControlStore.getState().runningEngine).toBe("qwfnfer");
    useControlStore.setState({ settings: { ...DEFAULT_SETTINGS, serverEngine: "llama_cpp" } });
    await useControlStore.getState().refreshRuntime();
    expect(bridgeMocks.getRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ port: 8092, ctxSize: 32768 }), false, "qwfnfer");
  });

  it("restarts QwFNfer through its own adapter and exposes launch failures", async () => {
    useControlStore.setState({ settings: { ...DEFAULT_SETTINGS, serverEngine: "qwfnfer", qwfn: { ...DEFAULT_SETTINGS.qwfn, binaryPath: "qwfn-server.exe", modelPath: "flash.gguf" } } });
    bridgeMocks.startQwfnServer.mockRejectedValueOnce(new Error("Unsupported draft head"));
    await useControlStore.getState().restart();
    expect(bridgeMocks.startQwfnServer).toHaveBeenCalledWith(expect.anything(), true);
    expect(useControlStore.getState().runtime.state).toBe("crashed");
    expect(useControlStore.getState().error).toContain("Unsupported draft head");
    expect(useControlStore.getState().runningEngine).toBeUndefined();
  });
  it("refreshes a running router after every profile mutation using its active endpoint", async () => {
    useControlStore.setState({ runningEngine: "llama_cpp", runningMode: "router", runningRouterSettings: { ...DEFAULT_SETTINGS, routerPort: 18081 }, settings: { ...DEFAULT_SETTINGS, routerPort: 9999 } });
    await useControlStore.getState().saveCurrentProfile();
    await useControlStore.getState().duplicateProfile("New route");
    bridgeMocks.importProfile.mockResolvedValue({ ...stableProfile, id: "imported" });
    await useControlStore.getState().importProfile("profile.json");
    await useControlStore.getState().deleteProfile("imported");
    expect(bridgeMocks.refreshRouterProfiles).toHaveBeenCalledTimes(4);
    for (const call of bridgeMocks.refreshRouterProfiles.mock.calls) expect(call[0].routerPort).toBe(18081);
    expect(bridgeMocks.restartRouter).not.toHaveBeenCalled();
  });
  it("opens the model library with stopped Ollama without a global library error", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.scanModels.mockResolvedValue([]);
    bridgeMocks.discoverStrataModels.mockResolvedValue([]);
    ollamaMocks.ollamaLibrary.mockRejectedValue(new Error("connection refused"));
    ollamaMocks.ollamaCachedLibrary.mockResolvedValue([]);
    await useControlStore.getState().rescanModels();
    expect(useControlStore.getState().libraryErrors).toEqual([]);
    expect(useControlStore.getState().ollamaConnectionError).toContain("connection refused");
  });

  it("stops tuning on an unavailable exact token API and restores the running configuration", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.restartServer.mockReset().mockResolvedValue({pid:111});
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({...MOCK_RUNTIME,state:"ready",pid:111});
    bridgeMocks.runBenchmarkSuite.mockRejectedValue(new Error("exact context tests require POST /v1/chat/completions/input_tokens; server returned 404"));
    const suite={version:1,kind:"context_recall" as const,nameKey:"",descriptionKey:"",defaultPromptTokens:2048,defaultGenerationTokens:1024,defaultRuns:1,probeCount:20,windowCount:1};
    useControlStore.setState({runningConfig:stableConfig,runningMode:"single",runningEngine:"llama_cpp",runtime:{...MOCK_RUNTIME,state:"ready",pid:111},benchmarkSuites:[{...suite,id:"context-recall-v1"},{...suite,id:"context-stability-v1"}],capabilities:{...DEFAULT_CAPABILITIES,rawArguments:["--model","--batch-size","--ubatch-size"],rawHelp:"--model --batch-size --ubatch-size"}});
    await useControlStore.getState().runAutoTune({profileId:stableProfile.id,promptTokens:2048,generationTokens:1024,runs:1});
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.restartServer).toHaveBeenLastCalledWith(stableConfig,expect.anything());
    expect(useControlStore.getState().optimizerRunning).toBe(false);
    expect(useControlStore.getState().runtime.state).toBe("ready");
    expect(useControlStore.getState().error).toContain("404");
  });
  it("honors cancellation after the current test and restores the original launch", async () => {
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.restartServer.mockReset().mockResolvedValue({pid:111});
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({...MOCK_RUNTIME,state:"ready",pid:111});
    bridgeMocks.runBenchmarkSuite.mockImplementation(async()=>{useControlStore.getState().cancelAutoTune();return {...MOCK_BENCHMARKS[0],meetsTargets:true};});
    const suite={version:1,kind:"context_recall" as const,nameKey:"",descriptionKey:"",defaultPromptTokens:2048,defaultGenerationTokens:1024,defaultRuns:1,probeCount:20,windowCount:1};
    useControlStore.setState({runningConfig:stableConfig,runningMode:"single",runningEngine:"llama_cpp",runtime:{...MOCK_RUNTIME,state:"ready",pid:111},benchmarkSuites:[{...suite,id:"context-recall-v1"},{...suite,id:"context-stability-v1"}]});
    await useControlStore.getState().runAutoTune({profileId:stableProfile.id,promptTokens:2048,generationTokens:1024,runs:1});
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.restartServer).toHaveBeenLastCalledWith(stableConfig,expect.anything());
    expect(useControlStore.getState().optimizerRunning).toBe(false);
    expect(useControlStore.getState().optimizerRecommendation).toBeUndefined();
    expect(useControlStore.getState().runtime.state).toBe("ready");
  });

  function prepareProfileSearch(router = false) {
    let uuid = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `selection-${++uuid}` });
    bridgeMocks.isTauri.mockReturnValue(true);
    bridgeMocks.restartServer.mockReset().mockResolvedValue({ pid: 222 });
    bridgeMocks.getRuntime.mockReset().mockResolvedValue({ ...MOCK_RUNTIME, state: "ready", pid: 222 });
    const suite = { version: 2, kind: "exact_recall" as const, nameKey: "", descriptionKey: "", defaultPromptTokens: 65536, defaultGenerationTokens: 512, defaultRuns: 2, probeCount: 20, windowCount: 3, minimumAccuracy: 0.95 };
    const original = router ? { ...stableConfig, host: "127.0.0.1", port: 18081, apiKey: "original-key", webUi: false } : stableConfig;
    useControlStore.setState({
      runningConfig: original, runningEngine: "llama_cpp", runningMode: router ? "router" : "single",
      runningRouterSettings: router ? { ...DEFAULT_SETTINGS, serverMode: "router", routerPort: 18081, routerApiKey: "original-key" } : undefined,
      capabilities: { ...DEFAULT_CAPABILITIES, fit: true, rawHelp: "--model --ctx-size --parallel --fit", rawArguments: ["--model", "--ctx-size", "--parallel", "--fit"] },
      benchmarkSuites: [{ ...suite, id: "context-recall-v1" }, { ...suite, id: "context-stability-v1", kind: "context_continuity" }],
      runtime: { ...MOCK_RUNTIME, state: "ready", pid: 111 }, knownGoodProfile: stableProfile,
      launchPid: 111, launchAttempt: 1, readyAttempt: 1,
    });
    bridgeMocks.runBenchmarkSuite.mockImplementation(async (request: BenchmarkRequest) => ({
      ...MOCK_BENCHMARKS[0], id: `${request.suiteId}-${request.configSnapshot!.ctxSize}`, request,
      configSnapshot: request.configSnapshot, suiteId: request.suiteId, meetsTargets: true,
      averages: { ...MOCK_BENCHMARKS[0].averages, generationTps: request.configSnapshot!.ctxSize === 65536 ? 100 : request.configSnapshot!.ctxSize === 131072 ? 80 : 30 },
      suiteSummary: request.suiteId === "throughput-v1" ? undefined : {
        completedWindows: request.runs * request.windowCount!, requestedWindows: request.runs * request.windowCount!,
        currentAccuracy: 1, carryoverAccuracy: 1, checkpointAccuracy: 1, passed: true, randomSeed: 42,
      },
    }));
    return { original, request: { profileId: stableProfile.id, promptTokens: 2048, generationTokens: 512, runs: 2, autoSelectProfiles: true, minimumContextTokens: 65536, maximumContextTokens: 262144 } satisfies BenchmarkRequest };
  }

  it("selects and saves three measured goals after restoration, preserving drafts and last-known-good", async () => {
    const { original, request } = prepareProfileSearch();
    const dirtyConfig = { ...stableConfig, temperature: 0.42 };
    useControlStore.setState({ config: dirtyConfig, dirty: true });
    bridgeMocks.saveProfile.mockImplementation(async profile => {
      expect(useControlStore.getState().runningConfig).toEqual(original);
      expect(useControlStore.getState().runtime.state).toBe("ready");
      return profile;
    });
    await useControlStore.getState().runBenchmark(request);
    const state = useControlStore.getState();
    expect(state.optimizerProfiles.map(selection => [selection.goal, selection.profile.config.ctxSize])).toEqual([
      ["maxContext", 262144], ["maxSpeed", 65536], ["balanced", 131072],
    ]);
    expect(new Set(state.optimizerProfiles.map(selection => selection.profile.id)).size).toBe(3);
    expect(state.optimizerProfiles.every(selection => selection.result.suiteId === "throughput-v1" && selection.verification.suiteSummary?.completedWindows === 6)).toBe(true);
    const calls = bridgeMocks.runBenchmarkSuite.mock.calls.map(call => call[0] as BenchmarkRequest);
    expect(calls.filter(call => call.suiteId !== "throughput-v1").every(call => call.promptTokens === call.configSnapshot!.ctxSize)).toBe(true);
    expect(calls.filter(call => call.suiteId === "throughput-v1").every(call => call.promptTokens === 2048 && call.runs === 2 && call.minimumQuality === undefined)).toBe(true);
    expect(state.profiles[0]).toEqual(stableProfile);
    expect(state.knownGoodProfile).toEqual(stableProfile);
    expect(state.config).toEqual(dirtyConfig);
    expect(state.savedConfig).toEqual(stableConfig);
    expect(state.dirty).toBe(true);
    expect(state.runningConfig).toEqual(original);
    expect(bridgeMocks.markProfileGood).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).toHaveBeenCalledTimes(3);
  });

  it("reuses a stability check when every goal selects the same configuration", async () => {
    const { request } = prepareProfileSearch();
    await useControlStore.getState().runBenchmark({ ...request, maximumContextTokens: 65536 });
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenCalledTimes(3);
    expect(useControlStore.getState().optimizerProfiles).toHaveLength(3);
  });

  it("falls back from an unstable upper context and never saves the failed variant", async () => {
    const { request } = prepareProfileSearch();
    const implementation = bridgeMocks.runBenchmarkSuite.getMockImplementation()!;
    bridgeMocks.runBenchmarkSuite.mockImplementation(async (...args) => {
      const result = await implementation(...args);
      return args[0].suiteId === "context-stability-v1" && args[0].configSnapshot.ctxSize === 262144
        ? { ...result, meetsTargets: false, suiteSummary: { ...result.suiteSummary, passed: false } } : result;
    });
    await useControlStore.getState().runBenchmark(request);
    expect(useControlStore.getState().optimizerProfiles.find(selection => selection.goal === "maxContext")?.profile.config.ctxSize).toBe(131072);
    expect(useControlStore.getState().optimizerProfiles.every(selection => selection.profile.config.ctxSize !== 262144)).toBe(true);
  });

  it("cancels profile search after the current operation without writing profiles", async () => {
    const { original, request } = prepareProfileSearch();
    const implementation = bridgeMocks.runBenchmarkSuite.getMockImplementation()!;
    bridgeMocks.runBenchmarkSuite.mockImplementation(async (...args) => {
      useControlStore.getState().cancelAutoTune();
      return implementation(...args);
    });
    await useControlStore.getState().runBenchmark(request);
    expect(bridgeMocks.runBenchmarkSuite).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().runningConfig).toEqual(original);
    expect(useControlStore.getState().optimizerProfiles).toEqual([]);
    expect(useControlStore.getState().busy).toBe(false);
  });

  it("does not save winners when restoration fails", async () => {
    const { request } = prepareProfileSearch();
    bridgeMocks.restartServer.mockImplementation(async config => {
      if (config.parallel === stableConfig.parallel) throw new Error("restore failed");
      return { pid: 222 };
    });
    await useControlStore.getState().runBenchmark(request);
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().runtime.state).toBe("crashed");
    expect(useControlStore.getState().error).toContain("restore failed");
    expect(useControlStore.getState().busy).toBe(false);
  });

  it("reports persistence failures without misreporting a successful restore as a crash", async () => {
    const { original, request } = prepareProfileSearch();
    bridgeMocks.saveProfile.mockRejectedValue(new Error("database is locked"));
    await useControlStore.getState().runBenchmark(request);
    expect(useControlStore.getState().runningConfig).toEqual(original);
    expect(useControlStore.getState().runtime.state).toBe("ready");
    expect(useControlStore.getState().error).toContain("database is locked");
    expect(useControlStore.getState().optimizerRunning).toBe(false);
  });

  it("respects the scanned model context limit and rejects a model below the floor before restart", async () => {
    const { request } = prepareProfileSearch();
    useControlStore.setState({ models: [{ id: "model", path: stableConfig.modelPath, fileName: "model.gguf", sizeBytes: 1, modifiedAt: "", contextLength: 32768 }] });
    await useControlStore.getState().runBenchmark(request);
    expect(bridgeMocks.restartServer).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().error).toBeTruthy();
  });

  it("continues after a candidate launch failure and applies the decode speed floor independently of quality", async () => {
    const { request } = prepareProfileSearch();
    bridgeMocks.restartServer.mockImplementation(async config => {
      if (config.ctxSize === 262144) throw new Error("out of memory");
      return { pid: 222 };
    });
    await useControlStore.getState().runBenchmark({ ...request, minimumGenerationTps: 50 });
    expect(useControlStore.getState().optimizerProfiles).toHaveLength(3);
    expect(useControlStore.getState().optimizerProfiles.every(selection => selection.profile.config.ctxSize < 262144)).toBe(true);
    const calls = bridgeMocks.runBenchmarkSuite.mock.calls.map(call => call[0] as BenchmarkRequest);
    expect(calls.filter(call => call.suiteId === "throughput-v1").every(call => call.minimumGenerationTps === 50)).toBe(true);
    expect(calls.filter(call => call.suiteId !== "throughput-v1").every(call => call.minimumGenerationTps === undefined)).toBe(true);
  });

  it("rejects an invalid measurement before touching the running process", async () => {
    const { request } = prepareProfileSearch();
    await useControlStore.getState().runBenchmark({ ...request, generationTokens: 65536 });
    expect(bridgeMocks.restartServer).not.toHaveBeenCalled();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(useControlStore.getState().error).toBeTruthy();
  });

  it("restores all router profiles and active settings, then adds the saved routes", async () => {
    const { original, request } = prepareProfileSearch(true);
    await useControlStore.getState().runBenchmark({ ...request, maximumContextTokens: 65536 });
    expect(bridgeMocks.restartRouter).toHaveBeenLastCalledWith(original, expect.objectContaining({ routerPort: 18081, routerApiKey: "original-key" }), [stableProfile], expect.anything());
    expect(bridgeMocks.refreshRouterProfiles).toHaveBeenCalledWith(expect.objectContaining({ routerPort: 18081 }), expect.arrayContaining([stableProfile]), expect.anything());
    expect(useControlStore.getState().profiles).toHaveLength(4);
    expect(bridgeMocks.markRouterGood).not.toHaveBeenCalled();
  });

  it("does not commit an experimental launch during background telemetry refresh", async () => {
    prepareProfileSearch();
    useControlStore.setState({ optimizerRunning: true, launchAttempt: 2, readyAttempt: 1, launchPid: 222 });
    await useControlStore.getState().refreshRuntime();
    expect(bridgeMocks.saveProfile).not.toHaveBeenCalled();
    expect(bridgeMocks.markProfileGood).not.toHaveBeenCalled();
  });

});
