"""Storage-boundary tests; no model installation or network requests."""
import importlib.util
import sys
import tempfile
import types
import unittest
from unittest import mock
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src-tauri" / "src" / "strata_model_setup.py"
spec = importlib.util.spec_from_file_location("aplot_setup_wrapper", SOURCE)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class SafeStrataStorageTests(unittest.TestCase):
    def test_native_paths_support_engine_child_file_joins(self):
        pack = "\\\\?\\C:\\Aplot Control LLM\\models\\packs\\iq3_s"
        unc = "\\\\?\\UNC\\server\\models\\iq3_s"
        config = {
            "args": ["--pack", pack, "--max-context", "208896"],
            "args_written": ["--pack", pack],
            "tokenizer": pack + "\\tokenizer",
            "lib_dirs": [unc],
            "vision": {"mmproj": pack + "\\mmproj.gguf", "gpu": False},
            "model_name": "iq3_s",
            "sampling": {"temperature": 0.6},
        }
        normalized = wrapper.engine_config_paths(config)
        self.assertEqual(normalized["args"], ["--pack", pack[4:], "--max-context", "208896"])
        self.assertEqual(normalized["args_written"], ["--pack", pack[4:]])
        self.assertEqual(normalized["tokenizer"], pack[4:] + "\\tokenizer")
        self.assertEqual(normalized["lib_dirs"], ["\\\\server\\models\\iq3_s"])
        self.assertEqual(normalized["vision"], {"mmproj": pack[4:] + "\\mmproj.gguf", "gpu": False})
        self.assertEqual(normalized["sampling"], config["sampling"])
        self.assertEqual(config["args"][1], pack)
        self.assertEqual(config["vision"]["mmproj"], pack + "\\mmproj.gguf")
        for value in ("C:\\Models", "packs/iq3_s", "component:strata-engine", "\\\\?\\Volume{abc}\\"):
            self.assertEqual(wrapper.engine_path(value), value)

    def test_managed_environment_bootstraps_bundled_pip_only_when_missing(self):
        with mock.patch.object(wrapper.importlib.util, "find_spec", return_value=None), mock.patch.object(wrapper.subprocess, "run") as run:
            wrapper.ensure_setup_pip(["--setup", "--yes"])
            run.assert_called_once_with([sys.executable, "-m", "ensurepip", "--upgrade"], check=True)
        with mock.patch.object(wrapper.importlib.util, "find_spec", return_value=object()), mock.patch.object(wrapper.subprocess, "run") as run:
            wrapper.ensure_setup_pip(["--setup", "--yes"])
            run.assert_not_called()

    def test_help_and_read_only_invocations_do_not_bootstrap_packages(self):
        with mock.patch.object(wrapper.subprocess, "run") as run:
            wrapper.ensure_setup_pip(["--setup", "--help"])
            wrapper.ensure_setup_pip(["--help"])
            wrapper.ensure_setup_pip([])
            run.assert_not_called()

    def test_remembered_destination_reuses_existing_data_without_moving_or_repointing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine, old, destination = root / "engine", root / "older", root / "chosen"
            (old / "models").mkdir(parents=True)
            model = old / "models" / "existing.gguf"
            model.write_bytes(b"existing weights")
            config = old / "strata-existing.json"
            config.write_text('{"model":"unchanged"}', encoding="utf-8")
            fake = types.SimpleNamespace(
                ROOT=engine,
                load_settings=lambda: {"data_dir": str(destination)},
                home=lambda: engine,
                other_installs=lambda settings: [old, old],
                same_folder=lambda a, b: a.resolve() == b.resolve(),
                has_data=lambda folder: (folder / "models").is_dir(),
            )
            selected, reuse = wrapper.data_folder_in_place(fake, str(destination))
            self.assertEqual(selected, destination.resolve())
            self.assertEqual(reuse, [old])
            self.assertTrue(destination.is_dir())
            self.assertEqual(model.read_bytes(), b"existing weights")
            self.assertEqual(config.read_text(encoding="utf-8"), '{"model":"unchanged"}')
            self.assertFalse((destination / "models").exists())

    def test_missing_destination_and_migration_are_rejected(self):
        for destination, move in [(None, False), ("somewhere", True)]:
            with self.assertRaises(ValueError):
                wrapper.data_folder_in_place(None, destination, move=move)

    def test_native_main_receives_all_arguments_and_the_storage_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "setup.py").write_text(
                "import sys\n"
                "def data_folder(*args): raise AssertionError('migration must be overridden')\n"
                "def write_config(path, cfg):\n"
                "    assert cfg['args'] == ['--pack', 'C:\\\\Models']\n"
                "def main():\n"
                "    assert sys.argv[1:] == ['--setup', '--yes', '--no-start', '--family', 'qwen36']\n"
                "    assert data_folder.__module__ == 'aplot_setup_wrapper'\n"
                "    write_config(None, {'args': ['--pack', chr(92)*2 + '?' + chr(92) + 'C:\\\\Models']})\n"
                "    return 0\n", encoding="utf-8")
            arguments = ["--setup", "--yes", "--no-start", "--family", "qwen36"]
            previous_argv, previous_path = sys.argv[:], sys.path[:]
            try:
                self.assertEqual(wrapper.run(root, arguments), 0)
            finally:
                sys.argv, sys.path = previous_argv, previous_path
                sys.modules.pop("aplot_strata_setup", None)


if __name__ == "__main__":
    unittest.main()
