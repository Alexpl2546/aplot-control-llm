"""Run installed Strata setup, keeping existing model folders in place.

All model acquisition and validation remains in Strata's setup.py. Only its
automatic data-folder migration is replaced: an Aplot download must not move
other installations or rewrite their configurations.
"""
import importlib.util
import subprocess
import sys
from pathlib import Path


def engine_path(value):
    # Rust canonicalize() supplies verbatim Windows paths. The native engine
    # appends /index.txt to --pack, which Windows rejects under that prefix.
    if not isinstance(value, str):
        return value
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    if value.startswith("\\\\?\\") and len(value) >= 7 and value[5:7] == ":\\":
        return value[4:]
    return value


def engine_config_paths(config):
    config = dict(config)
    for key in ("exe", "cwd", "tokenizer", "log", "draft_vocab"):
        if key in config:
            config[key] = engine_path(config[key])
    for key in ("args", "args_written", "lib_dirs"):
        if isinstance(config.get(key), list):
            config[key] = [engine_path(value) for value in config[key]]
    if isinstance(config.get("vision"), dict):
        config["vision"] = dict(config["vision"])
        for key in ("exe", "model", "mmproj"):
            if key in config["vision"]:
                config["vision"][key] = engine_path(config["vision"][key])
    return config


def data_folder_in_place(setup, requested, move=False, yes=True, set_default=False):
    if not requested or move:
        raise ValueError("Aplot model setup requires an explicit destination without data migration")
    destination = Path(requested).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    settings = setup.load_settings()
    remembered = Path(settings["data_dir"]) if settings.get("data_dir") else setup.ROOT.parent.parent / "models" / "strata"
    sources = [setup.home(), *setup.other_installs(settings), remembered]
    sources += [folder / "Strata-data" for folder in list(sources)]
    held = []
    for folder in sources:
        if (not setup.same_folder(folder, destination) and setup.has_data(folder)
                and not any(setup.same_folder(folder, seen) for seen in held)):
            held.append(folder)
    return destination, held


def ensure_setup_pip(arguments):
    # Managed uv environments contain runtime packages but may omit pip. Native
    # Strata setup invokes pip even when those packages are already installed.
    if "--setup" in arguments and "--help" not in arguments and "-h" not in arguments:
        if importlib.util.find_spec("pip") is None:
            subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], check=True)


def run(root, arguments):
    ensure_setup_pip(arguments)
    root = Path(root).resolve()
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("aplot_strata_setup", root / "setup.py")
    setup = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = setup
    spec.loader.exec_module(setup)
    setup.data_folder = lambda requested, move=False, yes=True, set_default=False: data_folder_in_place(
        setup, requested, move, yes, set_default)
    write_config = setup.write_config
    setup.write_config = lambda path, config: write_config(path, engine_config_paths(config))
    sys.argv = [str(root / "setup.py"), *arguments]
    return setup.main()


if __name__ == "__main__":
    raise SystemExit(run(Path.cwd(), sys.argv[1:]))
