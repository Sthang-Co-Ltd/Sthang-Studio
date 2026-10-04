"""Validate the Mac timing environment; imports only enforce telemetry opt-out."""
import argparse
import importlib
import importlib.util
import os
from importlib.metadata import version
from pathlib import Path
import platform
import sys

# Required before ONNX or a transitive importer initializes its native library.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"


# Load relative to this script, so direct execution, importlib tests and callers
# from a different working directory all share the same strict policy.
_spec = importlib.util.spec_from_file_location("studio_timing_dependencies", Path(__file__).with_name("check-timing-dependencies.py"))
_dependencies = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_dependencies)
ALLOWED_METADATA_ERRORS = _dependencies.allowed_metadata_errors("macos-legacy-py312-arm64")


def dependency_errors(returncode, output):
    return _dependencies.dependency_errors(returncode, output, "macos-legacy-py312-arm64")


def check_versions(root, major, lookup=version):
    profile = "macos-legacy-py312-arm64" if major < 14 else "macos-modern-py312-arm64"
    _dependencies.check_versions(root, profile, lookup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready", action="store_true", help="Require an already-cached model before any imports that could download it")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64" or sys.version_info[:2] != (3, 12):
        raise RuntimeError("Native Apple Silicon Python 3.12 is required.")
    macos = tuple(int(part) for part in platform.mac_ver()[0].split("."))
    major = macos[0]
    if macos < (12, 3):
        raise RuntimeError("macOS 12.3 Monterey or newer is required.")
    root = Path(__file__).resolve().parent.parent
    profile = "macos-legacy-py312-arm64" if major < 14 else "macos-modern-py312-arm64"
    _dependencies.validate_host(profile)
    _dependencies.check_dependencies(root, profile)

    from appdirs import user_cache_dir
    model = Path(user_cache_dir()) / "kfa/wav2vec2-km-base-1500.onnx"
    if args.ready and not model.is_file():
        raise RuntimeError("The local Khmer model has not been prepared.")
    # find_spec is insufficient: a present extension can still fail to load on an
    # older macOS. These imports load the real native libraries, not Whisper weights.
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    for name in ("numpy", "scipy.signal", "sklearn", "numba", "librosa", "soundfile", "soxr", "onnxruntime", "av", "ctranslate2", "khmernormalizer", "faster_whisper", "kfa"):
        importlib.import_module(name)
    from khmercut import tokenize
    from sosap import Model
    if not callable(tokenize) or Model is None or not model.is_file():
        raise RuntimeError("KFA tokenizer/model preparation did not complete.")
    if not tokenize("ភាសាខ្មែរ"):
        raise RuntimeError("The native Khmer tokenizer smoke check failed.")
    # Importability alone does not prove an older ONNX runtime can open the
    # actual KFA graph. Check that during setup, never during normal launch.
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    session = onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    if not session.get_inputs() or not session.get_outputs():
        raise RuntimeError("The KFA ONNX model has no usable inputs/outputs.")
    print("KFA + Whisper timing environment: READY (native imports, dependency profile and KFA model checked)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: Local timing validation failed: {error}", file=sys.stderr)
        sys.exit(1)
