import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('aplot_patch', Path(__file__).parents[1] / 'src-tauri/installer/apply_strata_patch.py')
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class InstallerPatchTest(unittest.TestCase):
    def test_append_at_eof_is_applied_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'README.md'
            patch = root / 'append.patch'
            file.write_text('first\nlast\n', encoding='utf-8')
            patch.write_text('--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n first\n last\n+added\n', encoding='utf-8')
            PATCH.apply(root, patch)
            first = file.read_bytes()
            PATCH.apply(root, patch)
            self.assertEqual(file.read_bytes(), first)
            self.assertEqual(file.read_text(), 'first\nlast\nadded\n')

    def test_delete_at_eof_is_applied_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'README.md'
            patch = root / 'delete.patch'
            file.write_text('first\nremoved\n', encoding='utf-8')
            patch.write_text('--- a/README.md\n+++ b/README.md\n@@ -1,2 +1 @@\n first\n-removed\n', encoding='utf-8')
            PATCH.apply(root, patch)
            self.assertEqual(file.read_text(), 'first\n')
            first = file.read_bytes()
            PATCH.apply(root, patch)
            self.assertEqual(file.read_bytes(), first)

    def test_patch_is_idempotent_and_rejects_unknown_sources(self):
        diff = '--- a/server.py\n+++ b/server.py\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'server.py'
            patch = root / 'change.patch'
            patch.write_text(diff, encoding='utf-8')
            file.write_text('first\nold\nlast\n', encoding='utf-8')
            PATCH.apply(root, patch)
            self.assertEqual(file.read_text(), 'first\nnew\nlast\n')
            PATCH.apply(root, patch)
            self.assertEqual(file.read_text(), 'first\nnew\nlast\n')
            file.write_text('unrecognized\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                PATCH.apply(root, patch)
            self.assertEqual(file.read_text(), 'unrecognized\n')

    def test_patch_cannot_target_files_outside_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'
            root.mkdir()
            external = Path(temporary) / 'external.txt'
            external.write_text('old\n')
            patch = root / 'change.patch'
            patch.write_text('--- a/../external.txt\n+++ b/../external.txt\n@@ -1 +1 @@\n-old\n+new\n')
            with self.assertRaises(ValueError):
                PATCH.apply(root, patch)
            self.assertEqual(external.read_text(), 'old\n')


if __name__ == '__main__':
    unittest.main()
