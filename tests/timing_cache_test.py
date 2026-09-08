"""Cache I/O regression tests; stdlib only, synthetic decoder/model/NPZ boundaries.

The actual worker's orchestration, cache functions and file operations execute.
No KFA/Whisper model, user media, network, or installed runtime state is used.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("studio_timing_worker", Path(__file__).resolve().parents[1] / "local-timing" / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ArrayFixture:
    shape = (50, 8)
    ndim = 2

    def __getitem__(self, key):
        return self

    def squeeze(self):
        return self


class AudioFixture:
    shape = (16000,)

    def __len__(self):
        return 16000

    def __getitem__(self, key):
        return self


class TimingCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-timing-cache-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / "synthetic.wav"
        self.audio.write_bytes(b"synthetic decoder fixture, not actual WAV media")
        self.cache = self.root / "cache"
        self.emission = ArrayFixture()
        self.transcript = "សួស្តី"
        worker._emission_memory.clear()
        self.addCleanup(worker._emission_memory.clear)
        self.stderr = io.StringIO()
        capture = contextlib.redirect_stderr(self.stderr)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)

        # Keep model and NPZ computation synthetic while using real disk paths.
        def save_npz(handle, **values):
            handle.write(json.dumps({"sample_count": values["sample_count"], "sample_rate": values["sample_rate"]}).encode())

        @contextlib.contextmanager
        def load_npz(filename, allow_pickle):
            self.assertIs(allow_pickle, False)
            values = json.loads(Path(filename).read_text())
            yield {**values, "emission": self.emission}

        self.numpy = SimpleNamespace(concatenate=lambda values, axis: self.emission,
                                     savez=Mock(side_effect=save_npz), load=Mock(side_effect=load_npz))
        self.decoder = Mock(return_value=(AudioFixture(), 16000))
        self.session = SimpleNamespace(run=Mock(return_value=[[self.emission]]))
        self.aligner = Mock(return_value=[(self.transcript, 0, 1, 0, 1, 0.9)])
        self.fallback = Mock(return_value={"engine": "synthetic-fallback"})
        modules = {
            "numpy": self.numpy,
            "librosa": SimpleNamespace(load=self.decoder),
            "scipy.special": SimpleNamespace(log_softmax=lambda value, axis: value),
            "kfa.utils": SimpleNamespace(time_to_frame=lambda seconds: int(seconds * 50)),
        }
        for context in (patch.dict(sys.modules, modules),
                        patch.object(worker, "get_kfa_session", return_value=self.session),
                        patch.object(worker, "align_kfa_emission", self.aligner),
                        patch.object(worker, "run_faster_whisper", self.fallback)):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)

    def align(self, disabled=True):
        args = worker.options_namespace({"emissionCacheDir": str(self.cache), "disableWhisperFallback": disabled})
        return worker.process_alignment(self.audio, self.transcript, args)

    def assert_kfa(self, result):
        self.assertEqual(result["engine"], "kfa-local")
        self.assertEqual(result["words"], [{"text": self.transcript, "startMs": 0, "endMs": 1000, "confidence": 0.9}])
        self.fallback.assert_not_called()
        self.assertIs(self.aligner.call_args.args[0], self.emission)

    def test_directory_creation_failure_does_not_select_fallback(self):
        original = Path.mkdir

        def fail_cache(path, *args, **kwargs):
            if path == self.cache:
                raise PermissionError("synthetic cache directory lock")
            return original(path, *args, **kwargs)

        for disabled in (True, False):
            with self.subTest(fallback_disabled=disabled), patch.object(Path, "mkdir", fail_cache):
                worker._emission_memory.clear()
                self.assert_kfa(self.align(disabled))
        self.assertIn("cache unavailable", self.stderr.getvalue())

    def test_cache_probe_failure_is_a_cache_miss(self):
        original = Path.exists

        def fail_cache(path):
            if path.suffix == ".npz":
                raise PermissionError("synthetic cache stat failure")
            return original(path)

        with patch.object(Path, "exists", fail_cache):
            self.assert_kfa(self.align())
        self.session.run.assert_called_once()

    def test_cache_open_failure_preserves_computed_evidence(self):
        original = Path.open

        def fail_cache(path, *args, **kwargs):
            if path.suffix == ".tmp":
                raise PermissionError("synthetic temporary-file lock")
            return original(path, *args, **kwargs)

        with patch.object(Path, "open", fail_cache):
            self.assert_kfa(self.align())
        self.assertIn("cache write skipped", self.stderr.getvalue())

    def test_cache_write_failure_does_not_select_fallback(self):
        def partial_write(handle, **values):
            handle.write(b"partial")
            raise OSError("synthetic full disk")

        self.numpy.savez.side_effect = partial_write
        self.assert_kfa(self.align())
        self.assertEqual(list(self.cache.glob("*.tmp")), [])

    def test_rename_failure_keeps_results_and_memory_reuse(self):
        for disabled in (True, False):
            with self.subTest(fallback_disabled=disabled):
                worker._emission_memory.clear()
                self.session.run.reset_mock()
                with patch.object(worker.os, "replace", side_effect=PermissionError("synthetic rename lock")):
                    self.assert_kfa(self.align(disabled))
                    self.assert_kfa(self.align(disabled))
                self.session.run.assert_called_once()
                self.assertEqual(list(self.cache.glob("*.tmp")), [])

    def test_failed_replacement_preserves_previous_disk_bytes(self):
        self.cache.mkdir()
        target = self.cache / "existing.npz"
        target.write_bytes(b"previous complete snapshot")
        with patch.object(worker.os, "replace", side_effect=OSError("synthetic rename lock")):
            worker.save_disk_emission(target, self.emission, 16000, 16000)
        self.assertEqual(target.read_bytes(), b"previous complete snapshot")
        self.assertEqual(list(self.cache.glob("*.tmp")), [])

    def test_temporary_cleanup_failure_does_not_mask_alignment(self):
        original = Path.unlink

        def fail_temp(path, *args, **kwargs):
            if path.suffix == ".tmp":
                raise PermissionError("synthetic cleanup lock")
            return original(path, *args, **kwargs)

        with patch.object(Path, "unlink", fail_temp), patch.object(worker.os, "replace", side_effect=OSError("synthetic rename lock")):
            self.assert_kfa(self.align())

    def test_valid_disk_and_memory_hits_skip_acoustic_computation(self):
        self.assert_kfa(self.align())
        self.assert_kfa(self.align())
        worker._emission_memory.clear()
        self.assert_kfa(self.align())
        self.session.run.assert_called_once()
        self.numpy.load.assert_called_once()

    def test_corrupt_or_unreadable_cache_recomputes(self):
        self.cache.mkdir()
        target = self.cache / f"{worker.audio_identity(self.audio)}.npz"
        target.write_bytes(b"not an NPZ fixture")
        self.assert_kfa(self.align())
        self.session.run.assert_called_once()
        worker._emission_memory.clear()
        self.numpy.load.side_effect = PermissionError("synthetic read lock")
        self.assert_kfa(self.align())
        self.assertEqual(self.session.run.call_count, 2)

    def test_prepare_and_cli_paths_survive_cache_io_failure(self):
        request = {"action": "prepare", "audio": str(self.audio), "options": {"emissionCacheDir": str(self.cache)}}
        with patch.object(worker.os, "replace", side_effect=OSError("synthetic rename lock")):
            self.assertEqual(worker.process_server_request(request), {"prepared": True})
            worker._emission_memory.clear()
            transcript_file = self.root / "transcript.txt"
            transcript_file.write_text(self.transcript, encoding="utf-8")
            args = worker.options_namespace({"emissionCacheDir": str(self.cache), "disableWhisperFallback": True})
            args.audio, args.transcript_file, args.output = str(self.audio), str(transcript_file), str(self.root / "result.json")
            worker.run_cli(args)
        self.assert_kfa(json.loads(Path(args.output).read_text(encoding="utf-8")))

    def test_no_disk_cache_remains_supported(self):
        args = worker.options_namespace({"disableWhisperFallback": True})
        self.assert_kfa(worker.process_alignment(self.audio, self.transcript, args))
        self.numpy.savez.assert_not_called()

    def test_real_engine_errors_retain_fallback_and_disabled_behavior(self):
        for operation in (self.decoder, self.session.run, self.aligner):
            for disabled in (True, False):
                with self.subTest(operation=operation, fallback_disabled=disabled):
                    worker._emission_memory.clear()
                    self.fallback.reset_mock()
                    operation.side_effect = OSError("synthetic engine failure, not cache I/O")
                    # No disk cache hit can bypass the deliberately failed engine.
                    args = worker.options_namespace({"disableWhisperFallback": disabled})
                    try:
                        if disabled:
                            with self.assertRaisesRegex(RuntimeError, "KFA failed and local Whisper fallback is disabled"):
                                worker.process_alignment(self.audio, self.transcript, args)
                            self.fallback.assert_not_called()
                        else:
                            result = worker.process_alignment(self.audio, self.transcript, args)
                            self.assertEqual(result["engine"], "synthetic-fallback")
                            self.fallback.assert_called_once()
                    finally:
                        operation.side_effect = None

    def test_missing_audio_and_empty_transcript_still_reject(self):
        args = worker.options_namespace({})
        with self.assertRaises(FileNotFoundError):
            worker.process_alignment(self.root / "missing.wav", self.transcript, args)
        with self.assertRaisesRegex(RuntimeError, "transcript was empty"):
            worker.process_alignment(self.audio, " ", args)
        self.session.run.assert_not_called()
        self.fallback.assert_not_called()

    def test_invalid_cache_metadata_recomputes(self):
        self.cache.mkdir()
        target = self.cache / f"{worker.audio_identity(self.audio)}.npz"
        target.write_text(json.dumps({"sample_count": 0, "sample_rate": 10}))
        self.assert_kfa(self.align())
        self.session.run.assert_called_once()

    def test_cli_output_failure_is_not_mistaken_for_optional_cache_io(self):
        transcript_file = self.root / "transcript.txt"
        transcript_file.write_text(self.transcript, encoding="utf-8")
        args = worker.options_namespace({"disableWhisperFallback": True})
        args.audio, args.transcript_file, args.output = str(self.audio), str(transcript_file), str(self.root / "result.json")
        original = Path.open

        def fail_output(path, *positional, **kwargs):
            if path == Path(args.output):
                raise PermissionError("synthetic required output failure")
            return original(path, *positional, **kwargs)

        with patch.object(Path, "open", fail_output), self.assertRaisesRegex(PermissionError, "required output failure"):
            worker.run_cli(args)
        self.fallback.assert_not_called()

    def test_non_io_programming_errors_are_not_swallowed(self):
        self.numpy.savez.side_effect = ValueError("synthetic serialization bug")
        with self.assertRaisesRegex(ValueError, "serialization bug"):
            worker.compute_kfa_emission(self.audio, self.cache)


if __name__ == "__main__":
    unittest.main()
