<a id="model-artifacts"></a>
# Models and artifacts

## Responsibility and source map

The library presents local files, split-GGUF groups, projectors, profiles, and active runs. Scanning only reads the filesystem; it does not delete, move, or repair models. The artifact catalogue is replaceable on scan and is not durable download history.

[model_artifacts.rs](../../../src-tauri/src/model_artifacts.rs) scans supplied roots. [artifact_service.rs](../../../src-tauri/src/artifact_service.rs) gathers consumers from the library, profiles, and active runs, excludes staging, and stores a replaceable index. Downloads and installed sets belong to the separate [downloads module](model-downloads.md).

## Catalogue commands and consumers

| Command | Input and result |
| --- | --- |
| `model_catalog` | Scans user directories, final installations from `model_installations`, profiles, and active runs |
| `scan_model_artifacts_command({ roots, consumers })` | Pure scan of supplied paths and consumers |
| `preview_model_artifact_removal({ roots, consumers, artifactId })` | Fresh read-only scan with `previewOnly=true` and protection reasons |

Profile, recovery, and active-run consumers protect referenced files from future maintenance flows. Artifact IDs derive from path grouping, name, and kind; they are not content fingerprints. A catalogue snapshot can become stale when files change and should be rescanned.

## GGUF, shards, and projectors

llama.cpp and Strata use GGUF. The library groups files named like `name-00001-of-00003.gguf` into a set and flags missing shards. An `mmproj` projector is stored separately. One GGUF copy can serve both engines when compatibility is verified for the particular build and model. Basalt uses its own `.basalt` packs with a bundled tokenizer and, for vision models, a projector.

The scanner does not guarantee runtime architecture compatibility or successful memory allocation. Missing metadata remains unknown, and profile paths are not rewritten automatically.

## Hugging Face downloads

The downloader supports public Hugging Face GGUF repositories and stores the selected commit SHA. Variant selection contains a full quantization and all its parts; incomplete split sets are not published. `mmproj` is selected explicitly. See the [download contract](model-downloads.md) for resolve/prepare/start and task fields.

History is stored in `model_downloads` and `model_download_files`; installed sets are in `model_installations`, including `installed_path` and the full manifest. These records survive replacement of the artifact index. The final directory is registered only after validation and atomic publication.

## Staging and integrity

Transfer streams `.part` files to `<destination>/.aplot-staging/<downloadId>`. This directory is excluded from model and runnable-file scans, so incomplete GGUF files do not appear in the library. Only a complete new directory is published; existing model files are never overwritten.

The downloader checks size and LFS SHA-256 when Hub provides the file's SHA-256. Xet identifiers and arbitrary ETags are not treated as SHA-256. Without a trusted digest, verification is marked as limited. Downloaded files remain data; repository code is not executed.

## Maintenance preview and limits

Removal preview protects files used by profiles, runs, and registered downloads. The catalogue does not remove files; there is no model-delete command. Removing partial downloads is confined to that task's staging directory and does not touch existing files.

Downloading does not create a profile automatically. For Strata, having a GGUF does not mean the model is ready: compatibility, a prepared `strata-*.json`, tokenizer, and required companion files are separate requirements. See [engine adapters](engine-adapters.md) and the [downloader](model-downloads.md).
