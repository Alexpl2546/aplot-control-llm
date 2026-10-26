import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { duplicateProfileV2, exportProfileFileV2, getProfileV2, importProfileFileV2, listProfilesV2, loadLastKnownGoodV2, markProfileGoodV2, profileToV2, profileV2ToUI, restoreLastKnownGoodProfileV2, saveProfileV2, type NativeProfileV2 } from "../src/features/profiles/bridge";
import { captureEngineOptions, engineOptionsFromSettings, restoreEngineOptions, type ProfileLaunchConfig } from "../src/features/profiles/profileAdapters";
import { DEFAULT_SETTINGS, type ServerEngine } from "../src/types/app";
import { DEFAULT_CONFIG } from "../src/types/config";

const engines: ServerEngine[] = ["llama_cpp", "strata"];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function nativeProfile(): NativeProfileV2 {
  return {
    id: "v2", name: "V2", engine: "infernix", revision: 7,
    model: { artifactId: "artifact", futureModel: [1] },
    engineOptions: { engine: "infernix", values: { context: 131072, futureKnob: { retained: true } }, futureMeta: 2 },
    legacyConfig: { ...DEFAULT_CONFIG, engine: "infernix", futureLaunch: { kept: true },
      engineOptions: { infernix: { context: 131072 }, strata: { strataPort: 8092, futureOther: 8 } } },
    secretReferences: { "/engineOptions/values/apiKey": { provider: "windows-dpapi-v1", id: "protected" },
      "/legacyConfig/apiKey": { provider: "windows-dpapi-v1", id: "root" } },
    envelopeExtensions: { futureEnvelope: { keep: 4 } }, futureProfile: { plugin: [3] },
    createdAt: "created", updatedAt: "updated", lastKnownGood: true,
  };
}

describe("v2 native bridge", () => {
  it("retains future engine map entries and map-level extension fields", () => {
    const native = nativeProfile();
    native.legacyConfig!.engineOptions = { futureEngine: { novel: 23 }, futureMapVersion: 8 };
    const saved = profileToV2(profileV2ToUI(native));
    expect(saved.legacyConfig!.engineOptions).toMatchObject({ futureEngine: { novel: 23 }, futureMapVersion: 8 });
    expect(saved.engineOptions.values.futureKnob).toEqual({ retained: true });
  });

  it("uses native file/recovery/duplicate adapters with revisions and no plaintext reveal", async () => {
    const native = nativeProfile();
    vi.mocked(invoke).mockReset().mockResolvedValueOnce(native).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(native).mockResolvedValueOnce(undefined).mockResolvedValueOnce(native)
      .mockResolvedValueOnce({ ...native, id: "copy", revision: 1 });
    await importProfileFileV2("C:/profile.json");
    await exportProfileFileV2("v2", "C:/export.json");
    expect((await loadLastKnownGoodV2())!.v2.secretReferences).toEqual(native.secretReferences);
    await markProfileGoodV2("v2", 7);
    await restoreLastKnownGoodProfileV2();
    await duplicateProfileV2("v2", "copy", "Copy", 7);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["import_profile_file_v2", { path: "C:/profile.json" }], ["export_profile_file_v2", { id: "v2", path: "C:/export.json" }],
      ["last_known_good_profile_v2"], ["mark_profile_good_v2", { id: "v2", expectedRevision: 7 }],
      ["restore_last_known_good_profile_v2"], ["duplicate_profile_v2", { id: "v2", newId: "copy", name: "Copy", expectedRevision: 7 }],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Invalid v2 recovery JSON"));
    await expect(loadLastKnownGoodV2()).rejects.toThrow("Invalid v2 recovery");
    expect(vi.mocked(invoke).mock.calls.at(-1)![0]).toBe("last_known_good_profile_v2");
  });
  it("roundtrips a legacy editor edit with unknowns, all engine snapshots and blank credentials", () => {
    const native = nativeProfile();
    const before = structuredClone(native);
    const ui = profileV2ToUI(native);
    ui.name = "Edited";
    ui.config.ctxSize = 65536;
    ui.config.apiKey = "";
    ui.config.engineOptions!.infernix!.apiKey = "";
    const saved = profileToV2(ui);
    expect(saved.secretReferences).toEqual(native.secretReferences);
    expect(saved.unsupportedEngine).toBe("infernix");
    expect(saved.engineOptions.values.futureKnob).toEqual({ retained: true });
    expect(saved.engineOptions.values.context).toBe(131072);
    expect(saved.legacyConfig!.engineOptions).toMatchObject({ strata: { strataPort: 8092, futureOther: 8 } });
    expect(saved.futureProfile).toEqual(native.futureProfile);
    expect(saved.envelopeExtensions).toEqual(native.envelopeExtensions);
    expect(saved.model).toEqual(native.model);
    expect(saved.engineOptions.futureMeta).toBe(2);
    expect(saved.legacyConfig!.futureLaunch).toEqual({ kept: true });
    expect(saved.legacyConfig!.ctxSize).toBe(65536);
    expect(native).toEqual(before);
  });

  it("normalizes earlier migrated engine maps and preserves refs when switching engines", () => {
    const native = nativeProfile();
    native.engineOptions.values = { infernix: { context: 131072, futureKnob: 42 }, strata: { strataPort: 8092 } };
    native.secretReferences = { "/engineOptions/infernix/apiKey": { provider: "windows-dpapi-v1", id: "keep" } };
    const ui = profileV2ToUI(native);
    ui.config.engine = "strata";
    const saved = profileToV2(ui);
    expect(saved.engineOptions.engine).toBe("strata");
    expect(saved.engineOptions.values).toEqual({ strataPort: 8092, futureOther: 8 });
    expect(saved.legacyConfig!.engineOptions).toMatchObject({ infernix: { futureKnob: 42, context: 131072 } });
    expect(saved.secretReferences).toEqual({ "/legacyConfig/engineOptions/infernix/apiKey": { provider: "windows-dpapi-v1", id: "keep" } });
  });

  it("fetches the v2 basis for a fresh legacy-shaped edit and sends its expected revision", async () => {
    const native = nativeProfile();
    const legacy = profileV2ToUI(native);
    const { v2: _v2, revision: _revision, ...edit } = legacy;
    vi.mocked(invoke).mockReset().mockResolvedValueOnce(native).mockImplementationOnce(async (_command, payload) => {
      const saved = (payload as { profile: NativeProfileV2 }).profile;
      return { ...saved, revision: 8 };
    });
    const saved = await saveProfileV2({ ...edit, name: "Edit without retained DTO" }, 7);
    expect(invoke).toHaveBeenNthCalledWith(1, "get_profile_v2", { id: "v2" });
    expect(invoke).toHaveBeenNthCalledWith(2, "save_profile_v2", expect.objectContaining({ expectedRevision: 7,
      profile: expect.objectContaining({ futureProfile: native.futureProfile, secretReferences: native.secretReferences }) }));
    expect(saved.revision).toBe(8);
  });

  it("fails corrupt v2 and native errors without a legacy IPC fallback", async () => {
    vi.mocked(invoke).mockReset().mockResolvedValueOnce([{ ...nativeProfile(), legacyConfig: "broken" }]);
    await expect(listProfilesV2()).rejects.toThrow("Invalid v2");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Stored profile JSON is invalid"));
    await expect(getProfileV2("v2")).rejects.toThrow("invalid");
    expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual(["list_profiles_v2", "get_profile_v2"]);
  });
});

describe("legacy profile engine option adapters", () => {
  it.each(engines)("captures and restores every %s settings shape", (engine) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    switch (engine) {
      case "llama_cpp":
        Object.assign(settings, { binaryPath: "E:/llama.exe", serverMode: "single", routerPort: 8181, routerApiKey: "router-key" });
        break;
      case "strata":
        Object.assign(settings, { strataRootPath: "E:/strata", strataConfigPath: "E:/strata/config.yaml", strataApiKey: "strata-key" });
        break;
    }

    const legacy = {
      ...DEFAULT_CONFIG,
      futureLaunchField: { kept: true },
      engineOptions: {
        engine: "llama_cpp",
        values: { futureEngineOption: { preserved: 4 } },
        futureEnvelopeField: "keep-too",
      },
    } as ProfileLaunchConfig;
    const captured = captureEngineOptions(settings, engine, legacy);
    expect(captured.futureLaunchField).toEqual({ kept: true });
    expect(captured.engineOptions?.engine).toBe(engine);
    expect(captured.engineOptions?.values.futureEngineOption).toEqual({ preserved: 4 });
    expect(captured.engineOptions?.futureEnvelopeField).toBe("keep-too");

    const restored = restoreEngineOptions(DEFAULT_SETTINGS, captured);
    const restoredKnown = engineOptionsFromSettings(restored, engine).values;
    const expectedKnown = engineOptionsFromSettings(settings, engine).values;
    delete restoredKnown.futureEngineOption;
    expect(restoredKnown).toEqual(expectedKnown);
    expect(captured.engineOptions?.values.futureEngineOption).toEqual({ preserved: 4 });
  });

  it("leaves config unknowns intact when engine settings are restored", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const config = {
      ...DEFAULT_CONFIG,
      extensionData: { fromPlugin: ["untouched"] },
      engine: "strata",
      engineOptions: { engine: "strata", values: { strataRootPath: "E:/Strata", strataConfigPath: "E:/Strata/config.yaml", newKnob: 23 } },
    } as ProfileLaunchConfig;
    const next = restoreEngineOptions(settings, config);
    expect(next.strataRootPath).toBe("E:/Strata");
    expect(config.extensionData).toEqual({ fromPlugin: ["untouched"] });
    expect(config.engineOptions?.values.newKnob).toBe(23);
  });
});
