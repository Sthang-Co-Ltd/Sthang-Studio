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
        # pip is part of the documented Python setup; use its vendored parser so
        # these tests do not require installing the timing stack or any models.
        from pip._vendor import packaging
        from pip._vendor.packaging import requirements
        versions = {
            "sosap": "0.4.3", "python-crfsuite": "0.9.11", "khmernormalizer": "0.0.4",
            "chardet": "5.2.0", "tqdm": "4.65.0", "requests": "2.32.5", "appdirs": "1.4.4",
            "kfa": "0.2.0", "khmercut": "0.0.2",
        }
        for line in (ROOT / "local-timing/constraints-macos-legacy.txt").read_text().splitlines():
            if line and not line.startswith("#"):
                name, value = line.split("==")
                versions[name] = value
        with patch.dict("sys.modules", {"packaging": packaging, "packaging.requirements": requirements}):
            CHECK.check_versions(ROOT, 12, versions.__getitem__)
            CHECK.check_versions(ROOT, 13, versions.__getitem__)
            with self.assertRaisesRegex(RuntimeError, "onnxruntime"):
                CHECK.check_versions(ROOT, 14, versions.__getitem__)
            versions["onnxruntime"] = "1.20.1"
            with self.assertRaisesRegex(RuntimeError, "onnxruntime"):
                CHECK.check_versions(ROOT, 12, versions.__getitem__)
            # The same dependency is allowed on Sonoma: no blanket Mac downgrade.
            CHECK.check_versions(ROOT, 14, versions.__getitem__)


if __name__ == "__main__":
    unittest.main()
