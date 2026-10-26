import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, type LaunchProfile, type RouterRecoverySnapshot } from "../../types/app";
import { DEFAULT_CONFIG, type LaunchConfig } from "../../types/config";

type JsonRecord = Record<string, unknown>;
export interface SecretReference extends JsonRecord { provider: string; id: string; }
export interface NativeProfileV2 extends JsonRecord {
  id: string;
  name: string;
  description?: string;
  engine: string;
  unsupportedEngine?: string;
  revision: number;
  model: JsonRecord;
  engineOptions: JsonRecord & { engine: string; values: JsonRecord };
  legacyConfig?: JsonRecord;
  secretReferences?: Record<string, SecretReference>;
  envelopeExtensions?: JsonRecord;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastKnownGood: boolean;
}

/** Keep v2 when an editor copies a profile. It contains opaque refs, never credentials. */
export interface ProfileForUI extends LaunchProfile {
  revision: number;
  v2: NativeProfileV2;
}
export type ProfileEdit = LaunchProfile & Partial<Pick<ProfileForUI, "revision" | "v2">>;

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native errors and malformed v2 payloads propagate; this module has no legacy fallback. */
export function validateProfileV2(value: unknown): asserts value is NativeProfileV2 {
  if (!isObject(value) || !["id", "name", "engine", "createdAt", "updatedAt"].every(key =>
    typeof value[key] === "string" && (value[key] as string).trim().length > 0)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !isObject(value.model) || !isObject(value.engineOptions)
    || value.engineOptions.engine !== value.engine || !isObject(value.engineOptions.values)
    || typeof value.lastKnownGood !== "boolean"
    || (value.unsupportedEngine !== undefined && typeof value.unsupportedEngine !== "string")
    || (value.legacyConfig !== undefined && !isObject(value.legacyConfig))
    || (isObject(value.legacyConfig) && value.legacyConfig.engineOptions !== undefined && !isObject(value.legacyConfig.engineOptions))
    || (value.envelopeExtensions !== undefined && !isObject(value.envelopeExtensions))
    || (value.secretReferences !== undefined && (!isObject(value.secretReferences)
      || !Object.values(value.secretReferences).every(ref => isObject(ref)
        && typeof ref.id === "string" && typeof ref.provider === "string")))) {
    throw new Error("Invalid v2 profile payload; reload or repair the stored profile.");
  }
}

function merge(base: JsonRecord, update: JsonRecord): JsonRecord {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    // defineProperty also preserves JSON keys such as __proto__ as data.
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
      value: isObject(result[key]) && isObject(value) ? merge(result[key], value) : structuredClone(value) });
  }
  return result;
}

const engines = ["llama_cpp", "strata", "ollama", "qwfnfer", "infernix"];
const supportedEngines = ["llama_cpp", "strata"];
function keyedOptions(values: JsonRecord, engine: string): JsonRecord {
  if (typeof values.engine === "string" && isObject(values.values)) {
    return { [values.engine]: structuredClone(values.values) };
  }
  if (Object.keys(values).length === 0 || isObject(values[engine]) || engines.some(key => isObject(values[key]))) {
    return structuredClone(values);
  }
  return { [engine]: structuredClone(values) };
}

function legacyOptions(values: JsonRecord, engine: string): JsonRecord {
  // UI LaunchConfig already uses a complete map. Preserve future engine names
  // and map-level fields; only the historical {engine,values} adapter is converted.
  return typeof values.engine === "string" && isObject(values.values) ? keyedOptions(values, engine) : structuredClone(values);
}

export function profileV2ToUI(native: NativeProfileV2): ProfileForUI {
  validateProfileV2(native);
  const config = merge(native.legacyConfig ?? {}, {
    engine: native.engine, profileId: native.id, profileName: native.name,
    engineOptions: merge(legacyOptions((native.legacyConfig?.engineOptions as JsonRecord) ?? {}, native.engine),
      keyedOptions(native.engineOptions.values, native.engine)),
  });
  // Defaults fill old/missing editor fields, never replace an invalid v2 record.
  return {
    id: native.id, name: native.name, description: native.description,
    createdAt: native.createdAt, updatedAt: native.updatedAt,
    lastUsedAt: native.lastUsedAt, lastKnownGood: native.lastKnownGood,
    unsupportedEngine: supportedEngines.includes(native.engine) ? undefined : native.unsupportedEngine ?? native.engine,
    revision: native.revision, v2: structuredClone(native),
    config: merge(structuredClone(DEFAULT_CONFIG) as unknown as JsonRecord, config) as unknown as LaunchConfig,
  };
}

function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function canonicalReferences(base: NativeProfileV2, selectedEngine: string): Record<string, SecretReference> {
  const result: Record<string, SecretReference> = {};
  const keyed = isObject(base.engineOptions.values[base.engine]) || engines.some(key => isObject(base.engineOptions.values[key]));
  const legacyOptions = base.legacyConfig?.engineOptions;
  const optionPath = (engine: string, tail: string) => engine === selectedEngine
    ? `/engineOptions/values/${tail}` : `/legacyConfig/engineOptions/${escapePointer(engine)}/${tail}`;
  const mapOption = (tail: string) => {
    if (keyed) {
      const separator = tail.indexOf("/");
      const engine = tail.slice(0, separator);
      if (separator > 0 && isObject(base.engineOptions.values[engine])) return optionPath(engine, tail.slice(separator + 1));
    }
    return optionPath(base.engine, tail);
  };
  for (const [key, reference] of Object.entries(base.secretReferences ?? {})) {
    let path = key;
    if (!key.startsWith("/") && !key.startsWith("$envelope")) {
      const field = base.engine === "strata" && key === "apiKey" ? "strataApiKey" : key;
      path = optionPath(base.engine, escapePointer(field));
    } else if (key.startsWith("/engineOptions/values/")) {
      path = mapOption(key.slice("/engineOptions/values/".length));
    } else if (key.startsWith("/engineOptions/")) {
      const tail = key.slice("/engineOptions/".length);
      path = mapOption(tail);
    } else if (key.startsWith("/legacyConfig/engineOptions/values/") && isObject(legacyOptions)
      && typeof legacyOptions.engine === "string" && isObject(legacyOptions.values)) {
      path = `/legacyConfig/engineOptions/${escapePointer(legacyOptions.engine)}/${key.slice("/legacyConfig/engineOptions/values/".length)}`;
    } else if (key.startsWith("/") && !key.startsWith("/legacyConfig/")
      && base.legacyConfig !== undefined && key.split("/")[1] in base.legacyConfig) {
      path = `/legacyConfig${key}`;
    } else if (key.startsWith("/") && key.split("/").length === 2 && base.legacyConfig !== undefined) {
      // A migrated root credential leaf has been removed from legacyConfig.
      path = `/legacyConfig${key}`;
    }
    Object.defineProperty(result, path, { value: structuredClone(reference), enumerable: true, configurable: true });
  }
  return result;
}

/** Merge legacy editor edits into the retained v2 snapshot, including future data. */
export function profileToV2(edit: ProfileEdit, original: NativeProfileV2 | undefined = edit.v2): NativeProfileV2 {
  if (original) validateProfileV2(original);
  const now = new Date().toISOString();
  const engine = edit.config.engine ?? original?.engine ?? "llama_cpp";
  const oldOptions = original ? keyedOptions(original.engineOptions.values, original.engine) : {};
  const config = merge(original?.legacyConfig ?? {}, edit.config as unknown as JsonRecord);
  if (config.engineOptions !== undefined && !isObject(config.engineOptions)) {
    throw new Error("Profile config.engineOptions must be an object.");
  }
  const snapshot = merge(oldOptions, legacyOptions((config.engineOptions as JsonRecord) ?? {}, engine));
  config.engineOptions = structuredClone(snapshot);
  config.engine = engine;
  config.profileId = edit.id;
  config.profileName = edit.name;
  const native: NativeProfileV2 = {
    ...(original ? structuredClone(original) : {}),
    id: edit.id, name: edit.name, description: edit.description, engine,
    unsupportedEngine: supportedEngines.includes(engine) ? undefined : (original?.unsupportedEngine ?? engine),
    revision: original?.revision ?? 1, model: structuredClone(original?.model ?? {}),
    engineOptions: { ...(original?.engineOptions ?? {}), engine, values: isObject(snapshot[engine]) ? structuredClone(snapshot[engine]) : {} },
    legacyConfig: config, secretReferences: original ? canonicalReferences(original, engine) : {},
    createdAt: original?.createdAt ?? edit.createdAt ?? now,
    updatedAt: edit.updatedAt ?? now, lastUsedAt: edit.lastUsedAt,
    lastKnownGood: edit.lastKnownGood,
  };
  return native;
}

export async function listProfilesV2(): Promise<ProfileForUI[]> {
  const profiles = await invoke<NativeProfileV2[]>("list_profiles_v2");
  if (!Array.isArray(profiles)) throw new Error("Invalid v2 profile list payload.");
  return profiles.map(profileV2ToUI);
}
export async function getProfileV2(id: string): Promise<ProfileForUI | null> {
  const profile = await invoke<NativeProfileV2 | null>("get_profile_v2", { id });
  return profile === null ? null : profileV2ToUI(profile);
}
export async function saveProfileV2(edit: ProfileEdit, expectedRevision: number | null = edit.revision ?? null): Promise<ProfileForUI> {
  let original = edit.v2;
  // Editors that construct a fresh legacy-shaped object can supply the revision.
  // Fetching v2 preserves its refs/unknowns; errors never call legacy IPC.
  if (!original && expectedRevision !== null) {
    const current = await getProfileV2(edit.id);
    if (!current) throw new Error("Profile not found.");
    if (current.revision !== expectedRevision) throw new Error("Profile revision conflict. Reload the profile before saving.");
    original = current.v2;
  }
  const profile = profileToV2(edit, original);
  return profileV2ToUI(await invoke<NativeProfileV2>("save_profile_v2", { profile, expectedRevision }));
}
/** Import/export exchange JSON text. File dialog/read/write belongs to the caller. */
export async function importProfileV2(profileJson: string): Promise<ProfileForUI> {
  return profileV2ToUI(await invoke<NativeProfileV2>("import_profile_v2", { profileJson }));
}
export function exportProfileV2(id: string): Promise<string> { return invoke("export_profile_v2", { id }); }
export async function importProfileFileV2(path: string): Promise<ProfileForUI> {
  return profileV2ToUI(await invoke<NativeProfileV2>("import_profile_file_v2", { path }));
}
export function exportProfileFileV2(id: string, path: string): Promise<void> {
  return invoke("export_profile_file_v2", { id, path });
}
export function deleteProfileV2(id: string, expectedRevision: number): Promise<void> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("A profile revision is required for delete.");
  return invoke("delete_profile_v2", { id, expectedRevision });
}
/** Ephemeral credentials: pass directly to launch; never save/cache/export this result. */
export async function resolveProfileLaunchConfig(id: string): Promise<LaunchConfig> {
  const config = await invoke<unknown>("resolve_profile_launch_config", { id });
  if (!isObject(config) || typeof config.engine !== "string" || !isObject(config.engineOptions)) {
    throw new Error("Invalid resolved launch configuration.");
  }
  return config as unknown as LaunchConfig;
}

export function duplicateProfileV2(id: string, newId: string, name: string, expectedRevision: number): Promise<ProfileForUI> {
  return invoke<NativeProfileV2>("duplicate_profile_v2", { id, newId, name, expectedRevision }).then(profileV2ToUI);
}

interface NativeRouterRecovery {
  schemaVersion: number;
  profiles: NativeProfileV2[];
  config: JsonRecord;
  settings: JsonRecord;
  secretReferences?: Record<string, SecretReference>;
}
export interface RouterRecoveryForUI extends RouterRecoverySnapshot {
  profiles: ProfileForUI[];
  v2: NativeRouterRecovery;
}

function routerRecoveryToUI(snapshot: NativeRouterRecovery): RouterRecoveryForUI {
  if (snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.profiles) || !snapshot.profiles.length
    || !isObject(snapshot.config) || !isObject(snapshot.settings)) throw new Error("Invalid v2 router recovery snapshot.");
  const settings = { binaryPath: DEFAULT_SETTINGS.binaryPath, serverMode: DEFAULT_SETTINGS.serverMode,
    routerHost: DEFAULT_SETTINGS.routerHost, routerPort: DEFAULT_SETTINGS.routerPort,
    routerMaxLoadedModels: DEFAULT_SETTINGS.routerMaxLoadedModels, routerAutoload: DEFAULT_SETTINGS.routerAutoload,
    routerApiKey: "" };
  return {
    profiles: snapshot.profiles.map(profileV2ToUI),
    config: merge(structuredClone(DEFAULT_CONFIG) as unknown as JsonRecord, snapshot.config) as unknown as LaunchConfig,
    settings: merge(settings, snapshot.settings) as unknown as RouterRecoverySnapshot["settings"],
    v2: structuredClone(snapshot),
  };
}

export async function markProfileGoodV2(id: string, expectedRevision?: number): Promise<void> {
  if (expectedRevision === undefined) {
    const profile = await getProfileV2(id);
    if (!profile) throw new Error("Profile not found.");
    expectedRevision = profile.revision;
  }
  return invoke("mark_profile_good_v2", { id, expectedRevision });
}
export async function loadLastKnownGoodV2(): Promise<ProfileForUI | null> {
  const profile = await invoke<NativeProfileV2 | null>("last_known_good_profile_v2");
  return profile === null ? null : profileV2ToUI(profile);
}
/** Restore first, then resolveProfileLaunchConfig for launch; stored/UI snapshots stay redacted. */
export async function restoreLastKnownGoodProfileV2(): Promise<ProfileForUI> {
  return profileV2ToUI(await invoke<NativeProfileV2>("restore_last_known_good_profile_v2"));
}
export async function markRouterGoodV2(snapshot: RouterRecoverySnapshot): Promise<void> {
  const profiles = await Promise.all(snapshot.profiles.map(async profile => {
    const retained = profile as ProfileEdit;
    if (retained.v2) return retained.v2;
    const current = await getProfileV2(profile.id);
    if (!current) throw new Error("Router profile not found.");
    if (retained.revision !== undefined && current.revision !== retained.revision) throw new Error("Profile revision conflict. Reload before marking known-good.");
    return current.v2;
  }));
  return invoke("mark_router_good_v2", { snapshot: { profiles, config: snapshot.config, settings: snapshot.settings } });
}
export async function loadLastKnownGoodRouterV2(): Promise<RouterRecoveryForUI | null> {
  const snapshot = await invoke<NativeRouterRecovery | null>("last_known_good_router_v2");
  return snapshot === null ? null : routerRecoveryToUI(snapshot);
}
export async function restoreLastKnownGoodRouterV2(): Promise<RouterRecoveryForUI> {
  return routerRecoveryToUI(await invoke<NativeRouterRecovery>("restore_last_known_good_router_v2"));
}
