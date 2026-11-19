"""Window clock and ownership checks, with an explicitly opted-in installed KFA test."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

WORKER_PATH = Path(__file__).resolve().parents[1] / "local-timing" / "worker.py"
spec = importlib.util.spec_from_file_location("sthang_window_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

BUDGETS = {"maxIds": 512, "maxCells": 1_000_000, "maxCellsTargetOnly": 8_000_000}


def line(text):
    return {"text": text}


def variant(name, start_ms, end_ms, lines):
    return {"name": name, "startMs": start_ms, "endMs": end_ms, "lines": lines}


class TimingWindowTests(unittest.TestCase):
    def test_window_bounds_use_the_full_clock_and_include_the_last_frame(self):
        n, rate, frames = 457_001, 16_000, 1_427
        end = 1000 * n / rate
        self.assertEqual(worker.window_frame_bounds(25.5, 75.1, frames, n, rate), (1, 4))
        self.assertEqual(worker.window_frame_bounds(end - 1, end + 5, frames, n, rate), (1426, 1427))
        self.assertEqual(worker.window_frame_bounds(-0.5, end + 1, frames, n, rate), (0, 1427))
        self.assertEqual(worker.window_frame_bounds(29_999.9, 30_000.1, 2_997, 960_000, rate), (1498, 1499))

    def test_alternate_window_and_target_errors_do_not_abort_other_attempts(self):
        targets = {"id": "cue", "variants": [
            variant("full", 0, 300, []), variant("target", 0, 200, []),
            variant("target-wide", 0, 400, []),
        ]}

        def synthetic_attempt(_emission, _pcm, _clock, request, _budgets):
            name = request["name"]
            if name == "full":
                raise ValueError("Private details must never reach the result")
            if name == "target":
                return {"variant": name, "result": "frames-short"}, None
            return {"variant": name, "result": "ok"}, [{"line": 0}]

        with patch.object(worker, "align_window_variant", side_effect=synthetic_attempt):
            result = worker.align_window_target(None, None, None, targets, BUDGETS)
        self.assertEqual([row["result"] for row in result["attempts"]], ["error", "frames-short", "ok"])
        self.assertNotIn("Private", json.dumps(result))
        self.assertEqual(result["words"], [{"line": 0}])

        with patch.object(worker, "align_window_variant", return_value=({"result": "budget"}, None)) as align:
            result = worker.align_window_target(None, None, None, targets, BUDGETS)
        self.assertEqual(align.call_count, 2)
        self.assertNotIn("words", result)


@unittest.skipUnless(os.environ.get("STHANG_REAL_KFA") == "1", "requires the already-installed KFA runtime")
class InstalledKfaWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = tempfile.TemporaryDirectory(prefix="sthang-kfa-window-tests-")
        cls.addClassCleanup(scratch.cleanup)
        cls.root = Path(scratch.name)
        env = patch.dict(os.environ, {"NUMBA_CACHE_DIR": str(cls.root / "numba")})
        env.start()
        cls.addClassCleanup(env.stop)

        # Never trigger the package's import-time download.
        from appdirs import user_cache_dir
        model = Path(user_cache_dir()) / "kfa" / f"{worker.KFA_MODEL_ID}.onnx"
        if not model.is_file():
            raise AssertionError("STHANG_REAL_KFA requires the cached pinned model")
        from importlib.metadata import version
        assert version("kfa") == "0.2.0"
        import numpy as np
        from kfa.text_normalize import tokenize_phonemize
        from kfa.utils import intersperse, vocabs

        cls.texts = ["សួស្តី", "!", "AI CapCut ១២", "ខ្មែរ 20 test", "។"]
        cls.lines = [line(text) for text in cls.texts]
        cls.expected = [(0, "សួស្តី!"), (2, "AI "), (2, "CapCut "), (2, "១២"),
                        (3, "ខ្មែរ "), (3, "20 "), (3, "test។")]
        items = [item for text in cls.texts for item in tokenize_phonemize(text) if len(item) == 3]
        groups = intersperse([item[2] for item in items], [vocabs["|"]])
        ids = [value for group in groups for value in group]
        cls.frames = 4 * len(ids) + 24
        cls.n = 321 * cls.frames + 157
        cls.rate = 16_000
        cls.clock = (cls.n, cls.rate, cls.frames)
        cls.full = variant("full", 0, cls.ms(cls.frames), cls.lines)
        cls.emission = np.full((cls.frames, max(vocabs.values()) + 1), -24, dtype=np.float32)
        cls.emission[:, vocabs["[PAD]"]] = -1
        for index, token in enumerate(ids):
            cls.emission[10 + 4 * index, token] = 0
        cls.pcm = np.full(cls.n, 0.125, dtype=np.float32)
        cls.cache = cls.root / "cache"
        cls.audio = cls.root / "fixture.wav"
        with wave.open(str(cls.audio), "wb") as wav:
            wav.setparams((1, 2, cls.rate, 0, "NONE", "not compressed"))
            wav.writeframes(np.full(cls.n, 4096, dtype="<i2").tobytes())
        cache_path = worker.emission_cache_path(cls.cache, worker.audio_identity(cls.audio))
        worker.save_disk_emission(cache_path, cls.emission, cls.n, cls.rate)
        assert cache_path.is_file()

    @classmethod
    def ms(cls, frame):
        return 1000 * frame * cls.n / (cls.frames * cls.rate)

    def test_real_layout_owns_every_word_and_matches_legacy_actual_boundaries(self):
        attempt, words = worker.align_window_variant(self.emission, self.pcm, self.clock, self.full, BUDGETS)
        self.assertEqual(attempt["result"], "ok")
        self.assertEqual([(word["line"], word["text"]) for word in words], self.expected)
        transcript = "\n".join(self.texts)
        actual = worker.align_kfa_emission(self.emission, self.n, self.rate, transcript)
        with patch.object(worker, "compute_kfa_emission", return_value=(self.emission, self.n, self.rate)):
            legacy = worker.run_kfa(self.audio, transcript)["words"]
        self.assertEqual(len(words), len(actual))
        self.assertEqual(len(words), len(legacy))
        for word, row, old in zip(words, actual, legacy):
            self.assertEqual(word["text"], row[0])
            self.assertEqual(word["text"].strip(), old["text"])
            self.assertEqual(word["peak"], 0.125)
            self.assertAlmostEqual(self.ms(word["startFrame"]), row[3] * 1000, places=8)
            self.assertAlmostEqual(self.ms(word["endFrame"]), row[4] * 1000, places=8)
            self.assertLessEqual(abs(self.ms(word["startFrame"]) - old["startMs"]), 1)
            self.assertLessEqual(abs(self.ms(word["endFrame"]) - old["endMs"]), 1)

        sliced = {**self.full, "startMs": self.ms(3) + 0.1, "endMs": self.ms(self.frames) - 0.1}
        _, interior = worker.align_window_variant(self.emission, self.pcm, self.clock, sliced, BUDGETS)
        self.assertEqual([(row["startFrame"], row["endFrame"]) for row in interior],
                         [(row["startFrame"], row["endFrame"]) for row in words])

    def test_classifies_short_budget_and_no_fit_before_returning_words(self):
        variants = [
            ({**self.full, "endMs": self.ms(2)}, BUDGETS, "frames-short"),
            (self.full, {**BUDGETS, "maxIds": 1}, "budget"),
            (self.full, {**BUDGETS, "maxCells": 1}, "budget"),
            ({**self.full, "lines": [line("AI")]}, {**BUDGETS, "maxCellsTargetOnly": 1}, "budget"),
        ]
        with patch("kfa.utils.get_trellis", side_effect=AssertionError("trellis was allocated")) as trellis:
            for descriptor, budgets, expected in variants:
                attempt, words = worker.align_window_variant(self.emission, self.pcm, self.clock, descriptor, budgets)
                self.assertEqual(attempt["result"], expected)
                self.assertIsNone(words)
            trellis.assert_not_called()
        with patch("kfa.utils.backtrack", side_effect=AssertionError):
            attempt, words = worker.align_window_variant(self.emission, self.pcm, self.clock, self.full, BUDGETS)
            self.assertEqual(attempt["result"], "no-fit")
            self.assertIsNone(words)

    def test_daemon_and_cli_match_and_later_target_survives_an_ownership_error(self):
        bad = {**self.full, "lines": [line("!"), *self.lines]}
        request = {
            "audio": str(self.audio), "options": {"emissionCacheDir": str(self.cache)},
            "budgets": BUDGETS, "targets": [
                {"id": "before", "variants": [self.full]},
                {"id": "error", "variants": [bad]},
                {"id": "after", "variants": [self.full]},
            ],
        }
        input_path = self.root / "request.json"
        output_path = self.root / "response.json"
        input_path.write_text(json.dumps(request), encoding="utf-8")
        python = [sys.executable, "-I", "-B", str(WORKER_PATH)]
        daemon = subprocess.run([*python, "--server"],
                                input=json.dumps({"action": "align-windows", "id": "fixture", **request}) + "\n",
                                encoding="utf-8", capture_output=True, check=True, timeout=75)
        response = json.loads(daemon.stdout)
        self.assertTrue(response["ok"])
        self.assertIn("KFA acoustic emission cache hit (disk).", daemon.stderr)
        cli = subprocess.run([*python, "--align-windows-request", str(input_path), "--output", str(output_path)],
                             encoding="utf-8", capture_output=True, check=True, timeout=75)
        self.assertIn("KFA acoustic emission cache hit (disk).", cli.stderr)
        from_cli = json.loads(output_path.read_text(encoding="utf-8"))
        for payload in [from_cli, response["result"]]:
            self.assertEqual([target["attempts"][0]["result"] for target in payload["targets"]], ["ok", "error", "ok"])
            for target in payload["targets"]:
                self.assertGreaterEqual(target.pop("elapsedMs"), 0)
        self.assertEqual(from_cli, response["result"])
