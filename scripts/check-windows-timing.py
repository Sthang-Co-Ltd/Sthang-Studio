"""Fail-closed updater readiness check; normal/manual setup keeps Whisper fallback."""
import importlib
from importlib.metadata import version
from pathlib import Path
import subprocess
import sys

ALLOWED_METADATA_ERROR = "kfa 0.2.0 has requirement sosap==0.0.1, but you have sosap 0.4.3."


def dependency_errors(returncode, output):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if returncode == 0 and lines == ["No broken requirements found."]:
        return []
    errors = [line for line in lines if line.lower() != ALLOWED_METADATA_ERROR]
    if returncode not in (0, 1) or not lines:
        errors.append("pip check did not return usable dependency evidence.")
    return errors


def check_ready():
    for name, expected in (("kfa", "0.2.0"), ("khmercut", "0.0.2"),
                           ("python-crfsuite", "0.9.9"), ("tqdm", "4.65.0"), ("sosap", "0.4.3")):
        if version(name) != expected:
            raise RuntimeError(f"The required {name} version is not prepared.")
    result = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True,
                            text=True, check=False, timeout=90)
    if dependency_errors(result.returncode, result.stdout + "\n" + result.stderr):
        raise RuntimeError("The local timing dependency check failed.")
    # Check cached weights BEFORE importing kfa, whose import can download them.
    from appdirs import user_cache_dir
    model = Path(user_cache_dir()) / "kfa/wav2vec2-km-base-1500.onnx"
    if not model.is_file() or model.stat().st_size == 0:
        raise RuntimeError("The local Khmer model has not been prepared.")
    for name in ("onnxruntime", "khmernormalizer", "faster_whisper", "kfa"):
        importlib.import_module(name)
    from khmercut import tokenize
    from sosap import Model
    if not callable(tokenize) or Model is None or not tokenize("ភាសាខ្មែរ"):
        raise RuntimeError("The Khmer tokenizer is not ready.")
    # Use the real pinned runtime entry point, verifying its model and auxiliary
    # assets are usable. This does not load the lazy Whisper fallback weights.
    from kfa import create_session
    session = create_session()
    if not session.get_inputs() or not session.get_outputs():
        raise RuntimeError("The Khmer timing model is not ready.")


if __name__ == "__main__":
    try:
        check_ready()
        print("KFA + Whisper timing environment: READY")
    except Exception:
        print("ERROR: Required local Khmer timing preparation failed.", file=sys.stderr)
        sys.exit(1)
