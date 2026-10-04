"""Cross-platform provisioning logic tests; they do not claim native wheel health."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("provision", Path(__file__).resolve().parents[1] / "scripts/provision-timing.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
PROFILE = "macos-legacy-py312-arm64"


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio provisioning & spaces ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "work/source"
        self.root.mkdir(parents=True)
        self.store = self.base / "state/.timing-envs"
        self.store.mkdir(parents=True)
        self.store_patch = patch.object(m, "environment_store", return_value=self.store)
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)
        self.candidate = self.store / "candidate"
        self.candidate.mkdir()
        self.active = self.root / ".venv"
        locks = self.root / "local-timing/locks"
        locks.mkdir(parents=True)
        files = []
        for name in (*m.PROFILES, "tooling"):
            lock = locks / f"{name}.txt"
            lock.write_text("fixture==1 --hash=sha256:" + "a" * 64)
            files.append({"path": lock.relative_to(self.root).as_posix(), "sha256": hashlib.sha256(lock.read_bytes()).hexdigest()})
        (locks / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "files": files}))

    def legacy(self):
        self.active.mkdir()
        (self.active / "old.txt").write_text("user-owned prior environment")

    def journal(self, token="a" * 32, had_active=True):
        m.atomic_json(self.root / ".timing-transaction.json", {"schemaVersion": 1, "token": token, "candidate": str(self.candidate), "hadActive": had_active})
        return self.root / f".venv.rollback-{token}", self.root / f".venv.pending-{token}"

    def test_success_retains_legacy_environment(self):
        self.legacy()
        with patch.object(m, "validate") as validate:
            m.activate(self.candidate, self.active, PROFILE)
        self.assertEqual(self.active.resolve(), self.candidate)
        self.assertEqual(len(list(self.root.glob('.venv.rollback-*/old.txt'))), 1)
        self.assertFalse((self.root / '.timing-transaction.json').exists())
        validate.assert_called_once_with(self.active, PROFILE, ready=True)

    def test_final_path_failure_restores_real_directory(self):
        self.legacy()
        with patch.object(m, "validate", side_effect=RuntimeError("bad health")):
            with self.assertRaisesRegex(RuntimeError, "bad health"):
                m.activate(self.candidate, self.active, PROFILE)
        self.assertFalse(self.active.is_symlink())
        self.assertEqual((self.active / "old.txt").read_text(), "user-owned prior environment")
        self.assertFalse(list(self.root.glob('.venv.pending-*')))

    def test_final_path_failure_restores_existing_link(self):
        old = self.store / "old"
        old.mkdir()
        m.make_link(old, self.active)
        with patch.object(m, "validate", side_effect=RuntimeError("bad health")):
            with self.assertRaises(RuntimeError): m.activate(self.candidate, self.active, PROFILE)
        self.assertEqual(self.active.resolve(), old)

    def test_failed_link_creation_preserves_active(self):
        self.legacy()
        with patch.object(m, "make_link", side_effect=OSError("link failure")):
            with self.assertRaises(OSError): m.activate(self.candidate, self.active, PROFILE)
        self.assertTrue((self.active / "old.txt").is_file())

    def test_interrupted_rename_recovers_previous(self):
        for activated in [False, True]:
            with self.subTest(activated=activated):
                self.legacy()
                backup, pending = self.journal()
                m.make_link(self.candidate, pending)
                self.active.rename(backup)
                if activated: pending.rename(self.active)
                m.recover_activation(self.root)
                self.assertTrue((self.active / "old.txt").is_file())
                self.assertFalse(pending.exists())
                shutil.rmtree(self.active)

    def test_recovery_refuses_unexpected_active_directory(self):
        self.legacy()
        backup, _ = self.journal()
        self.active.rename(backup)
        self.active.mkdir()
        with self.assertRaisesRegex(RuntimeError, "unexpected active"):
            m.recover_activation(self.root)
        self.assertTrue((backup / "old.txt").is_file())

    def test_environment_survives_ota_source_move_and_work_cleanup(self):
        binary = m.python_in(self.candidate)
        binary.parent.mkdir()
        if os.name == "nt":
            # Actual junction execution is a native Windows acceptance gate.
            self.skipTest("Requires native Windows venv fixture")
        binary.symlink_to(sys.executable)
        with patch.object(m, "validate"):
            m.activate(self.candidate, self.active, PROFILE)
        final = self.base / "versions/1.0.0"
        final.parent.mkdir()
        self.root.rename(final)
        shutil.rmtree(self.base / "work")
        result = subprocess.run([str(m.python_in(final / '.venv')), '-c', 'print("healthy after move")'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('healthy after move', result.stdout)

    def test_stale_ready_environment_is_rebuilt_without_mutating_it(self):
        self.legacy()
        calls = []
        def run(args, **kwargs):
            calls.append([str(arg) for arg in args])
            if args[1:3] == ['-m', 'venv']:
                Path(args[3]).mkdir()
        with patch.object(m, 'run', side_effect=run), patch.object(m, 'validate', side_effect=[RuntimeError('stale lock'), None, None]):
            m.provision(self.root, PROFILE)
        self.assertTrue(any('--require-hashes' in call and '--no-deps' in call for call in calls))
        runtime_call = next(call for call in calls if '--no-binary=emoji' in call)
        self.assertIn('--no-build-isolation', runtime_call)
        self.assertTrue(list(self.root.glob('.venv.rollback-*/old.txt')))

    def test_failed_install_does_not_touch_working_environment(self):
        self.legacy()
        with patch.object(m, 'validate', side_effect=RuntimeError('stale')), patch.object(m, 'run', side_effect=subprocess.CalledProcessError(1, ['pip'])):
            with self.assertRaises(subprocess.CalledProcessError): m.provision(self.root, PROFILE)
        self.assertTrue((self.active / 'old.txt').exists())
        self.assertFalse(self.active.is_symlink())

    def test_exact_ready_shortcut_performs_validation(self):
        self.legacy()
        with patch.object(m, 'validate') as validate, patch.object(m, 'run') as run:
            m.provision(self.root, PROFILE)
        validate.assert_called_once_with(self.active, PROFILE, ready=True)
        run.assert_not_called()

    def test_tampered_lock_fails_before_any_environment_mutation(self):
        self.legacy()
        (self.root / f'local-timing/locks/{PROFILE}.txt').write_text('tampered')
        with patch.object(m, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'manifest verification'): m.provision(self.root, PROFILE)
        run.assert_not_called()
        self.assertTrue((self.active / 'old.txt').exists())

    def test_manifest_rejects_traversal_duplicate_and_missing_lock(self):
        manifest = self.root / 'local-timing/locks/manifest.json'
        original = json.loads(manifest.read_text())
        for kind in ['traversal', 'duplicate', 'missing']:
            record = json.loads(json.dumps(original))
            if kind == 'traversal': record['files'][0]['path'] = 'local-timing/locks/../../outside.txt'
            if kind == 'duplicate': record['files'][0] = record['files'][1]
            if kind == 'missing': record['files'].pop()
            manifest.write_text(json.dumps(record))
            with self.assertRaises(RuntimeError): m.verify_lock_manifest(self.root)

    def test_os_lock_rejects_concurrent_setup_and_recovers_after_process_death(self):
        script = "import importlib.util, pathlib, sys, time; s=importlib.util.spec_from_file_location('p', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m);\nwith m.setup_lock(pathlib.Path(sys.argv[2])):\n print('locked', flush=True)\n time.sleep(60)"
        child = subprocess.Popen([sys.executable, '-c', script, m.__file__, str(self.root)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with self.assertRaisesRegex(RuntimeError, 'Another timing setup'):
                with m.setup_lock(self.root): pass
        finally:
            child.terminate()
            child.wait(timeout=10)
            child.stdout.close()
        with m.setup_lock(self.root): pass


class WindowsFunctionalProbeTests(unittest.TestCase):
    """No network, native libraries, or real model weights are used here."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio probe ")
        self.addCleanup(self.temp.cleanup)
        self.model = Path(self.temp.name) / "kfa/wav2vec2-km-base-1500.onnx"
        self.model.parent.mkdir()
        self.session = types.SimpleNamespace(get_inputs=Mock(return_value=["audio"]), get_outputs=Mock(return_value=["emissions"]))
        self.create_session = Mock(return_value=self.session)
        self.tokenize = Mock(return_value=["ភាសា", "ខ្មែរ"])
        self.modules = {
            "onnxruntime": types.SimpleNamespace(disable_telemetry_events=Mock()),
            "kfa": types.SimpleNamespace(create_session=self.create_session),
            "khmercut": types.SimpleNamespace(tokenize=self.tokenize),
            "sosap": types.SimpleNamespace(Model=object()),
            "khmernormalizer": types.ModuleType("khmernormalizer"),
            "faster_whisper": types.ModuleType("faster_whisper"),
        }
        self.versions = {"khmercut": "0.0.2", "python-crfsuite": "0.9.9", "tqdm": "4.65.0", "sosap": "0.4.3"}

    def probe(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": self.temp.name}), patch.dict(sys.modules, self.modules), patch("importlib.metadata.version", side_effect=self.versions.__getitem__):
            exec(m.WINDOWS_FUNCTIONAL_PROBE, {})

    def test_missing_or_empty_model_never_opens_session(self):
        for exists in [False, True]:
            if exists: self.model.write_bytes(b"")
            with self.subTest(exists=exists), self.assertRaisesRegex(RuntimeError, "nonempty model cache"):
                self.probe()
        self.create_session.assert_not_called()

    def test_real_tokenization_and_kfa_session_contract_are_required(self):
        self.model.write_bytes(b"synthetic graph fixture")
        self.probe()
        self.tokenize.assert_called_once_with("ភាសាខ្មែរ")
        self.create_session.assert_called_once_with()
        self.session.get_inputs.assert_called_once_with()
        self.session.get_outputs.assert_called_once_with()
        self.modules["onnxruntime"].disable_telemetry_events.assert_called_once_with()

    def test_tokenizer_failure_never_opens_session(self):
        self.model.write_bytes(b"synthetic graph fixture")
        self.tokenize.return_value = []
        with self.assertRaisesRegex(RuntimeError, "tokenizer smoke"):
            self.probe()
        self.create_session.assert_not_called()

    def test_unloadable_model_is_rejected_before_activation(self):
        self.model.write_bytes(b"synthetic broken graph")
        self.create_session.side_effect = RuntimeError("invalid ONNX graph")
        root = Path(self.temp.name) / "source"
        locks = root / "local-timing/locks"
        locks.mkdir(parents=True)
        files = []
        for name in (*m.PROFILES, "tooling"):
            file = locks / f"{name}.txt"
            file.write_text("fixture")
            files.append({"path": file.relative_to(root).as_posix(), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        (locks / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "files": files}))
        store = Path(self.temp.name) / "environments"
        store.mkdir()
        def run(args, **kwargs):
            if args[-1] == m.WINDOWS_FUNCTIONAL_PROBE:
                self.probe()
        with patch.object(m, "environment_store", return_value=store), patch.object(m, "run", side_effect=run), patch.object(m, "activate") as activate:
            with self.assertRaisesRegex(RuntimeError, "invalid ONNX graph"):
                m.provision(root, "windows-py312-x64")
        activate.assert_not_called()
        self.assertFalse((root / ".venv").exists())

    def test_model_requires_usable_inputs_and_outputs(self):
        self.model.write_bytes(b"synthetic graph fixture")
        for missing in ["get_inputs", "get_outputs"]:
            with self.subTest(missing=missing):
                function = getattr(self.session, missing)
                function.return_value = []
                with self.assertRaisesRegex(RuntimeError, "no usable inputs/outputs"):
                    self.probe()
                function.return_value = ["tensor"]

    def test_ready_path_rejects_empty_cache_before_functional_imports(self):
        self.model.write_bytes(b"")
        with patch.dict(os.environ, {"LOCALAPPDATA": self.temp.name}), patch.object(m, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "empty"):
                m.validate(Path(self.temp.name) / "active", "windows-py312-x64", ready=True)
        self.assertFalse(any(call.args[0][-1] == m.WINDOWS_FUNCTIONAL_PROBE for call in run.call_args_list))


if __name__ == '__main__': unittest.main()
