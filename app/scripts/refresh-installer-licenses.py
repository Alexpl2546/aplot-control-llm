"""Refresh reviewed installer license texts from pinned upstream sources. Not run by builds."""
import io
import json
import pathlib
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri/installer/licenses.json"
rows = []

def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()

def add(key, title, url, text):
    rows.append(dict(id=key, title=title, source=url, text=text.strip()))

add("apache", "Apache License 2.0", "https://www.apache.org/licenses/LICENSE-2.0", (ROOT.parent / "LICENSE").read_text(encoding="utf-8"))
for key, title, repo, ref in [
    ("llama", "llama.cpp — MIT", "ggml-org/llama.cpp", "b11723"),
    ("strata", "Strata — MIT", "Niko1221/Strata", "7ddc17a38fe7f31637e895ecfba58c2cd43d65ec"),
    ("ollama", "Ollama — MIT", "ollama/ollama", "v0.40.6"),
    ("hermes", "Hermes — MIT", "NousResearch/hermes-agent", "d923a5eb487a17c0a68801bba9ef0f56c81040a8"),
    ("python", "Python — PSF и включённые лицензии", "python/cpython", "v3.14.0"),
    ("uv", "uv — MIT", "astral-sh/uv", "0.12.3"),
]:
    filename = "LICENSE-MIT" if key == "uv" else "LICENSE"
    url = f"https://raw.githubusercontent.com/{repo}/{ref}/{filename}"
    add(key, title, url, fetch(url).decode("utf-8"))

url = "https://visualstudio.microsoft.com/wp-content/uploads/2025/10/Visual-C-V14-License-Redistributable_and_Runtime_ENU.docx"
document = ET.fromstring(zipfile.ZipFile(io.BytesIO(fetch(url))).read("word/document.xml"))
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
text = "\n\n".join("".join(p.itertext()) for p in document.findall(".//w:p", ns))
add("msvc", "Microsoft Visual C++ — условия Microsoft", "https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/", text)

fixture = ROOT / "artifacts/components-acceptance"
cuda = fixture / "strata/0.1.45/.venv/Lib/site-packages/nvidia_cublas-13.0.2.14.dist-info/licenses/License.txt"
add("cuda", "NVIDIA CUDA — лицензионное соглашение", "https://docs.nvidia.com/cuda/eula/", cuda.read_text(encoding="utf-8"))
llvm = fixture / "llama_cpp/b11723/LICENSE-LLVM-OpenMP"
add("llvm", "LLVM OpenMP — Apache 2.0 с исключениями LLVM", "https://github.com/llvm/llvm-project/blob/main/openmp/LICENSE.TXT", llvm.read_text(encoding="utf-8"))
for key, folder, title, source in [
    ("infernix-notices", fixture / "infernix/windows-2026.10.18/infernix-2026.10.18-windows-x64/licenses", "Библиотеки Infernix — LGPL, MIT, BSD и другие", "https://github.com/Wallawalla47/Infernix/blob/windows-2026.10.18/packaging/windows/THIRD_PARTY_NOTICES.md"),
    ("ollama-notices", fixture / "ollama/0.40.6/lib/ollama", "Библиотеки Ollama — отдельные лицензии", "https://github.com/ollama/ollama/tree/v0.40.6"),
]:
    files = sorted(p for p in folder.rglob("*") if p.is_file() and ("LICENSE" in p.name.upper() or "NOTICE" in p.name.upper()))
    if not files:
        raise RuntimeError(f"No license files in {folder}")
    text = "\n\n".join(p.name + "\n\n" + p.read_text(encoding="utf-8", errors="replace") for p in files)
    add(key, title, source, text)

for key, folder, title, source in [
    ("hermes-python-notices", fixture / "hermes/0.22.2/.venv/Lib/site-packages", "Python-пакеты Hermes — отдельные лицензии", "https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/uv.lock"),
    ("strata-python-notices", ROOT.parent / "components/strata/0.1.48/.venv/Lib/site-packages", "Python-пакеты Strata — отдельные лицензии", "https://github.com/Niko1221/Strata/blob/7ddc17a38fe7f31637e895ecfba58c2cd43d65ec/requirements.txt"),
]:
    files = sorted(p for dist in folder.glob("*.dist-info") for p in dist.rglob("*") if p.is_file() and any(term in p.name.upper() for term in ("LICENSE", "LICENCE", "COPYING", "NOTICE")))
    if not files:
        raise RuntimeError(f"No Python license files in {folder}")
    text = "\n\n".join(str(p.relative_to(folder)) + "\n\n" + p.read_text(encoding="utf-8", errors="replace") for p in files)
    add(key, title, source, text)
# Reviewed notices from the pinned official Codex Windows archive. Preserve them
# when refreshing unrelated engine licenses without re-downloading Codex.
previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"licenses": []}
rows.extend(row for row in previous["licenses"] if row["id"] in {"codex-bundled", "claude", "git"})
OUT.write_text(json.dumps(dict(schemaVersion=1, licenses=rows), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Saved {len(rows)} license documents: {OUT}")
