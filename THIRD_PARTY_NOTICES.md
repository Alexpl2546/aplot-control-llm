# Third-party notices

Aplot Control LLM is licensed under Apache-2.0. This does not change the licenses of its dependencies, engines, model weights or brand marks.

## Inference engines

These engines run as separate processes. Their installations and weights are not included in this source repository.

| Project | Source | License |
| --- | --- | --- |
| llama.cpp / ggml | https://github.com/ggml-org/llama.cpp | MIT |
| Strata | https://github.com/Niko1221/Strata | MIT |
| Ollama | https://github.com/ollama/ollama | MIT |
| QwFNfer | https://github.com/Apolog1ze-Dev/QwFNfer | Apache-2.0 |
| QwFNfer Secure Multilang fork used for integration | https://github.com/cakescats/QwFNfer-Secure-Multilang | Apache-2.0 |

The Strata integration patch includes upstream code context. The original MIT notice is preserved in [integrations/strata/LICENSE](integrations/strata/LICENSE). See [the patch guide](integrations/strata/README.md) for the base revision and changes.

The QwFNfer token-counting patch retains its upstream Apache-2.0 license in [integrations/qwfnfer/LICENSE](integrations/qwfnfer/LICENSE). Its modified file and base revision are documented in [the patch guide](integrations/qwfnfer/README.md).

## Icons and publisher marks

Google, Qwen and OpenAI SVG assets in `app/public/creators` are from [LobeHub Icons](https://github.com/lobehub/lobe-icons), Copyright (c) 2023 LobeHub. Their MIT license is preserved in [LICENSE-lobe-icons](app/public/creators/LICENSE-lobe-icons).

The neutral P and O symbols used for PrismML and Ornith AI entries are original Aplot graphics under Apache-2.0, not publisher logos. The earlier publisher avatars were removed before binary publication. Brand marks remain the property of their owners. Details: [asset attribution](app/public/creators/ATTRIBUTION.md).

## Application dependencies

The npm and Cargo manifests and lockfiles record direct and transitive dependencies. Notable projects include [React](https://github.com/facebook/react), [Tauri](https://github.com/tauri-apps/tauri), [Vite](https://github.com/vitejs/vite), [Zustand](https://github.com/pmndrs/zustand), [i18next](https://github.com/i18next/i18next), [Recharts](https://github.com/recharts/recharts) and [Lucide](https://github.com/lucide-icons/lucide).

Their licenses apply independently. When redistributing a build, retain applicable dependency notices and review any added engine binaries, CUDA libraries and model licenses separately.

Release builds generate a `legal` directory containing the applicable license texts, notices, dependency inventory and unmodified MPL dependency source archives. It is included in Windows installers and the portable ZIP. See [the license review](docs/LICENSING.md) for scope and reproducible generation. A manifest or upstream link does not replace required license texts in a distributed binary package.
