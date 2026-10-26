<a id="model-downloads"></a>
# Model downloads

## Purpose

The screen supports two installation paths. For Strata, it lists the installed engine's catalog and runs its setup for the complete model: weights, packs, tokenizer, and MTP where required. For llama.cpp, it searches public Hugging Face Hub GGUF repositories and installs a complete selected quantization in a library folder. A repository can also be opened by `owner/repo` or an HF link.

Downloads run independently from launch state and benchmark jobs; changing screens does not cancel the work. Download completion, compatibility, and engine readiness are separate results.

The layers are the [Rust module](../../../src-tauri/src/downloads/mod.rs), [frontend service](../../../src/features/modelDownloads/service.ts), and the [model library](models.md). Download history and installations are stored separately from the replaceable artifact index.

## IPC commands

All structures use camelCase. Tauri registers the commands and returns the JSON contracts in the coordination journal.

| Command | Arguments | Result |
| --- | --- | --- |
| `strata_model_catalog` | `{ rootValue }` | Models and variants from the installed Strata catalog |
| `start_strata_model_preparation` | `{ recipeId, rootValue, destination, existingDirectories }` | `PreparationStatus`; native Strata setup continues asynchronously |
| `model_preparation_status` | none | Current or most recently saved `PreparationStatus` |
| `cancel_model_preparation` | none | Requests cancellation of Strata setup and the child processes it owns |
| `search_model_downloads` | `{ query, engine, limit?, cursor?, sort?, allGguf? }` | `{ items, nextCursor }` with model metadata; `apps=llama.cpp` and `filter=gguf`, with the application filter removed when `allGguf=true`. `sort`: downloads/lastModified/likes; default 12, maximum 50 per page |
| `resolve_model_download` | `{ source }` | `ResolvedDownload`: repository, immutable revision, publisher, links, files, and variants |
| `prepare_model_download` | `{ selection, destination }` | `DownloadPlan`: complete validated set, unique folder, size, free space, and warnings |
| `start_model_download` | `{ planId }` | Persisted `DownloadTask`; transfer continues asynchronously |
| `list_model_downloads`, `get_model_download` | `{}` / `{ id }` | Authoritative queue snapshot or one task |
| `pause_model_download`, `resume_model_download` | `{ id }` | Updated task; resume is available after pausing or interruption |
| `cancel_model_download` | `{ id }` | Stopped task with staging files retained |
| `remove_model_download_partial` | `{ id }` | Removes only temporary files owned by that task |
| `model_download_destination` | `{ engine? }` | `<application folder>/models/llama` or `models/strata`; defaults to llama.cpp |

`ResolvedDownload` contains `source`, `repoId`, `revision`, `publisher`, `repositoryUrl`, `licenseUrl`, `files`, `variants`, and optional `suggestedFile`. Each file has a relative `path`, size, optional LFS SHA-256, `model`/`shard`/`mmproj` role, and optional quantization. A variant describes the complete file list and total byte count. Selecting one split shard expands to the full set; incomplete sets are rejected. `mmproj` is selected separately.

`DownloadPlan` fixes `planId`, source, repository, revision, full file list, `destination`, unique `finalPath`, `totalBytes`, `availableBytes`, and `warnings`. A `DownloadTask` contains its ID and sequence, plan, downloaded and total bytes, speed, current file, timestamps, and optional error, installed path, and verification details.

Search returns `{ items, nextCursor }`; the next cursor is used with the same query and sort. Items include optional `parameterCount`, `contextLength`, `sizeBytes`, `architecture`, `baseModel`, `license`, and `description` from HF metadata, plus `repoId`, `publisher`, `repositoryUrl`, downloads, likes, `tags`, optional `pipelineTag`/`lastModified`, and a `gated` flag. Search does not download files. Repository resolution separately checks access and offers the GGUF files that actually exist. The HF application tag helps find the right format; it does not prove architecture support in a particular llama.cpp build.

The GGUF size shown on a card is an HF metadata estimate, not the sum of all repository quantizations. The exact complete set size appears after choosing a GGUF. Unknown values remain unknown. The three ready llama.cpp recipes are in a collapsible quick-start section and do not limit search.

The default folder is separate for each engine; manual choices survive tab switches in the current dialog. At startup and on rescan, the application automatically indexes GGUF files in its `models/llama`, `models/strata`, and legacy `models/llama.cpp` folders; add other model folders manually. Existing files are not moved. The destination must be absolute and writable. It cannot be inside the installation root's `downloads`, `cache`, `modules`, `engines`, or `data` directories, or inside the component store; symlink and junction ancestors are rejected. Strata receives the selected path as `--data-dir`, placing prepared data there as well as GGUF files. Launch configurations remain in the installed Strata folder.

## Strata catalog and preparation

The catalog comes from the installed Strata `tools/strata_mcp.py`, its `Strata.model_table()`, and `setup.py` tables. The original new shell uses the same source for families and sizes. The list includes `OWN_PATH_FAMILIES` as well as regular families, instead of the previous three Aplot recipes. The installed Strata v0.2.3.1 with engine 0.1.48 includes Qwen3.8 Flash Next, Coder, Swift 1.5, Unsloth, Gyro, NVFP4, and Qwen3.6-35B-A3B with their available variants.

Download size, memory needs, experimental/images flags, and the `on_this_pc` estimate come from the engine catalog. Memory estimates are advisory: the model remains selectable. Strata checks preparation requirements, free space, GPU support, and the required files. If the installed catalog cannot be read, the application shows an error; the browser preview list is not presented as a successful read of the installation.

Preparation uses Python from Strata's private `.venv` and `setup.py --setup --yes --no-start`. It does not launch the model. Aplot passes the selected family and size as separate arguments, uses its own `STRATA_SETTINGS_FILE`, and does not write the standalone Strata shell's settings. Existing local files may be reused; the engine installer determines packs and other companion files.

If Strata's private `.venv` lacks pip, the wrapper runs the bundled `python -m ensurepip --upgrade` before an actual `--setup` invocation. Bootstrap is skipped when pip is present, for `--help`/`-h`, and when reading the catalog.

For data placement, Aplot's wrapper replaces automatic migration in `data_folder()`: new files use the selected folder and existing directories are reused in place. The original engine setup performs downloads, pinned-revision/hash checks and preparation.

`PreparationStatus` contains `id`, `recipeId`, `state`, recent output lines, a `recipe` snapshot, `destination`, `rootPath`, and optional `configPath`/`error`. Strata preparation is separate from the GGUF `DownloadTask`: it does not share the queue's byte progress, pause, or staging cleanup. Carriage-return updates expose the current stage and its percentage, rather than a percentage of the whole installation. Retrying after cancellation or failure retains the recipe, destination and engine root; native setup reuses completed steps. The last operation is persisted, and an old `installing` state becomes `interrupted` on recovery.

Successful setup is followed by validation of `strata-*.json`, the engine executable, tokenizer, and companion paths. The prepared-model catalog is then refreshed and the recipe installation flow saves a profile. A failed profile save can be retried separately without downloading the weights again. A direct arbitrary GGUF download leaves profile creation as a separate user action.

## States and events

States are `queued`, `resolving`, `downloading`, `verifying`, `installing`, `completed`, `pausing`, `paused`, `retry_wait`, `failed`, `cancelled`, and `interrupted`.

The `download://updated` event carries a full `DownloadTask`. Its `sequence` increases per task. The UI subscribes and then fetches a snapshot, ignoring events whose sequence was already handled. The snapshot and SQLite remain authoritative. Queue state does not use `control.ts` busy state or the `JobManager`.

A pause completes after writing stops and a checkpoint is saved. A normal exit preserves the task as paused; a crash marks it `interrupted`, with no automatic resume. Network retries use bounded backoff; insufficient space, access errors, and integrity failures need a separate action.

## Verification and publication

A Hub branch or tag resolves to an immutable commit SHA before transfer. Files stream into `.part` files in `<destination>/.aplot-staging/<downloadId>`. Staging is excluded from model indexing and runnable file scans. Size and LFS SHA-256 are checked when Hub supplies that exact digest algorithm; an Xet ID or arbitrary ETag is not treated as SHA-256. `verification: "source_sha256"` means every selected file had a source LFS SHA-256 and it matched. `verification: "size_gguf_local_sha256_only"` means size and GGUF structure passed, while at least one source digest was unavailable. In that case `localSha256` is a locally computed digest used for local verification and recovery; it does not prove that the bytes match the source. The task reports the verification level explicitly.

On resume, partial-file length is reconciled with the saved checkpoint. Range is used only with a confirmed validator; bytes from a changed revision are never appended to old data. Before publication, GGUF structure and split-set completeness are checked. The full directory is atomically renamed on the same volume to its unique `finalPath`, then its path and manifest are registered in `model_installations`.

A GGUF partial-file removal is limited to that task's staging directory and never overwrites an existing model. A direct GGUF download does not execute repository code or create a profile automatically. A supported recipe installation additionally validates the result and saves a profile. The installed files remain ordinary user model files; the library does not duplicate them for a second engine.

## Engine compatibility

llama.cpp and Strata can reference the same physical GGUF when it is compatible with the installed build. A completed download does not guarantee engine support or a successful launch.

Strata separately requires a prepared `strata-*.json`, tokenizer, and companion files. The configuration must be directly in the selected Strata root; model data may be on a different drive. A profile stores the root and configuration path instead of treating the weights folder as the engine root. The global library discovers prepared configurations from the Strata root selected in Settings.

A downloaded `qwen4exp` GGUF without a validated configuration is detected by `needsStrataPreparation`: its card shows “Strata preparation required” and remains visible in the Strata filter. “Prepare for Strata” opens the preparation catalog; the model is not assigned a ready engine source yet. Once a validated configuration is discovered, the pending state is replaced by the normal model configuration action.

A GGUF download does not create a Strata configuration or mark the engine ready without validation. Use the Strata catalog and preparation for a complete installation. HF token login, gated/private repository downloads, arbitrary HTTPS sources, and arbitrary safetensors snapshots are unsupported. A gated repository may appear in search; this does not grant download access.
