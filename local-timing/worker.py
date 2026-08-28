import argparse
import contextlib
import hashlib
import json
import math
import os
import sys
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

# Portions of the KFA acoustic-emission and transcript-alignment flow below are
# adapted from KFA 0.2.0's Apache-2.0 forced_alignment.py implementation so
# Studio can cache transcript-independent emissions without changing KFA's
# alignment math. See THIRD_PARTY_NOTICES.md for attribution.

KFA_MODEL_ID = "wav2vec2-km-base-1500"
EMISSION_CACHE_VERSION = "kfa-emission-v1"
EMISSION_INTERVAL_SECONDS = 30
MAX_MEMORY_EMISSIONS = 8
MAX_DISK_EMISSION_FILES = 128
MAX_DISK_EMISSION_BYTES = 256 * 1024 * 1024

_kfa_session = None
_emission_memory = OrderedDict()
_whisper_cache_key = None
_whisper_cache_value = None


def log(message: str):
    print(message, file=sys.stderr, flush=True)


def read_transcript(path: str) -> str:
    text = Path(path).read_text(encoding="utf-8").strip()
    if not text:
        raise RuntimeError("Gemini transcript file was empty.")
    return text


def clamp01(value):
    try:
        return max(0.0, min(1.0, float(value)))
    except Exception:
        return None


def audio_identity(audio_path: Path) -> str:
    stat = audio_path.stat()
    inode = int(getattr(stat, "st_ino", 0) or 0)
    device = int(getattr(stat, "st_dev", 0) or 0)
    mtime_ns = int(getattr(stat, "st_mtime_ns", round(stat.st_mtime * 1_000_000_000)))
    ctime_ns = int(getattr(stat, "st_ctime_ns", round(stat.st_ctime * 1_000_000_000)))
    # Studio's cached WAVs are immutable once created. Hard-linked working files
    # retain inode + generation timestamps, so this identity survives legitimate
    # range-cache reuse while guarding against a filesystem reusing an old inode.
    if inode:
        raw = f"inode:{device}:{inode}:{stat.st_size}:{mtime_ns}:{ctime_ns}"
    else:
        raw = f"path:{audio_path.resolve()}:{stat.st_size}:{mtime_ns}:{ctime_ns}"
    return hashlib.sha256(f"{EMISSION_CACHE_VERSION}:{KFA_MODEL_ID}:{raw}".encode("utf-8")).hexdigest()[:32]


def emission_cache_path(cache_dir, key: str):
    if not cache_dir:
        return None
    directory = Path(str(cache_dir))
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{key}.npz"


def trim_disk_emission_cache(cache_dir, keep_path=None):
    if not cache_dir:
        return
    try:
        directory = Path(str(cache_dir))
        if not directory.exists():
            return
        entries = []
        for item in directory.glob("*.npz"):
            try:
                stat = item.stat()
                entries.append((item, stat.st_size, stat.st_mtime_ns))
            except OSError:
                continue
        entries.sort(key=lambda row: row[2], reverse=True)
        kept_files = 0
        kept_bytes = 0
        keep_resolved = Path(keep_path).resolve() if keep_path else None
        for item, size, _mtime in entries:
            is_current = keep_resolved is not None and item.resolve() == keep_resolved
            fits = kept_files < MAX_DISK_EMISSION_FILES and kept_bytes + size <= MAX_DISK_EMISSION_BYTES
            if is_current or fits:
                kept_files += 1
                kept_bytes += size
            else:
                try:
                    item.unlink(missing_ok=True)
                except OSError:
                    pass
    except Exception as error:
        log(f"KFA emission cache cleanup skipped: {type(error).__name__}: {error}")


def memory_emission_get(key: str):
    value = _emission_memory.get(key)
    if value is not None:
        _emission_memory.move_to_end(key)
    return value


def memory_emission_put(key: str, value):
    _emission_memory[key] = value
    _emission_memory.move_to_end(key)
    while len(_emission_memory) > MAX_MEMORY_EMISSIONS:
        _emission_memory.popitem(last=False)


def get_kfa_session():
    global _kfa_session
    if _kfa_session is None:
        from kfa import create_session

        log("Loading KFA Khmer ONNX session once for the local timing worker...")
        _kfa_session = create_session()
    return _kfa_session


def load_disk_emission(cache_path):
    if cache_path is None or not cache_path.exists():
        return None
    try:
        import numpy as np

        with np.load(str(cache_path), allow_pickle=False) as stored:
            emission = stored["emission"]
            sample_count = int(stored["sample_count"])
            sample_rate = int(stored["sample_rate"])
        now = None
        try:
            now = cache_path.stat().st_atime
            os.utime(cache_path, times=(now, __import__("time").time()))
        except OSError:
            pass
        if emission.ndim != 2 or sample_count < 1 or sample_rate < 1000:
            raise ValueError("cached emission shape/metadata is invalid")
        return emission, sample_count, sample_rate
    except Exception as error:
        log(f"Discarding invalid KFA emission cache {cache_path.name}: {type(error).__name__}: {error}")
        try:
            cache_path.unlink(missing_ok=True)
        except OSError:
            pass
        return None


def save_disk_emission(cache_path, emission, sample_count: int, sample_rate: int):
    if cache_path is None:
        return
    import numpy as np

    temp = cache_path.with_name(f"{cache_path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("wb") as handle:
            np.savez(handle, emission=emission, sample_count=sample_count, sample_rate=sample_rate)
        os.replace(temp, cache_path)
        trim_disk_emission_cache(cache_path.parent, keep_path=cache_path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def compute_kfa_emission(audio_path: Path, cache_dir=None):
    """Run the transcript-independent KFA acoustic model once per immutable WAV."""
    key = audio_identity(audio_path)
    cached = memory_emission_get(key)
    if cached is not None:
        log("KFA acoustic emission cache hit (memory).")
        return cached

    disk_path = emission_cache_path(cache_dir, key)
    cached = load_disk_emission(disk_path)
    if cached is not None:
        memory_emission_put(key, cached)
        log("KFA acoustic emission cache hit (disk).")
        return cached

    # This mirrors the acoustic stage of KFA 0.2.0's Apache-2.0
    # forced_alignment.align implementation, but stores the transcript-independent
    # log-probabilities so later alternative wording can reuse them.
    import librosa
    import numpy as np
    from scipy.special import log_softmax
    from kfa.utils import time_to_frame

    y, sr = librosa.load(str(audio_path), sr=16000, mono=True)
    if y is None or len(y) < 1600:
        raise RuntimeError("KFA received empty/too-short audio.")

    session = get_kfa_session()
    total_duration = y.shape[-1] / sr
    cursor = 0
    emissions_arr = []
    while cursor < total_duration:
        segment_start = cursor
        segment_end = cursor + EMISSION_INTERVAL_SECONDS
        context = EMISSION_INTERVAL_SECONDS * 0.1
        input_start = max(segment_start - context, 0)
        input_end = min(segment_end + context, total_duration)
        y_chunk = y[int(sr * input_start): int(sr * input_end)]
        emissions = session.run(None, {"input": [y_chunk]})[0][0]
        emission_start_frame = time_to_frame(segment_start)
        emission_end_frame = time_to_frame(segment_end)
        offset = time_to_frame(input_start)
        emissions_arr.append(emissions[emission_start_frame - offset: emission_end_frame - offset, :])
        cursor += EMISSION_INTERVAL_SECONDS

    if not emissions_arr:
        raise RuntimeError("KFA acoustic model produced no emissions.")
    emissions = np.concatenate(emissions_arr, axis=0).squeeze()
    emission = log_softmax(emissions, axis=-1)
    value = (emission, int(y.shape[-1]), int(sr))
    memory_emission_put(key, value)
    save_disk_emission(disk_path, emission, int(y.shape[-1]), int(sr))
    log(f"KFA acoustic emissions prepared: {emission.shape[0]} frames.")
    return value


def align_kfa_emission(emission, sample_count: int, sr: int, transcript: str):
    from kfa.text_normalize import tokenize_phonemize
    from kfa.utils import backtrack, get_trellis, intersperse, merge_repeats, merge_words, vocabs

    text_sequences = [
        item
        for line in transcript.split("\n") if line.strip()
        for item in tokenize_phonemize(line.strip())
    ]
    if not text_sequences:
        raise RuntimeError("KFA could not phonemize the transcript.")

    tokens = []
    texts = []
    spans = []
    for item in text_sequences:
        if len(item) == 2:
            if not spans:
                raise RuntimeError("KFA phonemizer returned an invalid leading continuation token.")
            spans[-1] += 1
            continue
        spans.append(0)
        tokens.append(item[2])
        texts.append(item[1])

    blank_id = vocabs["[PAD]"]
    phonetic_text = "".join(intersperse(texts, "|"))
    token_ids = [value for group in intersperse(tokens, [vocabs["|"]]) for value in group]
    if not token_ids:
        raise RuntimeError("KFA produced no transcript tokens for alignment.")

    trellis = get_trellis(emission, token_ids, blank_id=blank_id)
    path = backtrack(trellis, emission, token_ids, blank_id=blank_id)
    segments = merge_repeats(path, phonetic_text)
    word_segments = merge_words(segments)
    if not word_segments:
        raise RuntimeError("KFA produced no word segments.")

    rows = []
    second_start = 0
    for index, word in enumerate(word_segments):
        ratio = sample_count / trellis.shape[0]
        actual_second_start = ratio * word.start / sr
        second_end = ratio * word.end / sr
        actual_second_end = second_end
        if index < len(word_segments) - 1:
            second_end = max(ratio * word_segments[index + 1].start / sr, second_end)
        seq_idx = sum(spans[0:index]) + index
        span_size = spans[index]
        text_segment = "".join(
            item[0] for item in text_sequences[seq_idx: seq_idx + span_size + 1]
        )
        rows.append((
            text_segment,
            second_start,
            second_end,
            actual_second_start,
            actual_second_end,
            word.score,
        ))
        second_start = second_end
    return rows


def run_kfa(audio_path: Path, transcript: str, emission_cache_dir=None):
    """Force-align Gemini's Khmer transcript directly onto cached acoustic evidence."""
    log("Trying KFA Khmer forced alignment (local ONNX / CPU)...")
    emission, sample_count, sr = compute_kfa_emission(audio_path, emission_cache_dir)
    rows = align_kfa_emission(emission, sample_count, sr, transcript)
    words = []
    duration_ms = round(sample_count / sr * 1000)

    for row in rows:
        if not isinstance(row, (tuple, list)) or len(row) < 6:
            continue
        text_segment, _padded_start, _padded_end, actual_start, actual_end, score = row[:6]
        raw = str(text_segment or "").strip()
        if not raw:
            continue
        start_ms = max(0, min(duration_ms, round(float(actual_start) * 1000)))
        end_ms = min(duration_ms, max(start_ms + 20, round(float(actual_end) * 1000)))
        if end_ms <= start_ms:
            continue
        item = {"text": raw, "startMs": start_ms, "endMs": end_ms}
        conf = clamp01(score)
        if conf is not None:
            item["confidence"] = conf
        words.append(item)

    if not words:
        raise RuntimeError("KFA produced no usable word alignments.")

    transcript_chars = len("".join(transcript.split()))
    aligned_chars = sum(len("".join(word["text"].split())) for word in words)
    char_coverage = aligned_chars / max(1, transcript_chars)
    if char_coverage < 0.35:
        raise RuntimeError(f"KFA alignment covered only {char_coverage:.0%} of transcript characters.")

    log(f"KFA complete: {len(words)} forced word anchors ({char_coverage:.0%} rough text coverage).")
    return {
        "transcript": transcript,
        "words": words,
        "engine": "kfa-local",
        "provider": "local",
        "model": KFA_MODEL_ID,
        "device": "cpu",
        "computeType": "onnxruntime",
        "directAlignment": True,
    }


def choose_device(requested: str):
    requested = requested.lower()
    if requested in {"cpu", "cuda"}:
        return requested
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


def compute_type_for(device: str, requested: str):
    if requested.lower() != "auto":
        return requested
    return "float16" if device == "cuda" else "int8"


def load_whisper_model(model_name: str, requested_device: str, requested_compute: str):
    global _whisper_cache_key, _whisper_cache_value
    requested_key = (model_name, requested_device.lower(), requested_compute.lower())
    if _whisper_cache_key == requested_key and _whisper_cache_value is not None:
        log(f"Reusing faster-whisper fallback '{model_name}' from memory.")
        return _whisper_cache_value

    from faster_whisper import WhisperModel

    device = choose_device(requested_device)
    compute_type = compute_type_for(device, requested_compute)
    try:
        log(f"Loading faster-whisper fallback '{model_name}' on {device}/{compute_type}...")
        value = (WhisperModel(model_name, device=device, compute_type=compute_type), device, compute_type)
    except Exception as error:
        if requested_device.lower() == "auto" and device == "cuda":
            log(f"CUDA fallback initialization failed; retrying CPU/int8. Details: {error}")
            device = "cpu"
            compute_type = "int8" if requested_compute.lower() == "auto" else requested_compute
            value = (WhisperModel(model_name, device=device, compute_type=compute_type), device, compute_type)
        else:
            raise
    _whisper_cache_key = requested_key
    _whisper_cache_value = value
    return value


def run_faster_whisper(audio_path: Path, args, kfa_error: str):
    """Local-only ASR fallback. It supplies timing text; Gemini still owns final wording."""
    log(f"KFA could not be used for this clip. Falling back to local faster-whisper. Reason: {kfa_error}")
    model, device, compute_type = load_whisper_model(args.model, args.device, args.compute_type)

    segments, info = model.transcribe(
        str(audio_path),
        language=args.language,
        task="transcribe",
        beam_size=args.beam_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": args.vad_min_silence_ms},
        condition_on_previous_text=False,
    )

    words = []
    transcript_parts = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            transcript_parts.append(text)
        for word in segment.words or []:
            raw = (word.word or "").strip()
            if not raw or word.start is None or word.end is None:
                continue
            start_ms = max(0, round(float(word.start) * 1000))
            end_ms = max(start_ms + 20, round(float(word.end) * 1000))
            probability = getattr(word, "probability", None)
            item = {"text": raw, "startMs": start_ms, "endMs": end_ms}
            if probability is not None:
                item["confidence"] = clamp01(probability)
            words.append(item)

    if not words:
        raise RuntimeError("faster-whisper fallback returned no word timing anchors.")

    log(f"faster-whisper fallback complete: {len(words)} word anchors.")
    return {
        "transcript": " ".join(transcript_parts).strip() or " ".join(word["text"] for word in words),
        "words": words,
        "engine": "faster-whisper-local",
        "provider": "local",
        "model": args.model,
        "device": device,
        "computeType": compute_type,
        "detectedLanguage": getattr(info, "language", None),
        "languageProbability": getattr(info, "language_probability", None),
        "fallbackReason": kfa_error,
        "directAlignment": False,
    }


def options_namespace(options):
    return SimpleNamespace(
        disable_kfa=bool(options.get("disableKfa", False)),
        disable_whisper_fallback=bool(options.get("disableWhisperFallback", False)),
        model=str(options.get("model") or "turbo"),
        device=str(options.get("device") or "auto"),
        compute_type=str(options.get("computeType") or "auto"),
        language=str(options.get("language") or "km"),
        beam_size=max(1, int(options.get("beamSize") or 5)),
        vad_min_silence_ms=max(100, int(options.get("vadMinSilenceMs") or 400)),
        emission_cache_dir=options.get("emissionCacheDir"),
    )


def process_alignment(audio_path: Path, transcript: str, args):
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio not found: {audio_path}")
    if not transcript.strip():
        raise RuntimeError("Gemini transcript was empty.")

    payload = None
    kfa_error = "KFA disabled by configuration"
    if not args.disable_kfa:
        try:
            payload = run_kfa(audio_path, transcript, args.emission_cache_dir)
        except Exception as error:
            kfa_error = f"{type(error).__name__}: {error}"
            log(f"KFA alignment failed: {kfa_error}")

    if payload is None:
        if args.disable_whisper_fallback:
            raise RuntimeError(f"KFA failed and local Whisper fallback is disabled. {kfa_error}")
        payload = run_faster_whisper(audio_path, args, kfa_error)
    return payload


def process_server_request(request):
    action = str(request.get("action") or "align")
    options = options_namespace(request.get("options") or {})
    if action == "warm":
        if not options.disable_kfa:
            get_kfa_session()
        return {"ready": True}
    if action == "prepare":
        audio = Path(str(request.get("audio") or ""))
        if not audio.exists():
            raise FileNotFoundError(f"Audio not found: {audio}")
        if options.disable_kfa:
            return {"prepared": False, "reason": "KFA disabled"}
        compute_kfa_emission(audio, options.emission_cache_dir)
        return {"prepared": True}
    if action != "align":
        raise ValueError(f"Unsupported local timing action: {action}")
    audio = Path(str(request.get("audio") or ""))
    transcript = str(request.get("transcript") or "").strip()
    return process_alignment(audio, transcript, options)


def serve():
    log("Persistent local timing worker ready.")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            request_id = str(request.get("id") or "")
            if not request_id:
                raise ValueError("request id is required")
            # Third-party libraries occasionally print informational messages to
            # stdout. Redirect them to stderr so stdout remains a strict JSON-line
            # protocol for the Node parent process.
            with contextlib.redirect_stdout(sys.stderr):
                result = process_server_request(request)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            response = {
                "id": request_id,
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def cli_args():
    parser = argparse.ArgumentParser(description="Local Khmer timing worker for Sthang Studio Captions")
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--audio")
    parser.add_argument("--transcript-file")
    parser.add_argument("--output")
    parser.add_argument("--disable-kfa", action="store_true")
    parser.add_argument("--disable-whisper-fallback", action="store_true")
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default="km")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-min-silence-ms", type=int, default=400)
    parser.add_argument("--emission-cache-dir")
    return parser.parse_args()


def run_cli(args):
    if not args.audio or not args.transcript_file or not args.output:
        raise RuntimeError("--audio, --transcript-file and --output are required outside --server mode.")
    audio = Path(args.audio)
    transcript = read_transcript(args.transcript_file)
    args.emission_cache_dir = args.emission_cache_dir or None
    payload = process_alignment(audio, transcript, args)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def main():
    args = cli_args()
    if args.server:
        serve()
    else:
        run_cli(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"LOCAL_TIMING_ERROR: {error}", file=sys.stderr, flush=True)
        raise
