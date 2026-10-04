"""Prepare locked timing dependencies without modifying the working environment.

Environments remain at their creation path (venv entrypoints are not relocatable).
.venv is a symlink on macOS and a per-user directory junction on Windows. A
previous real directory or link is retained for rollback and manual recovery.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import uuid

os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["PYTHONUTF8"] = "1"
ROOT = Path(__file__).resolve().parent.parent
PROFILES = ("windows-py312-x64", "macos-legacy-py312-arm64", "macos-modern-py312-arm64")
PYTHON_PROBE = (
    'import platform,struct,sys; '
    'assert (3,12,15) <= sys.version_info[:3] < (3,13,0); '
    'assert struct.calcsize("P") == 8; '
    'assert platform.machine().lower() in '
    '( ("amd64","x86_64") if sys.platform == "win32" else ("arm64",) )'
)
WINDOWS_FUNCTIONAL_PROBE = '''
import os
from pathlib import Path
from importlib.metadata import version
import onnxruntime
onnxruntime.disable_telemetry_events()
import kfa, khmercut, khmernormalizer, faster_whisper
from khmercut import tokenize
from sosap import Model
assert callable(tokenize) and Model is not None
assert version("khmercut") == "0.0.2"
assert version("python-crfsuite") == "0.9.9"
assert version("tqdm") == "4.65.0"
assert version("sosap") == "0.4.3"
model = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "kfa" / "wav2vec2-km-base-1500.onnx"
if not model.is_file() or model.stat().st_size == 0:
    raise RuntimeError("KFA model preload did not produce a nonempty model cache")
if not tokenize("ភាសាខ្មែរ"):
    raise RuntimeError("The native Khmer tokenizer smoke check failed")
# Use KFA's own session factory, as the timing worker does. A present cache file
# and importable package do not prove the reviewed native stack can open it.
session = kfa.create_session()
if not session.get_inputs() or not session.get_outputs():
    raise RuntimeError("The KFA ONNX model has no usable inputs/outputs")
'''


def python_in(environment: Path) -> Path:
    return environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def validate(environment: Path, profile: str, *, ready=False):
    python = python_in(environment)
    run([python, "-c", PYTHON_PROBE])
    run([python, ROOT / "scripts/check-timing-dependencies.py", "--profile", profile])
    if profile.startswith("macos-"):
        command = [python, ROOT / "scripts/check-macos-timing.py"]
        if ready:
            command.append("--ready")
        run(command)
    else:
        # Avoid a download in the fast readiness path. Imports can preload KFA.
        if ready:
            model = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "kfa/wav2vec2-km-base-1500.onnx"
            if not model.is_file() or model.stat().st_size == 0:
                raise RuntimeError("The Khmer timing model is not cached yet or is empty")
        run([python, "-c", WINDOWS_FUNCTIONAL_PROBE])


def present(path: Path) -> bool:
    return os.path.lexists(path)


def make_link(target: Path, link: Path):
    if os.name == "nt":
        # cmd built-in directory junctions do not need Developer Mode or admin.
        # Reject cmd metacharacters rather than interpolating unsafe paths.
        if any(ch in str(target) + str(link) for ch in '\r\n"%'):
            raise RuntimeError("The installation path contains unsupported characters")
        run([os.environ.get("ComSpec", "cmd.exe"), "/d", "/v:off", "/c", f'mklink /J "{link}" "{target}"'])
    else:
        link.symlink_to(target, target_is_directory=True)


def remove_link(link: Path):
    # Never recurse through a junction into a candidate or retained environment.
    if os.name == "nt":
        os.rmdir(link)
    else:
        link.unlink()


def fsync_directory(path: Path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_json(path: Path, record):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)


def is_link(path: Path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def recover_activation(root: Path):
    journal = root / ".timing-transaction.json"
    if not journal.exists():
        return
    record = json.loads(journal.read_text(encoding="utf-8"))
    token = record.get("token", "")
    if record.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{32}", token):
        raise RuntimeError("The timing recovery record is invalid; retain all environment files")
    candidate = Path(record["candidate"])
    if candidate.parent.resolve() != environment_store().resolve():
        raise RuntimeError("The timing recovery candidate is outside Studio state")
    active = root / ".venv"
    backup = root / f".venv.rollback-{token}"
    pending = root / f".venv.pending-{token}"
    if present(backup) or not record.get("hadActive"):
        if present(active):
            if not is_link(active) or active.resolve() != candidate.resolve():
                raise RuntimeError("Timing recovery found an unexpected active environment; no files were removed")
            remove_link(active)
        if present(backup):
            backup.rename(active)
    elif not present(active):
        raise RuntimeError("Timing recovery could not find the previous environment; retain the recovery record")
    if present(pending):
        if not is_link(pending) or pending.resolve() != candidate.resolve():
            raise RuntimeError("Timing recovery found an unexpected pending link")
        remove_link(pending)
    fsync_directory(journal.parent)
    journal.unlink()
    fsync_directory(journal.parent)


def activate(candidate: Path, active: Path, profile: str):
    token = uuid.uuid4().hex
    link = active.with_name(f".venv.pending-{token}")
    backup = active.with_name(f".venv.rollback-{token}")
    journal = active.parent / ".timing-transaction.json"
    had_active = present(active)
    # The durable record precedes either rename. After interruption, the next
    # setup restores the old environment before doing any dependency work.
    atomic_json(journal, {"schemaVersion": 1, "token": token,
                          "candidate": str(candidate), "hadActive": had_active})
    try:
        make_link(candidate, link)
        if had_active:
            active.rename(backup)
        link.rename(active)
        validate(active, profile, ready=True)
    except BaseException:
        recover_activation(active.parent)
        raise
    fsync_directory(journal.parent)
    journal.unlink()
    fsync_directory(journal.parent)
    if had_active:
        print(f"Previous environment retained at {backup.name}")


@contextmanager
def setup_lock(root: Path):
    # OS-held locks release automatically on process death. Keep the inode in
    # place on exit, preventing a second installer from locking a different file.
    with (root / ".timing-setup.lock").open("a+b") as stream:
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("Another timing setup is running. Close it before retrying.") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def environment_store() -> Path:
    # This path must survive OTA staging-root renames. Virtualenv entrypoints
    # contain absolute paths, so never put their actual directory in OTA work/.
    if os.name == "nt":
        state = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Sthang Studio"
    else:
        state = Path(os.environ.get("STHANG_STUDIO_STATE_ROOT") or Path.home() / "Library/Application Support/Sthang Studio")
    state.mkdir(parents=True, exist_ok=True)
    state = state.resolve()
    base = state / ".timing-envs"
    if present(base) and (base.is_symlink() or base.resolve().parent != state):
        raise RuntimeError("The timing environment directory must stay inside Studio state")
    base.mkdir(exist_ok=True)
    return base


def verify_lock_manifest(root: Path):
    record = json.loads((root / "local-timing/locks/manifest.json").read_text(encoding="utf-8"))
    allowed = {f"local-timing/locks/{name}.txt" for name in (*PROFILES, "tooling")}
    files = record.get("files")
    if record.get("schemaVersion") != 1 or not isinstance(files, list) or len(files) != len(allowed):
        raise RuntimeError("The reviewed timing lock manifest is invalid")
    seen = set()
    for item in files:
        if not isinstance(item, dict) or item.get("path") not in allowed or item["path"] in seen:
            raise RuntimeError("The reviewed timing lock path is invalid")
        seen.add(item["path"])
        if not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))):
            raise RuntimeError("The reviewed timing lock hash is invalid")
        if hashlib.sha256((root / item["path"]).read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError("A reviewed timing lock failed manifest verification")


def provision(root: Path, profile: str):
    verify_lock_manifest(root)
    active = root / ".venv"
    locks = root / "local-timing/locks"
    tooling = locks / "tooling.txt"
    requirements = locks / f"{profile}.txt"
    # Read before touching runtime state, so incomplete packages fail closed.
    digest = hashlib.sha256(tooling.read_bytes() + b"\0" + requirements.read_bytes()).hexdigest()[:16]
    with setup_lock(root):
        recover_activation(root)
        if present(active):
            try:
                validate(active, profile, ready=True)
            except (OSError, RuntimeError, subprocess.CalledProcessError):
                print("Preparing the reviewed environment beside the existing one...")
            else:
                print("Local timing environment matches all reviewed locks and is READY.")
                return
        base = environment_store()
        candidate = base / f"{profile}-{digest}-{uuid.uuid4().hex}"
        # Keep the immutable creation path even after activation: entrypoints
        # contain absolute paths, including pip.exe on Windows and Mac shebangs.
        run([sys.executable, "-m", "venv", candidate])
        python = python_in(candidate)
        run([python, "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-deps", "--require-hashes", "--only-binary=:all:", "-r", tooling])
        # emoji 2.6.0 alone is an approved pure-Python sdist. Build isolation is
        # disabled so its build cannot resolve unreviewed tooling dependencies.
        run([python, "-m", "pip", "install", "--isolated", "--disable-pip-version-check", "--no-deps", "--require-hashes", "--only-binary=:all:", "--no-binary=emoji", "--no-build-isolation", "-r", requirements])
        validate(candidate, profile)
        activate(candidate, active, profile)
        print("Local timing setup complete; reviewed dependencies and model are READY.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, choices=PROFILES)
    args = parser.parse_args()
    if not ((3, 12, 15) <= sys.version_info[:3] < (3, 13, 0)):
        raise RuntimeError("Reviewed Python 3.12.15 or newer 3.12 patch is required")
    machine = platform.machine().lower()
    if args.profile.startswith("windows-"):
        if sys.platform != "win32" or machine not in ("amd64", "x86_64"):
            raise RuntimeError("Native x64 Windows Python is required")
    else:
        if sys.platform != "darwin" or machine != "arm64":
            raise RuntimeError("Native Apple Silicon Python is required")
        version = tuple(map(int, platform.mac_ver()[0].split(".")))
        expected = "macos-legacy-py312-arm64" if version[0] < 14 else "macos-modern-py312-arm64"
        if version < (12, 3) or args.profile != expected:
            raise RuntimeError("The timing profile does not support this macOS version")
    provision(ROOT, args.profile)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: Timing setup failed. Retain existing environments and any recovery record. {exc}", file=sys.stderr)
        sys.exit(1)
