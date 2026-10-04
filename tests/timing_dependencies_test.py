"""No network/models/native extensions: policy, graph and privacy regressions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load("timing_check", "scripts/check-timing-dependencies.py")
LOCK = load("timing_lock", "scripts/lock-timing-dependencies.py")
VERSIONS = json.loads((ROOT / "local-timing/locks/versions.json").read_text())
PROVENANCE = json.loads((ROOT / "local-timing/locks/pypi-metadata.json").read_text())
WIN, LEGACY, MODERN = CHECK.PROFILES


class TimingDependencyTests(unittest.TestCase):
    def test_all_versions_include_transitive_dependencies_and_tooling(self):
        for profile in CHECK.PROFILES:
            versions = {**VERSIONS["tooling"], **VERSIONS["profiles"][profile]}
            CHECK.check_versions(ROOT, profile, versions.__getitem__)
            for name in ("requests", "numpy", "kfa", "urllib3", "pip", "wheel", "setuptools"):
                bad = {**versions, name: "0.0.0"}
                with self.assertRaisesRegex(RuntimeError, name):
                    CHECK.check_versions(ROOT, profile, bad.__getitem__)

    def test_pip_result_is_strict_and_platform_scoped(self):
        self.assertEqual(CHECK.dependency_errors(0, "No broken requirements found.\n", WIN), [])
        self.assertEqual(CHECK.dependency_errors(1, CHECK.KFA_METADATA_ERROR, WIN), [])
        both = CHECK.KFA_METADATA_ERROR + "\n" + CHECK.MAC_METADATA_ERROR
        self.assertEqual(CHECK.dependency_errors(1, both, LEGACY), [])
        self.assertTrue(CHECK.dependency_errors(1, both, WIN))
        for code, output in [(0, ""), (1, ""), (2, CHECK.KFA_METADATA_ERROR), (0, CHECK.KFA_METADATA_ERROR),
                             (1, "No broken requirements found."), (1, CHECK.KFA_METADATA_ERROR + " unexpected"),
                             (1, CHECK.KFA_METADATA_ERROR.replace("0.4.3", "0.4.4")),
                             (1, CHECK.KFA_METADATA_ERROR + "\nmissing dependency")]:
            self.assertTrue(CHECK.dependency_errors(code, output, WIN), (code, output))

    def test_malformed_or_injectable_locks_fail(self):
        good = "requests==2.34.2 --hash=sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "lock.txt"
            filename.write_text(good + "\n")
            self.assertEqual(CHECK.read_lock(filename), {"requests": "2.34.2"})
            for text in ["", "requests>=2.34.2", "-r unreviewed.txt", "--extra-index-url https://example.invalid",
                         good + "\n" + good, good[:-1], "requests @ https://example.invalid/requests.whl"]:
                filename.write_text(text)
                with self.assertRaises(RuntimeError):
                    CHECK.read_lock(filename)
        with self.assertRaises(ValueError):
            CHECK.check_versions(ROOT, "../../outside", lambda _: "0")

    def test_incompatible_interpreter_and_profile_rejected(self):
        with patch.object(CHECK.platform, "python_implementation", return_value="CPython"), \
             patch.object(CHECK.struct, "calcsize", return_value=8), \
             patch.object(CHECK.sys, "version_info", (3, 12, 15)), \
             patch.object(CHECK.sys, "platform", "win32"), \
             patch.object(CHECK.platform, "machine", return_value="AMD64"):
            CHECK.validate_host(WIN)
            with patch.object(CHECK.sys, "version_info", (3, 11, 0)), self.assertRaisesRegex(RuntimeError, "3.12"):
                CHECK.validate_host(WIN)
            with patch.object(CHECK.platform, "machine", return_value="ARM64"), self.assertRaisesRegex(RuntimeError, "x64"):
                CHECK.validate_host(WIN)
        with patch.object(CHECK.platform, "python_implementation", return_value="CPython"), \
             patch.object(CHECK.struct, "calcsize", return_value=8), \
             patch.object(CHECK.sys, "version_info", (3, 12, 15)), \
             patch.object(CHECK.sys, "platform", "darwin"), \
             patch.object(CHECK.platform, "machine", return_value="arm64"):
            for version, profile in [("12.3", LEGACY), ("13.7", LEGACY), ("14.0", MODERN), ("26.0", MODERN)]:
                with patch.object(CHECK.platform, "mac_ver", return_value=(version, (), "arm64")):
                    CHECK.validate_host(profile)
                    with self.assertRaises(RuntimeError):
                        CHECK.validate_host(MODERN if profile == LEGACY else LEGACY)
            with patch.object(CHECK.platform, "mac_ver", return_value=("12.2.1", (), "arm64")), self.assertRaisesRegex(RuntimeError, "12.3"):
                CHECK.validate_host(LEGACY)

    def test_extra_installed_distributions_force_repair(self):
        with patch.object(CHECK, "check_versions"), \
             patch.object(CHECK, "distributions", return_value=[SimpleNamespace(metadata={"Name": "unreviewed-addon"})]), \
             patch.object(CHECK.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "unreviewed-addon"):
                CHECK.check_dependencies(ROOT, WIN)
            run.assert_not_called()

    def test_every_recorded_dependency_edge_resolves(self):
        for profile in CHECK.PROFILES:
            versions = {**VERSIONS["tooling"], **VERSIONS["profiles"][profile]}
            LOCK.verify_graph(profile, versions, PROVENANCE["metadata"])
            with self.assertRaisesRegex(RuntimeError, "requires"):
                LOCK.verify_graph(profile, {**versions, "urllib3": "0.0.0"}, PROVENANCE["metadata"])
            missing = dict(versions)
            del missing["requests"]
            with self.assertRaisesRegex(RuntimeError, "missing"):
                LOCK.verify_graph(profile, missing, PROVENANCE["metadata"])

    def test_provisioned_patch_controls_requires_python_and_markers(self):
        self.assertEqual(LOCK.profile_environment(WIN)["python_full_version"], "3.12.15")
        artifact = {"filename": "example-1.0-py3-none-any.whl", "packagetype": "bdist_wheel",
                    "url": "https://files.pythonhosted.org/test", "digests": {"sha256": "a" * 64},
                    "requires_python": ">=3.12.15,<3.13"}
        self.assertTrue(LOCK.select_artifacts("example", "1.0", [artifact], WIN))
        with self.assertRaises(RuntimeError):
            LOCK.select_artifacts("example", "1.0", [{**artifact, "requires_python": "<3.12.15"}], WIN)
        metadata = {"example==1.0": {"requires_python": ">=3.12.15", "requires_dist": [
            'patched-dep; python_full_version >= "3.12.15"']}}
        with self.assertRaisesRegex(RuntimeError, "missing patched-dep"):
            LOCK.verify_graph(WIN, {"example": "1.0"}, metadata)

    def test_reviewed_native_and_tooling_invariants_are_retained(self):
        self.assertEqual(VERSIONS["tooling"]["setuptools"], "80.10.2")
        for profile, versions in VERSIONS["profiles"].items():
            for name, value in {"numpy": "1.26.4", "kfa": "0.2.0", "sosap": "0.4.3", "khmercut": "0.0.2",
                                "tqdm": "4.65.0", "requests": "2.34.2", "setuptools": "80.10.2"}.items():
                self.assertEqual(versions[name], value)
            self.assertEqual(versions["python-crfsuite"], "0.9.9" if profile == WIN else "0.9.11")
            self.assertEqual(versions["onnxruntime"], "1.19.2" if profile == LEGACY else "1.30.0")
        constraints = ROOT / "local-timing/constraints-macos-legacy.txt"
        for line in constraints.read_text().splitlines():
            if line and not line.startswith("#"):
                name, value = line.split("==")
                self.assertEqual(VERSIONS["profiles"][LEGACY][name], value)

    def test_only_exact_dependency_edges_are_overridden(self):
        requirement = LOCK.Requirement("sosap==0.0.1")
        self.assertTrue(LOCK.permitted_mismatch(WIN, "kfa", "0.2.0", requirement, "0.4.3"))
        for name, version, installed in [("other", "0.2.0", "0.4.3"), ("kfa", "0.3.0", "0.4.3"), ("kfa", "0.2.0", "0.4.4")]:
            self.assertFalse(LOCK.permitted_mismatch(WIN, name, version, requirement, installed))
        requirement = LOCK.Requirement("python-crfsuite==0.9.9")
        self.assertTrue(LOCK.permitted_mismatch(LEGACY, "khmercut", "0.0.2", requirement, "0.9.11"))
        self.assertFalse(LOCK.permitted_mismatch(WIN, "khmercut", "0.0.2", requirement, "0.9.11"))

    def test_manifest_and_exact_hashes_agree_with_provenance(self):
        directory = ROOT / "local-timing/locks"
        manifest = json.loads((directory / "manifest.json").read_text())
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual({row["path"] for row in manifest["files"]}, {f"local-timing/locks/{name}.txt" for name in ("tooling", *CHECK.PROFILES)})
        for row in manifest["files"]:
            self.assertEqual(hashlib.sha256((ROOT / row["path"]).read_bytes()).hexdigest(), row["sha256"])
        for profile in ("tooling", *CHECK.PROFILES):
            text = (directory / f"{profile}.txt").read_text()
            versions = CHECK.read_lock(directory / f"{profile}.txt")
            expected = VERSIONS["tooling"] if profile == "tooling" else VERSIONS["profiles"][profile]
            self.assertEqual(versions, expected)
            artifacts = PROVENANCE["artifacts"][profile]
            hashes = {part.split()[0] for part in text.split("--hash=sha256:")[1:]}
            self.assertEqual(hashes, {item["sha256"] for values in artifacts.values() for item in values})
            for key, values in artifacts.items():
                name, version = key.split("==")
                files = [{**item, "packagetype": "bdist_wheel" if item["filename"].endswith(".whl") else "sdist",
                          "digests": {"sha256": item["sha256"]}} for item in values]
                selected = LOCK.select_artifacts(name, version, files, WIN if profile == "tooling" else profile)
                self.assertEqual(selected, values)
                for item in values:
                    self.assertTrue(item["filename"].endswith(".whl") or (key == "emoji==2.6.0" and item["filename"] == "emoji-2.6.0.tar.gz"))

    def test_native_sdist_and_wrong_platform_never_admitted(self):
        artifact = {"filename": "numpy-1.26.4.tar.gz", "packagetype": "sdist", "url": "https://files.pythonhosted.org/test", "digests": {"sha256": "a" * 64}}
        with self.assertRaisesRegex(RuntimeError, "No reviewed"):
            LOCK.select_artifacts("numpy", "1.26.4", [artifact], WIN)
        artifact.update(filename="numpy-1.26.4-cp312-cp312-macosx_11_0_arm64.whl", packagetype="bdist_wheel")
        with self.assertRaisesRegex(RuntimeError, "No reviewed"):
            LOCK.select_artifacts("numpy", "1.26.4", [artifact], WIN)


class TimingPrivacyTests(unittest.TestCase):
    def test_standalone_entries_override_inherited_telemetry_before_native_import(self):
        for filename in ("local-timing/worker.py", "scripts/check-macos-timing.py"):
            script = f'''import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("privacy_test", {str(ROOT / filename)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert all(os.environ[key] == "1" for key in ("ORT_DISABLE_TELEMETRY", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"))
assert "onnxruntime" not in sys.modules
assert "kfa" not in sys.modules
assert "faster_whisper" not in sys.modules
'''
            result = subprocess.run([sys.executable, "-I", "-B", "-c", script], capture_output=True, text=True,
                                    env={**os.environ, "ORT_DISABLE_TELEMETRY": "0", "HF_HUB_DISABLE_TELEMETRY": "0", "DO_NOT_TRACK": "0"})
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_api_disabled_before_kfa_session_and_whisper_model(self):
        worker = load("timing_worker_privacy", "local-timing/worker.py")
        events = []
        ort = SimpleNamespace(disable_telemetry_events=lambda: events.append("disable"))
        kfa = SimpleNamespace(create_session=lambda: events.append("kfa") or object())
        whisper = SimpleNamespace(WhisperModel=lambda *args, **kwargs: events.append("whisper") or object())
        with patch.dict(sys.modules, {"onnxruntime": ort, "kfa": kfa, "faster_whisper": whisper}):
            worker.get_kfa_session()
            self.assertEqual(events, ["disable", "kfa"])
            worker.load_whisper_model("never-download-fake", "cpu", "int8")
            self.assertEqual(events, ["disable", "kfa", "disable", "whisper"])


if __name__ == "__main__":
    unittest.main()
