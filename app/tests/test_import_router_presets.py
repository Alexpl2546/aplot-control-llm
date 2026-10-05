import tempfile
import unittest
from pathlib import Path

from scripts.import_router_presets import build_profile, parse_presets


class RouterPresetImportTests(unittest.TestCase):
    def test_parses_global_and_model_sections(self):
        global_values, profiles = parse_presets(
            "version = 1\n[*]\nnp=1\nfa=on\n[model-ctx]\nc=65536\nmodel=C:\\\\Models\\\\model.gguf\n"
        )

        self.assertEqual(global_values, {"np": "1", "fa": "on"})
        self.assertEqual(profiles, [("model-ctx", {"c": "65536", "model": "C:\\\\Models\\\\model.gguf"})])

    def test_maps_known_fields_and_keeps_unregistered_flags(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model = root / "model.gguf"
            draft = root / "draft model.gguf"
            model.write_bytes(b"main")
            draft.write_bytes(b"draft")
            config = build_profile(
                "model-ctx",
                {"np": "1", "fa": "on", "t": "8", "tb": "8", "offline": "true"},
                {
                    "model": str(model),
                    "model-draft": str(draft),
                    "c": "65536",
                    "ctk": "q8_0",
                    "ctv": "q8_0",
                    "ngl": "all",
                    "fit": "off",
                    "no-mmproj": "true",
                    "mmproj-offload": "off",
                    "spec-type": "draft-mtp",
                    "spec-draft-n-max": "2",
                },
                "C:\\llama-server.exe",
                "127.0.0.1",
                50071,
                root / "presets.ini",
            )

        self.assertEqual(config["ctxSize"], 65536)
        self.assertEqual(config["cacheTypeK"], "q8_0")
        self.assertEqual(config["gpuLayers"], "all")
        self.assertEqual(config["parallel"], 1)
        self.assertEqual(config["threads"], 8)
        self.assertFalse(config["fit"])
        self.assertIn("--offline", config["extraArgs"])
        self.assertIn("--no-mmproj", config["extraArgs"])
        self.assertIn("--mmproj-offload off", config["extraArgs"])
        self.assertIn('--model-draft "', config["extraArgs"])
        self.assertIn("--spec-type draft-mtp", config["extraArgs"])


if __name__ == "__main__":
    unittest.main()
