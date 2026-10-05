# Persistent data model

The database is named `llama-control.sqlite3` and runs in WAL mode. If an executable ancestor contains both `engines` and `models`, it lives in that workspace's `data` folder. Otherwise it uses the Tauri application data directory (`%APPDATA%\app.aplot.llamacontrol` on Windows). Startup creates a consistent database backup. Settings and exported profiles may contain API keys.

## `profiles`
Stores profile identity plus serialized `LaunchConfig`.

Important fields:
- `id` — stable UUID/string profile id;
- `config_json` — source-of-truth launch snapshot;
- `last_known_good` — currently confirmed working profile marker;
- `last_used_at` — last successful-ready marker time.

## `kv`
Generic app-level JSON values. Current keys:
- `settings` — serialized `AppSettings`;
- `last_known_good_profile` — immutable serialized profile snapshot used by recovery.
- `last_known_good_router` — immutable snapshot containing all saved profiles, active LaunchConfig and router settings.

Recovery snapshots are intentionally separate from editable `profiles` rows. This prevents a failed edited configuration from destroying the last working state. The router snapshot covers the complete route set so rollback does not restore only one model from a multi-profile router.

## Router settings and generated preset
`settings` includes the router mode, host, port, maximum simultaneously loaded models, autoload preference and shared API key. Defaults are router mode, `127.0.0.1:8080`, one resident model and autoload enabled. The generated `router-presets.ini` is derived from saved profile rows and current binary capabilities, and lives in Tauri's app-data directory; it is regenerated when the router starts or restarts rather than treated as an independent source of truth.

Each profile name is the router's API model ID. Names must be non-empty and unique, and each profile must refer to a model file.

## `benchmarks`
Stores benchmark result JSON plus profile id/name and creation time. The frontend currently loads the latest 100 rows.

## `events`
Append-only operational audit rows for selected lifecycle events such as start/stop/restart.

## Profile JSON interchange
`export_profile` writes a versioned envelope:
```json
{
  "schemaVersion": 1,
  "exportedAt": "...",
  "profile": { "...": "..." }
}
```
Importer also accepts a raw `LaunchProfile` object for compatibility. ID collision creates a new UUID and rewrites nested `profileId`/`profileName` in `config`.
