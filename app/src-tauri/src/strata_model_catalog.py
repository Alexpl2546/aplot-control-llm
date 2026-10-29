"""Read the same installed setup tables as Strata's desktop model library.

This helper only imports the installer and calls its catalog API. It never calls
an install, launch or configuration-writing method. Stdout contains one JSON
value; any diagnostics from the installed source are kept on stderr.
"""
import contextlib
import importlib.util
import json
import sys
from pathlib import Path


def legacy_id(family, model, tag):
    return {
        ("coder", "IQ1_M"): "strata-coder",
        ("qwen", "IQ2_XS"): "strata-qwen-iq2",
        ("qwen", "IQ3_S"): "strata-qwen-iq3",
    }.get((family, model), "strata-" + tag)


def repository(url):
    if isinstance(url, str) and "huggingface.co/" in url:
        parts = url.split("huggingface.co/", 1)[1].split("/")
        if len(parts) >= 2:
            return "/".join(parts[:2])
    return None


def fit_status(message):
    """Normalize Strata's per-machine verdict for the UI without replacing its explanation."""
    value = str(message or "").strip().lower()
    if not value:
        return "unknown"
    if value.startswith("does not fit"):
        return "over_budget"
    if value.startswith("tight"):
        return "tight"
    if "read from the ssd" in value or value.startswith("slow here"):
        return "spills"
    if "fits in the low-ram mode" in value:
        return "low_ram"
    if value.startswith("fits") or value.startswith("experimental: fits"):
        return "fits"
    return "unknown"


def catalog(root, include_hardware=True):
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("aplot_strata_mcp", root / "tools" / "strata_mcp.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    strata = module.Strata(root, root)
    setup = strata.setup_module()
    if setup is None:
        raise RuntimeError("Strata's setup.py could not be imported; update or repair the Strata component")
    models, families, _contexts, source = strata.tables()
    if source != "setup.py":
        raise RuntimeError("The installed Strata component did not provide its setup catalog")
    hardware = strata.hardware() if include_hardware else None
    recommendation = {}
    if hardware:
        try:
            candidate = strata.recommend(hardware)
            if isinstance(candidate, dict):
                recommendation = candidate
        except Exception:  # noqa: BLE001 - a recommendation must not hide the model catalog
            pass
    own = getattr(setup, "OWN_PATH_FAMILIES", {})
    multi = getattr(setup, "MULTI_FILE_FAMILIES", {})
    result = []
    for family in strata.model_table(hardware):
        family_id = family["family"]
        details = own.get(family_id) or multi.get(family_id) or setup.FAMILIES[family_id]
        for size in family["sizes"]:
            model = size["model"]
            tag = size["id"]
            md = strata.own_size(family_id, model) or models[model]
            model_details = multi.get(family_id, {}).get("models", {}).get(model, {})
            if family_id in own:
                files = [details["file"].format(q=model)]
            elif family_id in multi:
                files = [*model_details["shards"], *model_details.get("shared", [])]
            elif details.get("ready"):
                files = []  # NVFP4 is a prepared pack or an FP4 checkpoint, not arbitrary GGUF.
            else:
                files = [setup.model_file(details, model, i)
                         for i in range(1, setup.model_shards(details, model) + 1)]
            result.append({
                "id": legacy_id(family_id, model, tag),
                "name": family["title"] + " · " + model,
                "engine": "strata",
                "family": family_id,
                "model": model,
                "configTag": tag,
                "source": md.get("repo") or repository(model_details.get("hf") or details.get("hf")),
                "about": size.get("about") or family.get("about") or "",
                "ramGiB": size["ram_needed_gb"],
                "vramGiB": 6,
                # Upstream download_gb is decimal GB; the UI labels GiB.
                "downloadGiB": round(size["download_gb"] * 10**9 / 2**30, 2),
                "use": "coding" if family_id == "coder" else "chat",
                "images": bool(size.get("images")),
                "experimental": bool(size.get("experimental") or family.get("experimental")),
                "memoryGiB": size.get("memory_gb"),
                "memoryTotal": bool(size.get("mem_total")),
                "fitMessage": size.get("on_this_pc"),
                "fitStatus": fit_status(size.get("on_this_pc")),
                "recommended": family_id == recommendation.get("family") and model == recommendation.get("model"),
                "nvidiaOnly": bool(md.get("nvidia_only")),
                "engineMin": size.get("engine_min"),
                "modelFiles": files,
            })
    return result


if __name__ == "__main__":
    with contextlib.redirect_stdout(sys.stderr):
        rows = catalog(Path(sys.argv[1]).resolve(), "--without-hardware" not in sys.argv[2:])
    print(json.dumps(rows, ensure_ascii=True, separators=(",", ":")))
