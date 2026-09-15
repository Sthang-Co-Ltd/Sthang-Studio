"""Validate the Mac timing environment; importing this module has no side effects."""
import argparse
import importlib
from importlib.metadata import version
from pathlib import Path
import platform
import subprocess
import sys


ALLOWED_METADATA_ERRORS = frozenset({
    "kfa 0.2.0 has requirement sosap==0.0.1, but you have sosap 0.4.3.",
    "khmercut 0.0.2 has requirement python-crfsuite==0.9.9, but you have python-crfsuite 0.9.11.",
})


def dependency_errors(returncode, output):
    """Ignore only the two reviewed upstream metadata mismatches, not pip errors."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if returncode == 0 and lines == ["No broken requirements found."]:
        return []
    unexpected = [line for line in lines if line.lower() not in ALLOWED_METADATA_ERRORS]
    if returncode not in (0, 1) or not lines:
        unexpected.append(f"pip check failed without usable dependency evidence (exit {returncode}).")
    return unexpected


def check_versions(root, major, lookup=version):
    from packaging.requirements import Requirement

    files = [root / "local-timing/requirements-kfa-macos.txt", root / "local-timing/requirements-whisper.txt"]
    if major < 14:
        files.append(root / "local-timing/constraints-macos-legacy.txt")
    requirements = ["kfa==0.2.0", "khmercut==0.0.2"]
    if major >= 14:
        requirements.append("onnxruntime>=1.20,<2.0")
    for filename in files:
        requirements.extend(line.split("#", 1)[0].strip() for line in filename.read_text(encoding="utf-8").splitlines())
    for text in filter(None, requirements):
        requirement = Requirement(text)
        installed = lookup(requirement.name)
        if installed not in requirement.specifier:
            raise RuntimeError(f"{requirement.name} {installed} does not satisfy {requirement.specifier}")


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
    check_versions(root, major)
    result = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True, text=True, check=False)
    errors = dependency_errors(result.returncode, result.stdout + "\n" + result.stderr)
    if errors:
        raise RuntimeError("\n".join(errors))

    from appdirs import user_cache_dir
    model = Path(user_cache_dir()) / "kfa/wav2vec2-km-base-1500.onnx"
    if args.ready and not model.is_file():
        raise RuntimeError("The local Khmer model has not been prepared.")
    # find_spec is insufficient: a present extension can still fail to load on an
    # older macOS. These imports load the real native libraries, not Whisper weights.
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
    import onnxruntime
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
