import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import ExitStack
import types
import tempfile

spec = importlib.util.spec_from_file_location("windows_timing_check", Path(__file__).resolve().parents[1] / "scripts/check-windows-timing.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WindowsTimingCheck(unittest.TestCase):
    def test_healthy_dependencies(self):
        self.assertEqual(module.dependency_errors(0, "No broken requirements found."), [])

    def test_only_exact_known_metadata_mismatch_allowed(self):
        self.assertEqual(module.dependency_errors(1, module.ALLOWED_METADATA_ERROR), [])
        self.assertTrue(module.dependency_errors(1, module.ALLOWED_METADATA_ERROR + " another error"))
        self.assertTrue(module.dependency_errors(1, module.ALLOWED_METADATA_ERROR + "\nbroken package"))

    def test_missing_or_failed_dependency_evidence_rejected(self):
        self.assertTrue(module.dependency_errors(1, ""))
        self.assertTrue(module.dependency_errors(2, module.ALLOWED_METADATA_ERROR))
        self.assertTrue(module.dependency_errors(0, ""))

    def test_missing_kfa_is_fatal(self):
        with patch.object(module, "version", side_effect=ModuleNotFoundError("kfa")):
            with self.assertRaises(ModuleNotFoundError):
                module.check_ready()

    def test_wrong_version_is_fatal(self):
        with patch.object(module, "version", return_value="0.0.0"):
            with self.assertRaises(RuntimeError):
                module.check_ready()

    def mocked_ready(self, *, missing_model=False, corrupt_model=False):
        with tempfile.TemporaryDirectory() as root, ExitStack() as stack:
            model = Path(root) / "kfa/wav2vec2-km-base-1500.onnx"
            if not missing_model:
                model.parent.mkdir()
                model.write_bytes(b"synthetic model fixture")
            versions = {"kfa": "0.2.0", "khmercut": "0.0.2", "python-crfsuite": "0.9.9", "tqdm": "4.65.0", "sosap": "0.4.3"}
            stack.enter_context(patch.object(module, "version", side_effect=versions.__getitem__))
            stack.enter_context(patch.object(module.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout="No broken requirements found.", stderr="")))
            telemetry_disabled = False
            def disable_telemetry():
                nonlocal telemetry_disabled
                telemetry_disabled = True
            def create_session():
                self.assertTrue(telemetry_disabled, "Disable ORT telemetry before creating a KFA session")
                if corrupt_model:
                    raise RuntimeError("Corrupt ONNX graph")
                return types.SimpleNamespace(get_inputs=lambda: ["audio"], get_outputs=lambda: ["emissions"])
            modules = {
                "appdirs": types.SimpleNamespace(user_cache_dir=lambda: root),
                "onnxruntime": types.SimpleNamespace(disable_telemetry_events=disable_telemetry),
                "khmernormalizer": types.ModuleType("khmernormalizer"),
                "faster_whisper": types.ModuleType("faster_whisper"),
                "kfa": types.SimpleNamespace(create_session=create_session),
                "khmercut": types.SimpleNamespace(tokenize=lambda _: ["Khmer"]),
                "sosap": types.SimpleNamespace(Model=object),
            }
            def import_runtime(name):
                for key in ("ORT_DISABLE_TELEMETRY", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
                    self.assertEqual(module.os.environ[key], "1")
                if name == "kfa":
                    self.assertTrue(telemetry_disabled, "Disable ORT telemetry before KFA import")
                return modules[name]
            stack.enter_context(patch.dict("sys.modules", modules))
            stack.enter_context(patch.object(module.importlib, "import_module", side_effect=import_runtime))
            return module.check_ready()

    def test_usable_cached_model_and_native_imports_succeed(self):
        self.mocked_ready()

    def test_missing_model_is_fatal_before_import_download(self):
        with self.assertRaisesRegex(RuntimeError, "not been prepared"):
            self.mocked_ready(missing_model=True)

    def test_corrupt_model_session_is_fatal(self):
        with self.assertRaisesRegex(RuntimeError, "Corrupt"):
            self.mocked_ready(corrupt_model=True)


if __name__ == "__main__":
    unittest.main()
