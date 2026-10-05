#!/usr/bin/env python3
"""Import llama-api-router INI presets into Aplot Control LLM's SQLite profile store."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROUTER_ONLY_OPTIONS = {"load-on-startup", "stop-timeout"}
FIELD_OPTIONS = {
    "model": "modelPath",
    "alias": "modelAlias",
    "mmproj": "mmprojPath",
    "lora": "loraPaths",
    "c": "ctxSize",
    "ctx-size": "ctxSize",
    "ctk": "cacheTypeK",
    "cache-type-k": "cacheTypeK",
    "ctv": "cacheTypeV",
    "cache-type-v": "cacheTypeV",
    "b": "batchSize",
    "batch-size": "batchSize",
    "ub": "ubatchSize",
    "ubatch-size": "ubatchSize",
    "np": "parallel",
    "parallel": "parallel",
    "ngl": "gpuLayers",
    "gpu-layers": "gpuLayers",
    "n-gpu-layers": "gpuLayers",
    "fa": "flashAttention",
    "flash-attn": "flashAttention",
    "t": "threads",
    "threads": "threads",
    "tb": "threadsBatch",
    "threads-batch": "threadsBatch",
    "fit": "fit",
    "fit-target": "fitTargetMiB",
    "fit-ctx": "fitContextMin",
    "kv-offload": "kvOffload",
    "split-mode": "splitMode",
    "tensor-split": "tensorSplit",
    "main-gpu": "mainGpu",
    "host": "host",
    "port": "port",
    "api-key": "apiKey",
    "cors-origins": "corsOrigins",
    "cors-methods": "corsMethods",
    "cors-headers": "corsHeaders",
    "cors-credentials": "corsCredentials",
    "metrics": "metrics",
    "slots": "slots",
    "props": "props",
    "ui": "webUi",
    "webui": "webUi",
    "no-ui": "webUi",
    "no-webui": "webUi",
    "timeout": "timeoutSeconds",
    "threads-http": "httpThreads",
    "jinja": "jinja",
    "no-jinja": "jinja",
    "reasoning": "reasoning",
    "reasoning-format": "reasoningFormat",
    "temp": "temperature",
    "temperature": "temperature",
    "top-k": "topK",
    "top-p": "topP",
    "min-p": "minP",
    "typical-p": "typicalP",
    "repeat-penalty": "repeatPenalty",
    "repeat-last-n": "repeatLastN",
    "frequency-penalty": "frequencyPenalty",
    "presence-penalty": "presencePenalty",
    "seed": "seed",
}

BASE_CONFIG: dict[str, Any] = {
    "profileId": "",
    "profileName": "",
    "binaryPath": "",
    "modelPath": "",
    "loraPaths": [],
    "gpuLayers": "auto",
    "device": "",
    "flashAttention": "auto",
    "fit": False,
    "fitTargetMiB": 1024,
    "fitContextMin": 4096,
    "kvOffload": True,
    "cacheTypeK": "f16",
    "cacheTypeV": "f16",
    "ctxSize": 4096,
    "batchSize": 512,
    "ubatchSize": 128,
    "parallel": 1,
    "threads": None,
    "threadsBatch": None,
    "continuousBatching": False,
    "splitMode": "none",
    "tensorSplit": "",
    "mainGpu": 0,
    "host": "127.0.0.1",
    "port": 50071,
    "apiKey": "",
    "corsOrigins": "",
    "corsMethods": "",
    "corsHeaders": "",
    "corsCredentials": False,
    "metrics": False,
    "slots": True,
    "props": False,
    "webUi": False,
    "timeoutSeconds": None,
    "httpThreads": None,
    "jinja": False,
    "reasoning": "auto",
    "reasoningFormat": "auto",
    "temperature": 0.8,
    "topK": 40,
    "topP": 0.95,
    "minP": 0.05,
    "typicalP": 1,
    "repeatPenalty": 1.1,
    "repeatLastN": 64,
    "frequencyPenalty": 0,
    "presencePenalty": 0,
    "seed": -1,
    "extraArgs": "",
}


def parse_bool(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Expected a boolean value, received {value!r}")


def parse_presets(text: str) -> tuple[dict[str, str], list[tuple[str, dict[str, str]]]]:
    globals_: dict[str, str] = {}
    entries: list[tuple[str, dict[str, str]]] = []
    current_name: str | None = None
    current_values: dict[str, str] = {}

    def finish_section() -> None:
        if current_name is None:
            return
        if current_name.strip() == "*":
            globals_.update(current_values)
        else:
            entries.append((current_name.strip(), current_values.copy()))

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        match = re.fullmatch(r"\[([^\]]+)\]", line)
        if match:
            finish_section()
            current_name = match.group(1).strip()
            current_values = {}
            continue
        if "=" not in line:
            continue
        if current_name is None:
            if re.match(r"^version\s*=", line, re.IGNORECASE):
                continue
            raise ValueError(f"Setting outside a section on line {line_number}")
        key, value = line.split("=", 1)
        normalized_key = key.strip().casefold()
        if not normalized_key:
            raise ValueError(f"Empty setting name on line {line_number}")
        current_values[normalized_key] = value.strip()

    finish_section()
    names = [name.casefold() for name, _ in entries]
    if len(names) != len(set(names)):
        raise ValueError("Preset section names must be unique")
    return globals_, entries


def _quote_extra(value: str) -> str:
    if any(char.isspace() for char in value) or '"' in value:
        return '"' + value.replace('"', '\\"') + '"'
    return value


def _append_extra(extras: list[str], key: str, value: str) -> None:
    flag = key if key.startswith("-") else f"--{key.replace('_', '-')}"
    normalized = value.strip()
    if key == "mmproj-offload":
        extras.extend((flag, "on" if parse_bool(normalized) else "off"))
    elif normalized.casefold() in {"true", "yes", "on", "1"}:
        extras.append(flag)
    elif normalized.casefold() in {"false", "no", "off", "0"}:
        return
    else:
        extras.extend((flag, _quote_extra(normalized)))


def _map_value(config: dict[str, Any], key: str, value: str, extras: list[str]) -> None:
    if key in ROUTER_ONLY_OPTIONS:
        return
    if key == "no-mmproj":
        if parse_bool(value):
            extras.append("--no-mmproj")
        return
    if key in {"offline", "log-colors", "log-verbosity", "image-max-tokens", "model-draft", "n-cpu-moe"} or key.startswith("spec-"):
        _append_extra(extras, key, value)
        return

    field = FIELD_OPTIONS.get(key)
    if field is None:
        _append_extra(extras, key, value)
        return

    if field in {"modelPath", "modelAlias", "mmprojPath", "device", "tensorSplit", "apiKey", "corsOrigins", "corsMethods", "corsHeaders", "cacheTypeK", "cacheTypeV"}:
        config[field] = value
    elif field == "loraPaths":
        config[field] = [*config[field], value]
    elif field in {"fit", "kvOffload", "corsCredentials", "metrics", "slots", "props", "jinja"}:
        parsed = parse_bool(value)
        config[field] = not parsed if key == "no-jinja" else parsed
    elif field == "flashAttention":
        config[field] = value.casefold()
    elif field == "gpuLayers":
        config[field] = value.casefold() if value.casefold() in {"all", "auto"} else int(value)
    elif field == "webUi":
        parsed = parse_bool(value)
        config[field] = not parsed if key in {"no-ui", "no-webui"} else parsed
    elif field == "reasoning" or field == "reasoningFormat" or field == "splitMode":
        config[field] = value.casefold()
    elif field in {"topP", "minP", "typicalP", "repeatPenalty", "frequencyPenalty", "presencePenalty"}:
        config[field] = float(value)
    elif field in {"temperature"}:
        config[field] = float(value)
    else:
        config[field] = int(value)


def build_profile(
    section: str,
    global_values: dict[str, str],
    values: dict[str, str],
    binary_path: str,
    host: str,
    port: int,
    source_path: Path,
) -> dict[str, Any]:
    config = {**BASE_CONFIG, "profileName": section, "binaryPath": binary_path, "host": host, "port": port}
    extras: list[str] = []
    for key, value in global_values.items():
        _map_value(config, key, value, extras)
    for key, value in values.items():
        _map_value(config, key, value, extras)

    if not config["modelPath"]:
        raise ValueError(f"Preset [{section}] does not define a model path")
    model_path = Path(config["modelPath"])
    if not model_path.is_absolute():
        model_path = source_path.parent / model_path
    config["modelPath"] = str(model_path.resolve())
    if not model_path.is_file():
        raise FileNotFoundError(f"Preset [{section}] model file does not exist: {model_path}")
    config["modelBytes"] = model_path.stat().st_size
    config["profileName"] = section
    config["modelAlias"] = config.get("modelAlias") or section

    for field in ("mmprojPath",):
        auxiliary = config.get(field)
        if auxiliary:
            auxiliary_path = Path(auxiliary)
            if not auxiliary_path.is_absolute():
                auxiliary_path = source_path.parent / auxiliary_path
            config[field] = str(auxiliary_path.resolve())
            if not auxiliary_path.is_file():
                raise FileNotFoundError(f"Preset [{section}] {field} file does not exist: {auxiliary_path}")

    config["extraArgs"] = " ".join(extras)
    return config


def _profile_id(section: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"llama-control-router-preset:{section.casefold()}"))


def _normalized_path(value: Any) -> str:
    return os.path.normcase(os.path.normpath(str(value or "")))


def _deduplicate_paths(paths: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not path:
            continue
        canonical = os.path.normcase(os.path.normpath(path))
        if canonical not in seen:
            seen.add(canonical)
            result.append(path)
    return result


def import_into_database(
    database: Path,
    profiles: list[tuple[str, dict[str, Any]]],
    model_root: str | None,
    binary_path: str,
    backup_path: Path,
) -> tuple[int, int, int]:
    database.parent.mkdir(parents=True, exist_ok=True)
    if database.exists():
        with sqlite3.connect(database) as source, sqlite3.connect(backup_path) as backup:
            source.backup(backup)

    now = datetime.now(timezone.utc).isoformat()
    connection = sqlite3.connect(database, timeout=15)
    try:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good FROM profiles"
        ).fetchall()
        used_ids: set[str] = set()
        inserted = 0
        updated = 0

        for section, config in profiles:
            description = f"Imported from llama-api-presets.ini [{section}]"
            match = None
            for row in existing:
                row_id, row_name, row_description, raw_config, *_ = row
                if row_id in used_ids:
                    continue
                previous = json.loads(raw_config)
                marked_good = bool(row[7])
                exact_source = row_description == description
                same_live_profile = (
                    _normalized_path(previous.get("modelPath")) == _normalized_path(config["modelPath"])
                    and int(previous.get("ctxSize", 0) or 0) == int(config["ctxSize"])
                    and (previous.get("modelAlias") == section or row_name == section)
                )
                if (exact_source or same_live_profile) and not marked_good:
                    match = row
                    break

            if match:
                row_id, _, _, _, created_at, _, last_used_at, _ = match
                profile_id = row_id
                updated += 1
            else:
                profile_id = _profile_id(section)
                created_at = now
                last_used_at = None
                inserted += 1
            used_ids.add(profile_id)
            config["profileId"] = profile_id
            config["profileName"] = section
            connection.execute(
                "INSERT INTO profiles(id,name,description,config_json,created_at,updated_at,last_used_at,last_known_good) "
                "VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET "
                "name=excluded.name,description=excluded.description,config_json=excluded.config_json,updated_at=excluded.updated_at",
                (profile_id, section, description, json.dumps(config, ensure_ascii=False), created_at, now, last_used_at),
            )

        if model_root:
            row = connection.execute("SELECT value_json FROM kv WHERE key='settings'").fetchone()
            settings = json.loads(row[0]) if row else {}
            settings["setupCompleted"] = True
            settings["binaryPath"] = binary_path
            settings["modelDirectories"] = _deduplicate_paths([*settings.get("modelDirectories", []), model_root])
            connection.execute(
                "INSERT INTO kv(key,value_json,updated_at) VALUES('settings',?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                (json.dumps(settings, ensure_ascii=False), now),
            )
        connection.commit()
        total = connection.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]
        return inserted, updated, total
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="llama-api-router preset INI")
    parser.add_argument("--database", required=True, type=Path, help="Aplot Control LLM SQLite database")
    parser.add_argument("--binary", required=True, help="Path to llama-server.exe")
    parser.add_argument("--model-root", help="Model folder to add to app scanning settings")
    parser.add_argument("--host", default="127.0.0.1", help="Local endpoint host for imported profiles")
    parser.add_argument("--port", type=int, default=50071, help="Local endpoint port for imported profiles")
    parser.add_argument("--expected-count", type=int, default=37)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = args.source.resolve()
    global_values, entries = parse_presets(source.read_text(encoding="utf-8-sig"))
    if len(entries) != args.expected_count:
        raise ValueError(f"Expected {args.expected_count} model presets, found {len(entries)}")
    if not Path(args.binary).is_file():
        raise FileNotFoundError(f"llama-server executable does not exist: {args.binary}")
    if not 1 <= args.port <= 65535:
        raise ValueError("Port must be between 1 and 65535")

    profiles = [
        (
            section,
            build_profile(section, global_values, values, args.binary, args.host, args.port, source),
        )
        for section, values in entries
    ]
    unique_models = { _normalized_path(profile["modelPath"]) for _, profile in profiles }
    missing_auxiliary = sorted({
        profile["mmprojPath"]
        for _, profile in profiles
        if profile.get("mmprojPath") and not Path(profile["mmprojPath"]).is_file()
    })
    if missing_auxiliary:
        raise FileNotFoundError(f"Missing auxiliary GGUF files: {len(missing_auxiliary)}")

    if args.dry_run:
        print(f"Presets: {len(profiles)}")
        print(f"Distinct primary GGUF files: {len(unique_models)}")
        print(f"Global settings applied: {len(global_values)}")
        print("Router-only settings omitted from llama-server arguments: " + ", ".join(sorted(ROUTER_ONLY_OPTIONS)))
        print("Database unchanged (dry run).")
        return 0

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = args.database.with_name(f"{args.database.name}.before-router-import-{stamp}.bak")
    inserted, updated, total = import_into_database(
        args.database,
        profiles,
        args.model_root,
        args.binary,
        backup_path,
    )
    print(f"Presets imported: {len(profiles)}")
    print(f"Profiles added: {inserted}; updated in place: {updated}; total profiles: {total}")
    print(f"Distinct primary GGUF files: {len(unique_models)}")
    print(f"Backup: {backup_path}")
    print("Router-only options preserved in their original INI, but omitted from server CLI: " + ", ".join(sorted(ROUTER_ONLY_OPTIONS)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Import failed: {error}", file=sys.stderr)
        raise SystemExit(1)
