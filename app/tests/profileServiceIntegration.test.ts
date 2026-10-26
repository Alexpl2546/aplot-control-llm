import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_CAPABILITIES } from "../src/types/config";
import { DEFAULT_SETTINGS } from "../src/types/app";
import { profileV2ToUI, type NativeProfileV2 } from "../src/features/profiles/bridge";
import { restoreEngineOptions } from "../src/features/launches/profiles";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { createRunStartRequest, deleteProfile, duplicateProfileSnapshot, exportProfile, importProfile, listProfiles, loadLastKnownGood, markProfileGood, restoreLastKnownGoodProfile, saveProfile } from "../src/services/tauri";

const native = (): NativeProfileV2 => ({ id: "p", name: "Profile", engine: "qwfnfer", unsupportedEngine: "qwfnfer", revision: 3,
  model: { future: true }, engineOptions: { engine: "qwfnfer", values: { qwfn: { ...DEFAULT_SETTINGS.qwfn, modelPath: "model.gguf", apiKey: "" } } },
  legacyConfig: { ...DEFAULT_CONFIG, engine: "qwfnfer", profileId: "p", profileName: "Profile" },
  secretReferences: { "/engineOptions/values/qwfn/apiKey": { provider: "windows-dpapi-v1", id: "opaque" } },
  envelopeExtensions: { future: { preserved: true } }, createdAt: "now", updatedAt: "now", lastKnownGood: false });

describe("v2 profile integration boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); });

  it("routes CRUD through v2 and preserves revision/reference/unknown fields", async () => {
    const profile = profileV2ToUI(native());
    mocks.invoke.mockImplementation(async command => command === "list_profiles_v2" ? [native()] : command === "save_profile_v2" || command === "import_profile_file_v2" ? native() : undefined);
    expect((await listProfiles())[0].revision).toBe(3);
    await saveProfile({ ...profile, name: "Edited" });
    expect(mocks.invoke).toHaveBeenCalledWith("save_profile_v2", expect.objectContaining({ expectedRevision: 3, profile: expect.objectContaining({ model: { future: true }, secretReferences: native().secretReferences, envelopeExtensions: native().envelopeExtensions }) }));
    await deleteProfile("p", 3);
    expect(mocks.invoke).toHaveBeenCalledWith("delete_profile_v2", { id: "p", expectedRevision: 3 });
    await importProfile("profile.json"); await exportProfile("p", "out.json");
    expect(mocks.invoke).toHaveBeenCalledWith("import_profile_file_v2", { path: "profile.json" });
    expect(mocks.invoke).toHaveBeenCalledWith("export_profile_file_v2", { id: "p", path: "out.json" });
  });

  it("propagates damaged v2 without calling legacy IPC", async () => {
    mocks.invoke.mockResolvedValue([{ ...native(), revision: 0 }]);
    await expect(listProfiles()).rejects.toThrow("Invalid v2");
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["list_profiles_v2"]);
    await expect(deleteProfile("p")).rejects.toThrow("revision");
  });
  it("routes duplicate and known-good recovery through revision-aware v2 commands", async () => {
    const profile = profileV2ToUI(native());
    mocks.invoke.mockImplementation(async command => command === "mark_profile_good_v2" ? undefined : native());
    await duplicateProfileSnapshot(profile, "copy", "Copy");
    expect(mocks.invoke).toHaveBeenCalledWith("duplicate_profile_v2", { id: "p", newId: "copy", name: "Copy", expectedRevision: 3 });
    await markProfileGood("p", 3);
    expect(mocks.invoke).toHaveBeenCalledWith("mark_profile_good_v2", { id: "p", expectedRevision: 3 });
    expect((await loadLastKnownGood())?.v2.secretReferences).toEqual(native().secretReferences);
    expect((await restoreLastKnownGoodProfile()).revision).toBe(3);
    expect(mocks.invoke).toHaveBeenCalledWith("restore_last_known_good_profile_v2");
    expect(mocks.invoke.mock.calls.every(call => String(call[0]).endsWith("_v2"))).toBe(true);
  });

  it("keeps a legacy profile available for export but refuses to launch it", async () => {
    const profile = profileV2ToUI(native());
    const config = structuredClone(profile.config);
    config.engineOptions!.qwfnfer!.qwfn = { ...DEFAULT_SETTINGS.qwfn, modelPath: "model.gguf", context: 12345, apiKey: "" };
    expect(profile.unsupportedEngine).toBe("qwfnfer");
    await expect(createRunStartRequest({ runId: "trial:1", config, settings: DEFAULT_SETTINGS, profiles: [profile], capabilities: DEFAULT_CAPABILITIES }))
      .rejects.toThrow("Unsupported profile engine");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("prepares router resource preview with no IPC or secret resolution", async () => {
    const config = { ...DEFAULT_CONFIG, modelPath: "model.gguf" };
    const profile = { id: config.profileId, name: config.profileName, config, createdAt: "now", updatedAt: "now", lastKnownGood: false };
    const request = await createRunStartRequest({ runId: "preview", config, settings: { ...DEFAULT_SETTINGS, serverMode: "router" }, profiles: [profile], capabilities: DEFAULT_CAPABILITIES, preview: true });
    expect(request.launch.args).toContain("<router-preset>");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("uses restored router credentials transiently with a run-scoped preset", async () => {
    const data = native(); data.engine = "llama_cpp";
    data.engineOptions = { engine: "llama_cpp", values: { serverMode: "router", routerHost: "127.0.0.1", routerPort: 8080, routerApiKey: "" } };
    data.legacyConfig = { ...DEFAULT_CONFIG, engine: "llama_cpp", profileId: "p", profileName: "Profile", modelPath: "model.gguf" };
    data.secretReferences = { "/engineOptions/values/routerApiKey": { provider: "windows-dpapi-v1", id: "restored-ref" } };
    const profile = profileV2ToUI(data); const before = JSON.stringify(profile);
    const resolved = structuredClone(profile.config); resolved.engineOptions!.llama_cpp!.routerApiKey = "protected-router-key";
    mocks.invoke.mockImplementation(async command => command === "resolve_profile_launch_config" ? resolved : command === "write_router_preset" ? "preset.ini" : undefined);
    const request = await createRunStartRequest({ runId: "profile:p", config: profile.config, settings: DEFAULT_SETTINGS, profiles: [profile], capabilities: DEFAULT_CAPABILITIES });
    expect(request.launch.apiKey).toBe("protected-router-key");
    expect(mocks.invoke).toHaveBeenCalledWith("write_router_preset", expect.objectContaining({ runId: "profile:p" }));
    expect(JSON.stringify(profile)).toBe(before);
    expect(mocks.invoke.mock.calls.find(call => call[0] === "write_router_preset")?.[1].preset).not.toContain("protected-router-key");
  });

  it("retains unknown engine records and rejects their launch", async () => {
    const unknown = native(); unknown.engine = "future-engine"; unknown.engineOptions.engine = unknown.engine;
    const profile = profileV2ToUI(unknown);
    expect(profile.v2).toEqual(unknown);
    expect(restoreEngineOptions(profile.config, DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS);
    await expect(createRunStartRequest({ runId: "future", config: profile.config, settings: DEFAULT_SETTINGS, profiles: [profile], capabilities: DEFAULT_CAPABILITIES, preview: true })).rejects.toThrow("Unsupported profile engine");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
