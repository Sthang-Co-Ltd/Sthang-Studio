"""Verify one reviewed CPython 3.12 timing lock; never downloads model weights."""
import argparse
from importlib.metadata import distributions, version
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys

PROFILES = ("windows-py312-x64", "macos-legacy-py312-arm64", "macos-modern-py312-arm64")
KFA_METADATA_ERROR = "kfa 0.2.0 has requirement sosap==0.0.1, but you have sosap 0.4.3."
MAC_METADATA_ERROR = "khmercut 0.0.2 has requirement python-crfsuite==0.9.9, but you have python-crfsuite 0.9.11."
PIN = re.compile(r"([a-z0-9][a-z0-9._-]*)==([A-Za-z0-9.!+_-]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)")


def allowed_metadata_errors(profile):
    if profile not in PROFILES:
        raise ValueError(f"Unknown timing profile: {profile}")
    return frozenset((KFA_METADATA_ERROR, MAC_METADATA_ERROR) if profile.startswith("macos-") else (KFA_METADATA_ERROR,))


def dependency_errors(returncode, output, profile):
    """Accept actual pip success or only the exact reviewed upstream mismatches."""
    allowed = allowed_metadata_errors(profile)
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if returncode == 0 and lines == ["No broken requirements found."]:
        return []
    unexpected = [line for line in lines if line.lower() not in allowed]
    if returncode != 1 or not lines:
        unexpected.append(f"pip check failed without usable dependency evidence (exit {returncode}).")
    return unexpected


def read_lock(filename):
    """Reject options/includes/unpinned entries rather than silently skipping them."""
    contents = filename.read_text(encoding="utf-8").replace("\\\n", " ")
    result = {}
    for line in contents.splitlines():
        text = line.split("#", 1)[0].strip()
        if not text:
            continue
        match = PIN.fullmatch(text)
        if not match:
            raise RuntimeError(f"Invalid hash-locked requirement in {filename.name}: {text}")
        name, value = match.group(1, 2)
        name = re.sub(r"[-_.]+", "-", name).lower()
        if name in result:
            raise RuntimeError(f"Duplicate locked package: {name}")
        result[name] = value
    if not result:
        raise RuntimeError(f"Empty dependency lock: {filename.name}")
    return result


def check_versions(root, profile, lookup=version):
    allowed_metadata_errors(profile)  # Validate before using the profile as a filename.
    locks = root / "local-timing/locks"
    packages = read_lock(locks / "tooling.txt")
    for name, expected in read_lock(locks / f"{profile}.txt").items():
        if name in packages and packages[name] != expected:
            raise RuntimeError(f"Runtime/tooling lock disagreement for {name}")
        packages[name] = expected
    for name, expected in packages.items():
        installed = lookup(name)
        if installed != expected:
            raise RuntimeError(f"{name} {installed} does not match reviewed {profile} lock ({expected})")


def validate_host(profile):
    allowed_metadata_errors(profile)
    if platform.python_implementation() != "CPython" or sys.version_info[:2] != (3, 12) or struct.calcsize("P") != 8:
        raise RuntimeError("Native 64-bit CPython 3.12 is required for the reviewed timing locks.")
    if profile == "windows-py312-x64":
        if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
            raise RuntimeError("The Windows timing lock requires native x64 Windows.")
        return
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("The macOS timing locks require native Apple Silicon.")
    macos = tuple(int(part) for part in platform.mac_ver()[0].split("."))
    if macos < (12, 3):
        raise RuntimeError("macOS 12.3 Monterey or newer is required.")
    expected = "macos-legacy-py312-arm64" if macos[0] < 14 else "macos-modern-py312-arm64"
    if profile != expected:
        raise RuntimeError(f"This macOS version requires the {expected} profile.")


def check_dependencies(root, profile):
    check_versions(root, profile)
    locks = root / "local-timing/locks"
    expected = set(read_lock(locks / "tooling.txt")) | set(read_lock(locks / f"{profile}.txt"))
    installed = {re.sub(r"[-_.]+", "-", item.metadata["Name"]).lower() for item in distributions()}
    unexpected = installed - expected
    if unexpected:
        raise RuntimeError("Unreviewed packages in the timing environment: " + ", ".join(sorted(unexpected)))
    result = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True, text=True, check=False)
    errors = dependency_errors(result.returncode, result.stdout + "\n" + result.stderr, profile)
    if errors:
        raise RuntimeError("\n".join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, choices=PROFILES)
    args = parser.parse_args()
    validate_host(args.profile)
    check_dependencies(Path(__file__).resolve().parent.parent, args.profile)
    print(f"Reviewed timing dependencies verified: {args.profile} (functional/model check still required)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: Local timing dependency validation failed: {error}", file=sys.stderr)
        sys.exit(1)
