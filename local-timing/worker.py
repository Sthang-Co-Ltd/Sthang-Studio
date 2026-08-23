import argparse
import json
import sys
from pathlib import Path


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


def run_kfa(audio_path: Path, transcript: str):
    """Force-align Gemini's Khmer transcript directly onto the waveform."""
    log("Trying KFA Khmer forced alignment (local ONNX / CPU)...")
    # KFA downloads its Khmer Wav2Vec2 ONNX model into the user's cache on first import/use.
    from kfa import align, create_session
    import librosa

    y, sr = librosa.load(str(audio_path), sr=16000, mono=True)
    if y is None or len(y) < 1600:
        raise RuntimeError("KFA received empty/too-short audio.")

    session = create_session()
    rows = list(align(y, sr, transcript, session=session, silent=True))
    words = []
    duration_ms = round(len(y) / sr * 1000)

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

    # Guard against a pathological partial alignment being accepted as success.
    # This is deliberately loose because Khmer segmentation boundaries vary.
    transcript_chars = len("".join(transcript.split()))
    aligned_chars = sum(len("".join(w["text"].split())) for w in words)
    char_coverage = aligned_chars / max(1, transcript_chars)
    if char_coverage < 0.35:
        raise RuntimeError(f"KFA alignment covered only {char_coverage:.0%} of transcript characters.")

    log(f"KFA complete: {len(words)} forced word anchors ({char_coverage:.0%} rough text coverage).")
    return {
        "transcript": transcript,
        "words": words,
        "engine": "kfa-local",
        "provider": "local",
        "model": "wav2vec2-km-base-1500",
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
    from faster_whisper import WhisperModel

    device = choose_device(requested_device)
    compute_type = compute_type_for(device, requested_compute)
    try:
        log(f"Loading faster-whisper fallback '{model_name}' on {device}/{compute_type}...")
        return WhisperModel(model_name, device=device, compute_type=compute_type), device, compute_type
    except Exception as error:
        if requested_device.lower() == "auto" and device == "cuda":
            log(f"CUDA fallback initialization failed; retrying CPU/int8. Details: {error}")
            device = "cpu"
            compute_type = "int8" if requested_compute.lower() == "auto" else requested_compute
            return WhisperModel(model_name, device=device, compute_type=compute_type), device, compute_type
        raise


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
        "transcript": " ".join(transcript_parts).strip() or " ".join(w["text"] for w in words),
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


def main():
    parser = argparse.ArgumentParser(description="Local Khmer timing worker for Sthang Studio Captions")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--transcript-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--disable-kfa", action="store_true")
    parser.add_argument("--disable-whisper-fallback", action="store_true")
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default="km")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-min-silence-ms", type=int, default=400)
    args = parser.parse_args()

    audio = Path(args.audio)
    if not audio.exists():
        raise FileNotFoundError(f"Audio not found: {audio}")
    transcript = read_transcript(args.transcript_file)

    payload = None
    kfa_error = "KFA disabled by configuration"
    if not args.disable_kfa:
        try:
            payload = run_kfa(audio, transcript)
        except Exception as error:
            kfa_error = f"{type(error).__name__}: {error}"
            log(f"KFA alignment failed: {kfa_error}")

    if payload is None:
        if args.disable_whisper_fallback:
            raise RuntimeError(f"KFA failed and local Whisper fallback is disabled. {kfa_error}")
        payload = run_faster_whisper(audio, args, kfa_error)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"LOCAL_TIMING_ERROR: {error}", file=sys.stderr, flush=True)
        raise
