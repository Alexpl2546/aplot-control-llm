"""Run with the installed Hermes Python: python -m unittest discover -s app/tests -p hermes_bridge_test.py."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes/hermes-agent"
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("aplot_hermes", Path(__file__).parents[1] / "src-tauri/src/hermes_bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


@unittest.skipUnless((ROOT / "hermes_cli").is_dir(), "requires an installed Hermes runtime")
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aplot-hermes-")
        self.home = Path(self.temp.name)
        self.old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.home)
        self.config = self.home / "config.yaml"
        self.config.write_text("# keep comment\nmodel:\n  default: original-model\n  provider: openrouter\ncustom_providers:\n  - name: existing\n    base_url: http://127.0.0.1:9999/v1\n    api_key: fixture-existing\n", encoding="utf-8")
        self.target = {"modelId": "Local model", "baseUrl": "http://127.0.0.1:8080/v1", "contextTokens": 32768, "apiKey": "fixture-key"}

    def tearDown(self):
        if self.old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.old_home
        self.temp.cleanup()

    def test_preserves_defaults_and_comments_and_resolves_exact_credentials(self):
        import yaml
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from hermes_state import SessionDB
        result = bridge.prepare(self.home, self.target)
        config = yaml.safe_load(self.config.read_text("utf-8"))
        self.assertEqual(config["model"], {"default": "original-model", "provider": "openrouter"})
        self.assertEqual(config["custom_providers"][0]["api_key"], "fixture-existing")
        self.assertIn("# keep comment", self.config.read_text("utf-8"))
        resolved = resolve_runtime_provider(requested=result["provider"], target_model=self.target["modelId"])
        self.assertEqual(resolved["base_url"], self.target["baseUrl"])
        self.assertEqual(resolved["api_key"], "fixture-key")
        db = SessionDB(self.home / "state.db")
        try:
            row = db.get_session(result["sessionId"])
            config = json.loads(row["model_config"]) if isinstance(row["model_config"], str) else row["model_config"]
            self.assertEqual(config["provider"], result["provider"])
            self.assertNotIn("api_key", config)
        finally:
            db.close()

    def test_reuses_owned_provider_and_creates_separate_conversations(self):
        import yaml
        first = bridge.prepare(self.home, self.target)
        second = bridge.prepare(self.home, self.target)
        self.assertEqual(first["provider"], second["provider"])
        self.assertNotEqual(first["sessionId"], second["sessionId"])
        self.assertEqual(len(yaml.safe_load(self.config.read_text("utf-8"))["custom_providers"]), 2)

    def test_refuses_unowned_collision(self):
        bridge.prepare(self.home, self.target)
        (self.home / "aplot-connections.json").write_text('{"providers":[]}', encoding="utf-8")
        before = self.config.read_bytes()
        with self.assertRaisesRegex(ValueError, "provider-conflict"):
            bridge.prepare(self.home, self.target)
        self.assertEqual(self.config.read_bytes(), before)

    def test_refuses_malformed_config_without_overwriting_it(self):
        self.config.write_text("[broken yaml", encoding="utf-8")
        before = self.config.read_bytes()
        with self.assertRaises(Exception):
            bridge.prepare(self.home, self.target)
        self.assertEqual(self.config.read_bytes(), before)
