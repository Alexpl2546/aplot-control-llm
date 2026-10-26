<a id="profiles-v2"></a>
# Profiles module

## Scope and source map

Profiles v2 provide additive migration, revision-checked editing, JSON import/export, protected credentials, native launch resolution, independent duplication, and frozen recovery checkpoints. [bridge.ts](../../../src/features/profiles/bridge.ts) retains the opaque native snapshot alongside the familiar editor LaunchConfig. UI and launch callers use the bridge through the application service layer.

Native code: [profile_store.rs](../../../src-tauri/src/profile_store.rs), [profile_recovery.rs](../../../src-tauri/src/profile_recovery.rs), [migrations.rs](../../../src-tauri/src/migrations.rs), [domain/profile.rs](../../../src-tauri/src/domain/profile.rs), [domain/secrets.rs](../../../src-tauri/src/domain/secrets.rs). [profileAdapters.ts](../../../src/features/profiles/profileAdapters.ts) contains historical settings helpers, while bridge.ts supplies CRUD/recovery wrappers. Commands are registered in [lib.rs](../../../src-tauri/src/lib.rs).

## JSON and IPC contracts

Interchange and SQLite store an envelope `{schemaVersion: 2, profile: {...}, ...unknownEnvelopeFields}`. CRUD IPC returns profile fields flattened into one object, with envelope extras in `envelopeExtensions`. The bridge retains these extras; export reconstructs the interchange envelope without inserting a metadata wrapper.

| Field | Contract |
| --- | --- |
| `id`, `name`, `description` | Stable identity and display metadata. |
| `engine` | String ID; future engine IDs survive storage/export. |
| `revision` | Positive optimistic-concurrency revision. |
| `model` | Artifact ID, legacy paths, engine model ID, unknown fields. |
| `engineOptions` | `{engine, values}` plus extensions; new bridge saves contain selected-engine values. |
| `legacyConfig` | Optional launch-config object, including the full engineOptions map by engine. |
| `secretReferences` | JSON pointer or migrated key mapped to opaque provider/ID. |
| `createdAt`, `updatedAt`, `lastUsedAt`, `lastKnownGood` | Timestamps and checkpoint metadata. |
| Unknown profile/model/options/envelope fields | Preserved through read/edit/save/import/export. |

The bridge accepts older flat/keyed snapshots while preserving original values and unknown fields for export. Only `llama_cpp` and `strata` appear in active launch selection; a legacy ID stays inactive, shows a reason, and is never converted to another engine. Defaults fill missing editor fields only for a supported profile; malformed v2 data still fails. Native reads validate envelope ID/revision against the SQLite row. Unsupported versions, corrupt JSON, and revision conflicts never trigger legacy CRUD fallback.

## Storage and migration

Database startup calls `migrations::migrate` after initializing old tables. Migration version 1 creates the migration journal and `launch_profiles_v2`, `profile_secrets`, `model_artifacts`, `artifact_files`, `artifact_consumers` in an immediate transaction. It validates required columns before recording success. Incompatible existing tables, failed conversion, and future database versions abort migration.

Legacy IDs, metadata, full configs, and unknown fields are copied. Populated global engine settings from the earlier version remain as deterministic `legacy-global-*` profiles; default/empty settings do not create profiles. A legacy profile can be inspected and exported, but launching requires a new user-selected `llama_cpp` or `strata` profile. Original profile rows, raw kv.settings, legacy recovery keys, events, favorites, and benchmark history remain unchanged. Migration neither moves nor deletes model weights.

## CRUD, files, and duplication

Tauri arguments use camelCase. All commands below are registered.

| Command | Behavior |
| --- | --- |
| `list_profiles_v2` | Sanitized profiles ordered by last use/update. |
| `get_profile_v2({id})` | Sanitized profile or null; corrupt rows fail. |
| `save_profile_v2({profile, expectedRevision})` | Null creates revision 1; matching revision updates/increments; stale edits conflict. |
| `delete_profile_v2({id, expectedRevision})` | Requires matching revision; missing/stale row conflicts. |
| `import_profile_v2({profileJson})` | V2/v1 envelope or raw legacy profile; collisions get new ID/name. Invalid explicit or future versions fail. |
| `export_profile_v2({id})` | Redacted v2 envelope JSON, preserving refs/unknowns. |
| `import_profile_file_v2({path})` | Native UTF-8 JSON read, up to 8 MiB, using the same importer. |
| `export_profile_file_v2({id, path})` | Redacted envelope written to a .json file. |
| `duplicate_profile_v2({id, newId, name, expectedRevision})` | Revision-checked clone at revision 1 with fresh profile-bound secret refs. |

Duplication copies ciphertext without returning plaintext. Repeated aliases remain consistent and deleting the source does not break the clone. Exported references do not carry ciphertext for another installation. Legacy export also removes credential values.

## Credentials and launch resolution

Secret-like string keys (apiKey/token/password/secret/authorization variants) are detected recursively, including extensions. A credential flag such as `--api-key`, `--token=...`, or `--password` protects the entire extraArgs string, retaining its exact quoting/spacing. New credentials are removed from JSON and stored as Windows DPAPI ciphertext in the profile transaction. Unreferenced live ciphertext is pruned; newly supplied plaintext fails closed on non-Windows systems.

A sanitized blank field retains its reference. A nonempty ordinary replacement of protected extraArgs removes that string's reference. No general reveal/copy/forget editor is supplied. DPAPI requires the original Windows user/machine context. Migrated legacy refs resolve from unchanged original profile/settings data.

`resolve_profile_launch_config({id})` / `resolveProfileLaunchConfig(id)` returns a fresh config with the full map by engine. Selected native values overlay the legacy snapshot. Only launch credential paths are restored; profile/model/envelope extension secrets are excluded. DPAPI references are checked against owner/profile/provider. Missing, corrupt, invalid, or inaccessible refs fail explicitly. Resolution does not write the database.

The result contains ephemeral plaintext: pass it directly to launch, never cache it in editor/profile state, log it, save it as a profile, or export it. Defaults, adapter preparation, and immutable run snapshots belong to the application launch service and engine adapters.

## Frozen recovery checkpoints

New keys are `last_known_good_profile_v2` and `last_known_good_router_v2`. Snapshots freeze full envelopes/config/settings plus an encrypted vault backup independent of live secret rows. Editing/deleting a live profile cannot erase captured config/ciphertext. Reads return sanitized profiles/settings and never return the vault to the UI.

| Command | Behavior |
| --- | --- |
| `mark_profile_good_v2({id, expectedRevision})` | Checks revision, freezes profile, updates last-use/good metadata without changing config revision. |
| `last_known_good_profile_v2` | Sanitized checkpoint or null. |
| `restore_last_known_good_profile_v2` | Transactionally restores profile/vault and returns new sanitized revision. |
| `mark_router_good_v2({snapshot})` | Checks llama.cpp profile revisions; freezes stored profiles and actual runtime config/router settings. |
| `last_known_good_router_v2` | Sanitized router checkpoint or null. |
| `restore_last_known_good_router_v2` | Transactionally restores profiles/vault and selected nonsecret router settings. |

Only absence of a new key permits legacy raw-key recovery. A corrupt new checkpoint fails; legacy reads do not rewrite their source keys. Explicit restore can recreate a deleted profile or repair a corrupt live envelope. Its revision exceeds both current SQL and captured revisions; the checkpoint retains its captured revision.

Router restore merges a whitelist of nonsecret fields into existing settings, preserving language/theme/dashboard/unknowns. Router credentials become restored profile refs. After restore, resolve the profile and take `launch.engineOptions.llama_cpp.routerApiKey` into transient router launch settings. UI snapshots remain redacted; no decrypted router key is written to global settings.

## Validation and preservation evidence

[profileV2.test.ts](../../../tests/profileV2.test.ts) covers bridge round trips, future fields/engine maps, revisions, wrappers, and recovery payloads. Native tests cover migration rollback/idempotence, DPAPI, ref ownership, duplication, frozen recovery after edit/delete, export redaction, extraArgs protection, and launch resolution.

The full profile run passed 122 library tests, with 6 ignored, plus the Windows activation integration test. Targeted profile/model TypeScript tests passed 15 tests; `npm run typecheck` passed. Counts describe the shared checkout at validation time.

The separate ignored proof uses `APLOT_MIGRATION_SOURCE` pointing to the baseline copy and `APLOT_MIGRATION_REPORT` to an output JSON path. From app run `cargo test --locked --manifest-path src-tauri/Cargo.toml migrations::tests::migration_copy_preserves_real_baseline -- --ignored --exact`. It opens the source read-only, migrates a temporary scratch copy twice, and compares full original schemas/cells/file bytes. It rejects the actual working database as a source.

The migration check retained 40 legacy profiles and created 44 v2 profiles including four globals. All five original tables and both raw recovery/settings entries remained unchanged; integrity passed and source bytes did not change. FNV digests are labels; assertions compare complete data.

## Current limits

model.artifactId does not yet replace legacy paths. There is no general credential reveal/forget flow or portable ciphertext export. Recovery requires valid ciphertext and the original DPAPI context. Engine defaults/compatibility are owned by adapters. These limits do not permit silent fallback or mutation of original legacy data.

The Profiles tab lists only saved Aplot profiles. Auto-discovered Strata configurations belong to the model library and are not added to profile cards or counts. Generic llama.cpp KV/GPU fields are not displayed as native Strata settings.
