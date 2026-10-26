"""Hermes Desktop adapter. Receives credentials through stdin, never argv or stdout."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import uuid


def prepare(home, target):
    import yaml
    from hermes_cli.config import atomic_config_write
    from hermes_state import SessionDB

    home = Path(home)
    config_path = home / "config.yaml"
    original = config_path.read_bytes() if config_path.exists() else b""
    config = yaml.safe_load(original) if original else {}
    if not isinstance(config, dict):
        raise ValueError("invalid-config")
    providers = config.get("custom_providers", [])
    if not isinstance(providers, list):
        raise ValueError("invalid-config")
    manifest_path = home / "aplot-connections.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {"providers": []}
    identity = hashlib.sha256((target["baseUrl"] + "\n" + target["modelId"]).encode()).hexdigest()[:16]
    name = "aplot-" + identity
    previous = next((p for p in providers if isinstance(p, dict) and p.get("name") == name), None)
    if previous is not None and name not in manifest["providers"]:
        raise ValueError("provider-conflict")
    provider = {"name": name, "base_url": target["baseUrl"], "model": target["modelId"],
                "api_mode": "chat_completions", "api_key": target.get("apiKey") or "aplot-local"}
    if target.get("contextTokens", 0) > 0:
        provider["context_length"] = target["contextTokens"]
    if provider != previous:
        if original:
            backups = home / "backups"
            backups.mkdir(exist_ok=True)
            shutil.copy2(config_path, backups / ("config-aplot-" + uuid.uuid4().hex + ".yaml"))
        # Hermes' own round-trip writer preserves comments and refuses unreadable documents.
        if config_path.exists() and config_path.read_bytes() != original:
            raise ValueError("config-changed")
        config["custom_providers"] = [p for p in providers if not isinstance(p, dict) or p.get("name") != name] + [provider]
        atomic_config_write(config_path, config)
    if name not in manifest["providers"]:
        manifest["providers"].append(name)
        temporary = manifest_path.with_suffix(".tmp-" + uuid.uuid4().hex)
        temporary.write_text(json.dumps(manifest), encoding="utf-8")
        os.replace(temporary, manifest_path)

    # Pin only this conversation. No global model/default/provider setting is changed.
    session_id = uuid.uuid4().hex
    db = SessionDB(home / "state.db")
    try:
        db.create_session(session_id, "desktop", model=target["modelId"], profile_name="default",
                          model_config={"model": target["modelId"], "provider": "custom:" + name,
                                        "base_url": target["baseUrl"], "api_mode": "chat_completions"})
        title = ("Aplot · " + target["modelId"])[:160]
        for number in range(1, 1001):
            try:
                db.set_session_title(session_id, title if number == 1 else f"{title} ({number})")
                break
            except ValueError as error:
                if "already in use" not in str(error) or number == 1000:
                    raise
        row = db.get_session(session_id)
        if not row or row.get("model") != target["modelId"]:
            raise ValueError("session-failed")
    finally:
        db.close()
    return {"sessionId": session_id, "provider": "custom:" + name}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(prepare(request["home"], request["target"])))
    except Exception:
        # Upstream exceptions may include configuration values; expose only a fixed error code.
        print(json.dumps({"error": "hermes-configuration-failed"}))
        sys.exit(1)
