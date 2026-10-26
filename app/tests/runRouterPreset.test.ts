import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type LaunchProfile } from "../src/types/app";
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG } from "../src/types/config";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { createRunStartRequest, refreshRouterProfiles } from "../src/services/tauri";

describe("managed router preset scoping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "validate_llama_models") return undefined;
      if (command === "write_router_preset") return "C:/app-data/routers/profile_example/preset.ini";
      throw new Error(`Unexpected command ${command}`);
    });
  });

  it("launches and reloads the selected same-name profile using the exact generated route", async () => {
    const config = { ...DEFAULT_CONFIG, profileId: "profile-a", profileName: "gpt-oss-20b", modelPath: "C:/models/example.gguf" };
    const first: LaunchProfile = { id: config.profileId, name: config.profileName, config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    const second = { ...first, id: "profile-b", config: { ...config, profileId: "profile-b", ctxSize: 131072 } };
    const settings = { ...DEFAULT_SETTINGS, serverMode: "router" as const, serverEngine: "llama_cpp" as const };
    const profiles = [first, second];
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "validate_llama_models") return;
      if (command === "write_router_preset") return "C:/app-data/preset.ini";
      if (command === "reload_router_models") return ["gpt-oss-20b--profile-a", "gpt-oss-20b--profile-b"];
      throw new Error(`Unexpected command ${command}`);
    });
    const request = await createRunStartRequest({ runId: "profile:profile-b", config: second.config, settings, profiles, capabilities: DEFAULT_CAPABILITIES });
    expect(request.modelId).toBe("gpt-oss-20b--profile-b");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("write_router_preset", expect.objectContaining({ preset: expect.stringContaining("[gpt-oss-20b--profile-b]") }));
    await expect(refreshRouterProfiles(settings, profiles, DEFAULT_CAPABILITIES, { runId: request.runId, profileId: second.id })).resolves.toBeUndefined();
  });

  it("writes a router preset under the target managed run ID", async () => {
    const config = { ...DEFAULT_CONFIG, profileId: "example", profileName: "Example route", modelPath: "C:/models/example.gguf" };
    const profile: LaunchProfile = { id: config.profileId, name: config.profileName, config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    const settings = { ...DEFAULT_SETTINGS, serverMode: "router" as const, serverEngine: "llama_cpp" as const };

    const request = await createRunStartRequest({ runId: "profile:example", config, settings, profiles: [profile], capabilities: DEFAULT_CAPABILITIES });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("write_router_preset", expect.objectContaining({ runId: "profile:example", preset: expect.stringContaining("[Example route]") }));
    expect(request.launch.args as string[]).toContain("C:/app-data/routers/profile_example/preset.ini");
    expect(request.runId).toBe("profile:example");
    expect(request.autoPort).toBe(true);
  });
});
