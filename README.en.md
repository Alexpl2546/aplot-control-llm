# Aplot Control LLM

[Русский](README.md) · **English**

Aplot Control LLM is a Windows desktop app for running local language models and managing their settings. It brings model folders, saved launch profiles, hardware charts and server logs into one window.

It supports **llama.cpp, Strata, Ollama and QwFNfer**. The selected engine runs inference; Aplot manages its process, configuration and monitoring. Install engines and model weights separately.

## What you can do

- **Start and stop a server**, check its status and see its endpoint.
- **Build a model library** from multiple folders, discover GGUF files, filter by engine and save favorites. Ollama also supports registry downloads and compatible GGUF imports.
- **Save launch profiles** with a model, context size, memory settings and other parameters. Duplicate profiles or import and export them as JSON.
- **Monitor hardware and inference:** CPU, RAM, NVIDIA GPU, generation and prompt-processing speed, time to first token and context usage. Available metrics depend on the engine.
- **Arrange the dashboard:** move and resize cards, choose charts and save your layout.
- **Compare configurations with benchmarks.** For llama.cpp, the app can search for profiles with larger context, higher throughput or a balance of both.
- **Connect API clients** to the local server. In llama.cpp router mode, a saved profile name selects the model for an API request.

The interface is available in English and Russian, with light and dark themes, tray controls and startup preferences.

## Supported engines

| Engine | Aplot integration | What to install |
| --- | --- | --- |
| **llama.cpp**[^llama] | GGUF library, detailed launch settings, profiles, metrics, benchmarks and native model routing | A build with `llama-server.exe` for your GPU or CPU. Routing requires `--models-preset`, `--models-max` and model autoload support |
| **Strata**[^strata] | Prepared `strata-*.json` configurations, server lifecycle, monitoring and context tests | A working Strata installation with its Python environment, tokenizer, engine and model |
| **Ollama**[^ollama] | Shared library, model downloads, GGUF import, lifecycle controls and throughput tests | Ollama and a local model supported by your Ollama version |
| **QwFNfer**[^qwfnfer] | `qwfn-server.exe` lifecycle, RAM/VRAM, KV cache, I/O and MTP settings, statistics and benchmarks | A compatible Windows build and a model with the `qwen4exp` architecture |

A GGUF may work with more than one engine, but compatibility varies. Image projectors and secondary model shards cannot be launched as standalone models; Aplot checks these cases before starting a server.

Automatic parameter tuning supports llama.cpp only. Exact context tests require a server-side token-counting API. The additions used with our Strata installation are included as a [separate patch](integrations/strata/README.md).

## Getting started

### Download the app

Download an installer or executable from [GitHub Releases](https://github.com/Alexpl2546/aplot-control-llm/releases). If a binary release is not yet available, follow [the source build instructions](#building-from-source).

1. Install an engine using the instructions in its repository, linked in the table and footnotes.
2. Download a compatible model. For Strata, complete its setup first so it creates the `strata-*.json` configurations.
3. Open Aplot. The first-run wizard lets you select `llama-server.exe` and model folders. Configure the other engines in **Settings**.
4. Select a model or prepared configuration, set your launch parameters and start the server.
5. Wait until the server is ready. Its address appears on the dashboard and can be used in an API client.

Node.js and Rust are only needed to build Aplot. The installer does not include models, engine DLLs or engine dependencies.

### Requirements

The verified desktop platform is **Windows 11 x64** with WebView2 Runtime. Desktop support on other operating systems has not been confirmed.

RAM, VRAM and CUDA requirements depend on the model and engine build. NVIDIA telemetry requires `nvidia-smi`, normally provided by the NVIDIA driver. Memory estimates in the interface are advisory; the engine determines actual allocation.

### Connect an API client

For a client that supports the OpenAI API, use the running server address followed by `/v1`, such as `http://127.0.0.1:8080/v1`, and a model name from `/v1/models`. Check the port in Aplot; it may differ from this example. Ollama commonly uses `http://127.0.0.1:11434/v1`.

In llama.cpp router mode, use the Aplot profile name as the model name. Supply the configured API key if authentication is enabled. Supported methods, image input and tool calls depend on the model and engine version; the in-app API reference helps identify available features.

## Building from source

Install Git, **Node.js 22.12+**, npm, stable Rust with the MSVC toolchain, Visual Studio Build Tools with **Desktop development with C++**, Windows SDK and WebView2. See the [Windows build guide](app/docs/WINDOWS_BUILD.md).

```powershell
git clone https://github.com/Alexpl2546/aplot-control-llm.git
cd aplot-control-llm/app
npm ci
npm run tauri:dev
```

`npm ci` installs the versions recorded in `package-lock.json`. The first Cargo build downloads Rust dependencies and may take several minutes. Inference engines are not needed to compile Aplot.

To build the app and installers:

```powershell
npm run tauri:build
```

The executable is written to `app/src-tauri/target/release/`; installers are placed in `app/src-tauri/target/release/bundle/`.

`npm run dev` opens the browser interface with demo data. Actual process management and models require `tauri:dev` or the compiled desktop app.

### Checks before committing

From the `app` directory:

```powershell
npm run build
npm test
npm run verify:source
python -m unittest discover -s tests -p "test_*.py"
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Python is only needed to test the profile importer. GitHub Actions checks the frontend and Windows build on pushes and pull requests. Real model inference, drivers and tray behavior also need manual verification.

## Your data

Settings, profiles and benchmark results are stored in SQLite. If the executable is inside a directory tree containing both `engines` and `models`, the app uses `data/llama-control.sqlite3` there. Otherwise it stores data under `%APPDATA%\app.aplot.llamacontrol`.

The app creates a database backup at startup. JSON profile export is useful for moving between PCs; check model paths on the new machine. Databases and exported profiles may contain API keys, so remove them before sharing a bug report.

Engines and models can live outside the project directory. Model weights, engine installations, data, local verification output, builds and backups are excluded from Git. Both `package-lock.json` and `Cargo.lock` are tracked for reproducible builds.

## Documentation and contributions

- [Architecture](app/docs/ARCHITECTURE.md), [source map](app/docs/CODE_MAP.md), [data model](app/docs/DATA_MODEL.md).
- [Tauri IPC](app/docs/IPC_CONTRACT.md), [llama.cpp parameters](app/docs/LLAMA_CPP_MAPPING.md), [benchmarks](app/BENCHMARKING.md).
- [Engine setup](docs/ENGINES.md), [version 0.8.2 changes](CHANGELOG.md).
- [Contributing](CONTRIBUTING.md), [reporting a vulnerability](SECURITY.md).

To report a problem, open an [issue](https://github.com/Alexpl2546/aplot-control-llm/issues) with your Aplot version, engine name and version, reproduction steps and a sanitized log excerpt. For generation problems, also try the same request directly against the engine.

## License and credits

Aplot Control LLM source is available under the [Apache License 2.0](LICENSE). Engines, models and graphic assets have their own terms. Engine links and icon attribution are collected in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Thanks to the authors of llama.cpp, Strata, Ollama and QwFNfer, whose projects run the inference. Aplot is built with React, Tauri and the libraries listed in the npm and Cargo manifests.

[^llama]: [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp), MIT. [Prebuilt releases](https://github.com/ggml-org/llama.cpp/releases).
[^strata]: [Niko1221/Strata](https://github.com/Niko1221/Strata), MIT. Local Aplot additions are kept in `integrations/strata`.
[^ollama]: [ollama/ollama](https://github.com/ollama/ollama), MIT. [Windows installation](https://docs.ollama.com/windows).
[^qwfnfer]: [Apolog1ze-Dev/QwFNfer](https://github.com/Apolog1ze-Dev/QwFNfer), Apache 2.0. This integration used the [cakescats/QwFNfer-Secure-Multilang](https://github.com/cakescats/QwFNfer-Secure-Multilang) fork, also Apache 2.0.
