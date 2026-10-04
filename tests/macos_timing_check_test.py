import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("macos_check", ROOT / "scripts/check-macos-timing.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class MacTimingCheckTests(unittest.TestCase):
    def test_clean_metadata(self):
        self.assertEqual(CHECK.dependency_errors(0, "No broken requirements found.\n"), [])

    def test_only_exact_known_mismatches(self):
        self.assertEqual(CHECK.dependency_errors(1, "\n".join(CHECK.ALLOWED_METADATA_ERRORS)), [])

    def test_wrong_versions_and_unrelated_errors_fail(self):
        for output in [
            "kfa 0.2.0 has requirement sosap==0.0.1, but you have sosap 0.4.4.",
            "khmercut 0.0.2 has requirement python-crfsuite==0.9.9, but you have python-crfsuite 0.9.12.",
            "unrelated package failure",
        ]:
            self.assertTrue(CHECK.dependency_errors(1, output))

    def test_crashed_or_silent_pip_is_not_success(self):
        for code, output in [(1, ""), (2, ""), (0, ""), (2, next(iter(CHECK.ALLOWED_METADATA_ERRORS)))]:
            self.assertTrue(CHECK.dependency_errors(code, output))

    def test_mixed_known_and_unknown_metadata_fails(self):
        output = "\n".join(CHECK.ALLOWED_METADATA_ERRORS) + "\nOther dependency is missing."
        self.assertEqual(CHECK.dependency_errors(1, output), ["Other dependency is missing."])

    def test_python_guard_agrees_with_shell_minor_version_floor(self):
        for version in ("11.7.10", "12.0", "12.2.1"):
            with patch.object(CHECK.sys, "argv", ["check-macos-timing.py"]), \
                 patch.object(CHECK.sys, "platform", "darwin"), \
                 patch.object(CHECK.sys, "version_info", (3, 12, 0)), \
                 patch.object(CHECK.platform, "machine", return_value="arm64"), \
                 patch.object(CHECK.platform, "mac_ver", return_value=(version, (), "arm64")):
                with self.assertRaisesRegex(RuntimeError, "12.3"):
                    CHECK.main()

    def test_legacy_profile_is_checked_even_when_packages_are_present(self):
        import json
        manifest = json.loads((ROOT / "local-timing/locks/versions.json").read_text())
        legacy = {**manifest["tooling"], **manifest["profiles"]["macos-legacy-py312-arm64"]}
        modern = {**manifest["tooling"], **manifest["profiles"]["macos-modern-py312-arm64"]}
        CHECK.check_versions(ROOT, 12, legacy.__getitem__)
        CHECK.check_versions(ROOT, 13, legacy.__getitem__)
        CHECK.check_versions(ROOT, 14, modern.__getitem__)
        with self.assertRaises(RuntimeError):
            CHECK.check_versions(ROOT, 14, legacy.__getitem__)
        for name in ("onnxruntime", "requests", "tokenizers", "pip"):
            drifted = {**legacy, name: "0.0.0"}
            with self.assertRaisesRegex(RuntimeError, name):
                CHECK.check_versions(ROOT, 12, drifted.__getitem__)



if __name__ == "__main__":
    unittest.main()
