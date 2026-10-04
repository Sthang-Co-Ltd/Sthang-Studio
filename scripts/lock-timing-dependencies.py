"""Generate/recheck reviewed timing hashes and dependency metadata from official PyPI.

This does not choose new versions: edit/review locks/versions.json first. Native
artifact tags and metadata are checked here; native execution remains a separate
Windows/macOS release gate. Only emoji 2.6.0 may use its pure-Python source archive.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import urllib.request

try:
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
    from packaging.tags import compatible_tags, cpython_tags, mac_platforms
    from packaging.utils import canonicalize_name, parse_wheel_filename
except ImportError:  # pip is available even before the timing tooling is installed.
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.specifiers import SpecifierSet
    from pip._vendor.packaging.tags import compatible_tags, cpython_tags, mac_platforms
    from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parent.parent
LOCKS = ROOT / "local-timing/locks"
TARGET_PYTHON = "3.12.15"
PROFILES = ("windows-py312-x64", "macos-legacy-py312-arm64", "macos-modern-py312-arm64")


def profile_environment(profile):
    environment = default_environment()
    windows = profile == "windows-py312-x64"
    environment.update(python_version="3.12", python_full_version=TARGET_PYTHON, implementation_name="cpython",
                       implementation_version=TARGET_PYTHON, platform_python_implementation="CPython", extra="",
                       sys_platform="win32" if windows else "darwin", os_name="nt" if windows else "posix",
                       platform_system="Windows" if windows else "Darwin", platform_machine="AMD64" if windows else "arm64")
    return environment


def profile_tags(profile):
    if profile == "windows-py312-x64":
        platforms = ["win_amd64"]
    else:
        platforms = list(mac_platforms((12, 3) if "legacy" in profile else (14, 0), "arm64"))
    return set(cpython_tags((3, 12), abis=["cp312"], platforms=platforms)) | set(compatible_tags((3, 12), interpreter="cp312", platforms=platforms))


def select_artifacts(name, version, files, profile):
    tags = profile_tags(profile)
    selected = []
    for artifact in files:
        filename = artifact["filename"]
        if artifact.get("yanked"):
            continue
        if artifact.get("requires_python") and TARGET_PYTHON not in SpecifierSet(artifact["requires_python"]):
            continue
        if artifact["packagetype"] == "bdist_wheel":
            wheel_name, wheel_version, _, wheel_tags = parse_wheel_filename(filename)
            if canonicalize_name(name) != wheel_name or str(wheel_version) != version or not tags.intersection(wheel_tags):
                continue
        elif not (name == "emoji" and version == "2.6.0" and artifact["packagetype"] == "sdist" and filename == "emoji-2.6.0.tar.gz"):
            continue
        if not artifact["url"].startswith("https://files.pythonhosted.org/"):
            raise RuntimeError(f"Non-PyPI artifact URL: {filename}")
        digest = artifact["digests"]["sha256"]
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise RuntimeError(f"Invalid SHA256: {filename}")
        selected.append({"filename": filename, "sha256": digest, "url": artifact["url"]})
    if not selected:
        raise RuntimeError(f"No reviewed CPython 3.12 artifact for {name}=={version} on {profile}")
    return sorted(selected, key=lambda artifact: artifact["filename"])


def permitted_mismatch(profile, name, version, dependency, installed):
    # Overrides are local to these exact two dependency edges, never global.
    edge = (name, version, canonicalize_name(dependency.name), str(dependency.specifier), installed)
    return edge == ("kfa", "0.2.0", "sosap", "==0.0.1", "0.4.3") or (
        profile.startswith("macos-") and edge == ("khmercut", "0.0.2", "python-crfsuite", "==0.9.9", "0.9.11"))


def verify_graph(profile, versions, metadata):
    """Check every active Requires-Dist edge, including recursively requested extras."""
    environment = profile_environment(profile)
    extras = {name: {""} for name in versions}
    changed = True
    while changed:
        changed = False
        for name, version in versions.items():
            release = metadata[f"{name}=={version}"]
            if release["requires_python"] and environment["python_full_version"] not in SpecifierSet(release["requires_python"]):
                raise RuntimeError(f"{name}=={version} excludes CPython 3.12")
            for text in release["requires_dist"]:
                dependency = Requirement(text)
                if dependency.marker and not any(dependency.marker.evaluate({**environment, "extra": extra}) for extra in extras[name]):
                    continue
                dep_name = canonicalize_name(dependency.name)
                installed = versions.get(dep_name)
                if installed is None:
                    raise RuntimeError(f"{profile}: {name}=={version} requires missing {text}")
                if dependency.url or (installed not in dependency.specifier and not permitted_mismatch(profile, name, version, dependency, installed)):
                    raise RuntimeError(f"{profile}: {name}=={version} requires {text}, locked {installed}")
                newly_requested = dependency.extras - extras[dep_name]
                if newly_requested:
                    extras[dep_name].update(newly_requested)
                    changed = True


def fetch_release(pair):
    name, version = pair
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(url, timeout=90) as response:
        release = json.load(response)
    if canonicalize_name(release["info"]["name"]) != name or release["info"]["version"] != version:
        raise RuntimeError(f"Unexpected PyPI release identity at {url}")
    return f"{name}=={version}", {
        "source": url,
        "requires_python": release["info"].get("requires_python") or "",
        "requires_dist": release["info"].get("requires_dist") or [],
    }, release["urls"]


def render_lock(profile, versions, metadata, files):
    lines = [f"# Reviewed CPython 3.12 lock: {profile}",
             "# Generated by scripts/lock-timing-dependencies.py from versions.json and official PyPI.",
             "# Install with --no-deps --require-hashes; see local-timing/locks/README.md."]
    artifacts = {}
    for name, version in sorted(versions.items()):
        key = f"{name}=={version}"
        candidates = select_artifacts(name, version, files[key], "windows-py312-x64" if profile == "tooling" else profile)
        artifacts[key] = candidates
        lines.append(key + " \\")
        for index, digest in enumerate(sorted({row["sha256"] for row in candidates})):
            count = len({row["sha256"] for row in candidates})
            lines.append(f"    --hash=sha256:{digest}" + (" \\" if index < count - 1 else ""))
    return "\n".join(lines) + "\n", artifacts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Re-fetch PyPI metadata and fail if committed locks/provenance differ")
    parser.add_argument("--download-dir", type=Path, help="Also download all locked target artifacts and verify their actual SHA256 bytes")
    args = parser.parse_args()
    manifest = json.loads((LOCKS / "versions.json").read_text())
    if manifest.get("schema") != 1 or manifest.get("python") != "3.12" or manifest.get("targetPython") != TARGET_PYTHON or set(manifest["profiles"]) != set(PROFILES):
        raise RuntimeError("Unsupported timing version manifest")
    groups = {"tooling": manifest["tooling"], **manifest["profiles"]}
    pairs = sorted({(name, version) for versions in groups.values() for name, version in versions.items()})
    metadata, files = {}, {}
    with ThreadPoolExecutor(max_workers=12) as pool:
        for key, release, artifacts in pool.map(fetch_release, pairs):
            metadata[key], files[key] = release, artifacts
    outputs, inventory = {}, {"schema": 1, "metadata": dict(sorted(metadata.items())), "artifacts": {}}
    for profile, versions in groups.items():
        verify_graph("windows-py312-x64" if profile == "tooling" else profile, {**manifest["tooling"], **versions}, metadata)
        contents, artifacts = render_lock(profile, versions, metadata, files)
        outputs[LOCKS / f"{profile}.txt"] = contents
        inventory["artifacts"][profile] = artifacts
    outputs[LOCKS / "manifest.json"] = json.dumps({"schemaVersion": 1, "files": [
        {"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest()}
        for path, contents in sorted(outputs.items())
    ]}, indent=2) + "\n"
    outputs[LOCKS / "pypi-metadata.json"] = json.dumps(inventory, indent=2, sort_keys=True) + "\n"
    for filename, contents in outputs.items():
        if args.check:
            if not filename.is_file() or filename.read_text(encoding="utf-8") != contents:
                raise RuntimeError(f"Lock/provenance differs: {filename.name}")
        else:
            filename.write_text(contents, encoding="utf-8", newline="\n")
    if args.download_dir:
        args.download_dir.mkdir(parents=True, exist_ok=True)
        all_artifacts = {row["filename"]: row for profile in inventory["artifacts"].values() for rows in profile.values() for row in rows}
        def download(artifact):
            path = args.download_dir / artifact["filename"]
            if not path.exists():
                with urllib.request.urlopen(artifact["url"], timeout=180) as response:
                    data = response.read()
                if hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                    raise RuntimeError(f"Artifact SHA256 mismatch: {artifact['filename']}")
                path.write_bytes(data)
            if hashlib.sha256(path.read_bytes()).hexdigest() != artifact["sha256"]:
                raise RuntimeError(f"Artifact SHA256 mismatch: {path.name}")
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(download, all_artifacts.values()))
        print(f"Verified actual SHA256 bytes of {len(all_artifacts)} target artifacts.")
    print(f"Verified {len(pairs)} exact releases against official PyPI metadata and three platform dependency graphs.")


if __name__ == "__main__":
    main()
