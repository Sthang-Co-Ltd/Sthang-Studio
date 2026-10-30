#!/usr/bin/env python3
"""Manual native Mac release checks; never issues, signs or promotes an OTA offer.

The candidate may be a precisely selected *draft* GitHub release whose commit is
still on a reviewed release branch. Signing and public main acceptance are separate
operations. All actual installer/runtime work runs on native Apple Silicon in an
isolated temporary state root; the runner's HOME is never reassigned.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile


REPOSITORY = "Sthang-Co-Ltd/Sthang-Studio"
BASELINE_VERSION = "0.85.6"
BASELINE_SHA256 = "0b06658ec93da45c652be07da0300e860df8f1bc26ea3807a4a4bf1bb3c0f0bd"
CANDIDATE_VERSION = "0.89.0"
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
REF = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\Z")
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
PAYLOAD_PATHS = (
    "apps", "packages", "local-timing", "scripts", "config",
    "docs/MACOS-COMPATIBILITY.md", "docs/OTA-UPDATES.md", ".sthang",
    ".env.example", "package.json", "package-lock.json", "INSTALL-MACOS.sh",
    "setup-local-timing-macos.sh", "run-macos.sh", "README.md", "LICENSE",
    "PRIVACY.md", "SECURITY.md", "SUPPORT.md", "THIRD_PARTY_NOTICES.md",
    "TRADEMARKS.md",
)
DERIVED_ROOTS = ("apps/server/dist/", "apps/web/dist/", "packages/shared/dist/")
FORBIDDEN_PARTS = frozenset((
    "data", "uploads", "exports", "tools", "node_modules", ".venv",
    ".timing-envs", "versions", "updates", "release-artifacts",
))


class AcceptanceFailure(Exception):
    """A fail-closed acceptance check with a safe, bounded diagnostic."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AcceptanceFailure(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: pathlib.Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as reader:
        for part in iter(lambda: reader.read(1024 * 1024), b""):
            hasher.update(part)
    return hasher.hexdigest()


def git(*args: str, binary: bool = False):
    process = subprocess.run(
        ["git", *args], cwd=PROJECT_ROOT, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False, timeout=75,
    )
    require(process.returncode == 0, "Could not verify the selected Git source.")
    return process.stdout if binary else process.stdout.decode("utf-8").strip()


def command_json(args: list[str]) -> list[dict]:
    process = subprocess.run(
        args, cwd=PROJECT_ROOT, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False, timeout=60,
    )
    require(process.returncode == 0, "Could not retrieve the selected GitHub release metadata.")
    try:
        value = json.loads(process.stdout)
    except (ValueError, UnicodeError) as error:
        raise AcceptanceFailure("GitHub release metadata was not valid JSON.") from error
    require(isinstance(value, list) and len(value) <= 100
            and all(isinstance(item, dict) for item in value),
            "GitHub's first 100 releases have an unexpected response shape.")
    return value


def release_metadata(releases: list[dict], tag: str) -> dict:
    # GET /releases/tags/{tag} can return 404 for an existing draft.
    # The authenticated bounded list includes drafts with contents:write.
    matches = [item for item in releases if item.get("tag_name") == tag]
    require(len(matches) == 1,
            "Exact release tag is missing or duplicated in the first 100 releases.")
    release = matches[0]
    require(type(release.get("draft")) is bool, "Release draft status is missing.")
    return release


def resolve_release_source(release: dict, expected_commit: str) -> str:
    """A draft can have no tag ref yet; bind its selected target branch instead."""
    branch = str(release.get("target_commitish", ""))
    require(bool(HEX40.fullmatch(expected_commit)), "Candidate commit must be a full lowercase SHA.")
    if HEX40.fullmatch(branch):
        require(branch == expected_commit, "Draft release targets a different commit.")
    else:
        require(bool(REF.fullmatch(branch)) and ".." not in branch.split("/"),
                "Draft release target is not a safe, explicit branch.")
        remote = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
        matched = re.fullmatch(r"([0-9a-f]{40})\trefs/heads/[^\s]+", remote)
        require(matched is not None and matched.group(1) == expected_commit,
                "Selected draft release branch does not resolve to candidate commit.")
    # A published tag, if one exists, must also point to the reviewed commit.
    tagged = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", "origin", f"refs/tags/{release['tag_name']}"],
        cwd=PROJECT_ROOT, capture_output=True, check=False, timeout=75,
    )
    require(tagged.returncode == 0, "Could not check the selected release tag.")
    tag_ref = tagged.stdout.decode("ascii").strip()
    if tag_ref:
        require(bool(re.fullmatch(r"[0-9a-f]{40}\trefs/tags/[^\s]+", tag_ref)),
                "The selected release tag ref is invalid.")
        tag_commit = (
            git("rev-parse", f"refs/tags/{release['tag_name']}^{{commit}}")
            if git_ref_exists(f"refs/tags/{release['tag_name']}") else ""
        )
        if not tag_commit:
            tag_commit = git("ls-remote", "--tags", "origin", f"refs/tags/{release['tag_name']}^{{}}")
            tag_commit = tag_commit.split("\t")[0] if tag_commit else tag_ref.split("\t")[0]
        require(tag_commit == expected_commit, "Published candidate tag points to a different commit.")
    # A reviewed release branch need not yet have merged into accepted main.
    present = subprocess.run(["git", "cat-file", "-e", f"{expected_commit}^{{commit}}"],
                             cwd=PROJECT_ROOT, capture_output=True, check=False)
    if present.returncode != 0:
        git("fetch", "--no-tags", "origin", expected_commit)
    require(git("rev-parse", expected_commit) == expected_commit,
            "Exact candidate source commit is unavailable.")
    return git("rev-parse", f"{expected_commit}^{{tree}}")


def git_ref_exists(ref: str) -> bool:
    return subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", ref],
        cwd=PROJECT_ROOT, capture_output=True, check=False,
    ).returncode == 0


def asset_metadata(release: dict, name: str, expected_sha: str | None = None) -> None:
    found = [asset for asset in release.get("assets", []) if asset.get("name") == name]
    require(len(found) == 1, "The selected release lacks a unique required asset.")
    require(found[0].get("state") == "uploaded", "A selected release asset is not uploaded.")
    size = found[0].get("size")
    require(isinstance(size, int) and 0 < size <= MAX_ARCHIVE_BYTES,
            "A selected release asset exceeds the acceptance size bound.")
    if expected_sha:
        require(found[0].get("digest") == "sha256:" + expected_sha,
                "GitHub's asset digest does not match the reviewed SHA-256.")


def fetch_asset(tag: str, name: str, destination: pathlib.Path) -> pathlib.Path:
    destination.mkdir(parents=True, exist_ok=True)
    response = subprocess.run(
        ["gh", "release", "download", tag, "--repo", REPOSITORY,
         "--pattern", name, "--dir", str(destination)],
        cwd=PROJECT_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=180,
    )
    require(response.returncode == 0, "Could not download an exact selected release asset.")
    file = destination / name
    require(file.is_file() and 0 < file.stat().st_size <= MAX_ARCHIVE_BYTES,
            "Downloaded release asset was missing or oversized.")
    return file


def checksum_asset(path: pathlib.Path, target_name: str, expected_sha: str) -> None:
    try:
        text = path.read_text("ascii").strip()
    except (UnicodeError, OSError) as error:
        raise AcceptanceFailure("Release checksum asset is unreadable.") from error
    require(text == f"{expected_sha}  {target_name}",
            "Release checksum asset did not match the reviewed package.")


def archive_path(raw: str) -> str:
    require(raw and len(raw) <= 512 and "\x00" not in raw and "\\" not in raw
            and not raw.startswith("/"), "Release archive contains an unsafe path.")
    parts = raw.rstrip("/").split("/")
    require(all(part and part not in (".", "..") and ":" not in part
                and not part.endswith((" ", ".")) for part in parts),
            "Release archive contains an unsafe path segment.")
    folded = [part.casefold() for part in parts]
    require(not any(part in FORBIDDEN_PARTS or part == ".env"
                    or part.startswith((".venv.rollback-", ".venv.pending-"))
                    for part in folded), "Release archive contains protected runtime state.")
    return "/".join(parts)


def zip_entries(path_or_bytes: pathlib.Path | bytes) -> dict[str, tuple[bytes, int]]:
    source = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    entries: dict[str, tuple[bytes, int]] = {}
    seen: set[str] = set()
    total = 0
    try:
        with zipfile.ZipFile(source) as archive:
            require(0 < len(archive.infolist()) <= 20_000, "Archive entry count is invalid.")
            for info in archive.infolist():
                name = archive_path(info.filename)
                collision = unicodedata.normalize("NFC", name).casefold()
                require(collision not in seen, "Release archive contains duplicate/colliding paths.")
                seen.add(collision)
                require(not (info.flag_bits & 1), "Release archive contains an encrypted file.")
                mode = info.external_attr >> 16
                kind = stat.S_IFMT(mode)
                require(kind in (0, stat.S_IFREG, stat.S_IFDIR),
                        "Release archive contains a link or a special file.")
                if info.is_dir():
                    continue
                total += info.file_size
                require(total <= MAX_EXPANDED_BYTES, "Release archive expands beyond the accepted limit.")
                content = archive.read(info)  # CRC/deflate verified before extraction.
                require(len(content) == info.file_size, "Release archive contains a short file.")
                entries[name] = (content, mode)
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as error:
        raise AcceptanceFailure("Release archive could not be read safely.") from error
    require(bool(entries), "Release archive has no regular files.")
    return entries


def extract_verified(entries: dict[str, tuple[bytes, int]], root: pathlib.Path) -> None:
    require(not root.exists(), "Verified extraction target already exists.")
    root.mkdir(parents=True)
    for name, (content, mode) in entries.items():
        file = root.joinpath(*name.split("/"))
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open("xb") as stream:
            stream.write(content)
        file.chmod(0o755 if mode & 0o111 else 0o644)


def payload_entries(recovery: dict[str, tuple[bytes, int]], version: str) -> dict[str, tuple[bytes, int]]:
    prefix = f"Sthang Studio {version}/"
    inner = prefix + "Sthang Studio Files/"
    require(all(name.startswith(prefix) for name in recovery),
            "Recovery ZIP has files outside its expected version directory.")
    roots = {name[len(prefix):].split("/")[0] for name in recovery}
    require(roots == {"Install Sthang Studio.command", "Read Me.txt", "Sthang Studio Files"},
            "Recovery ZIP does not have the reviewed three-item handoff.")
    installer = recovery.get(prefix + "Install Sthang Studio.command")
    require(installer is not None and installer[1] & 0o111,
            "Recovery ZIP installer is absent or not executable.")
    readme = recovery.get(prefix + "Read Me.txt")
    require(readme is not None and f"Version {version}" in readme[0].decode("utf-8-sig"),
            "Recovery ZIP version handoff is invalid.")
    return {name[len(inner):]: value for name, value in recovery.items() if name.startswith(inner)}


def validate_source_evidence(
    commit: str, tree: str, candidate: dict[str, tuple[bytes, int]],
    recovery_payload: dict[str, tuple[bytes, int]], unsigned: dict,
) -> None:
    source_archive = git("archive", "--format=zip", commit, "--", *PAYLOAD_PATHS, binary=True)
    source = zip_entries(source_archive)
    require(unsigned.get("schemaVersion") == 2 and unsigned.get("product") == "sthang-studio"
            and unsigned.get("platform") == "macos-arm64" and unsigned.get("version") == CANDIDATE_VERSION,
            "Unsigned manifest has incorrect Mac release identity.")
    identity = unsigned.get("source", {})
    require(identity.get("commit") == commit and identity.get("tree") == tree,
            "Unsigned OTA source commit/tree differs from reviewed source.")
    require(unsigned.get("compatibility", {}).get("arch") == "arm64"
            and unsigned.get("compatibility", {}).get("minMacos") == "12.3"
            and unsigned.get("setup", {}).get("strategy") == "macos-curated-runtime",
            "Unsigned OTA compatibility/setup does not match the reviewed Mac contract.")
    require(candidate.keys() == recovery_payload.keys(),
            "Mac recovery and OTA package file sets differ.")
    for name, (content, _) in candidate.items():
        require(recovery_payload[name][0] == content,
                "Mac recovery and OTA payload bytes differ.")
    for name, (source_bytes, _) in source.items():
        expected = source_bytes.replace(b"\r\n", b"\n") if name.endswith((".sh", ".command")) else source_bytes
        require(name in candidate and candidate[name][0] == expected,
                "Candidate payload source differs from exact selected Git commit.")
    generated = {".sthang/macos-curated-runtime", ".sthang/macos-derived-runtime.json"}
    evidence_bytes = candidate.get(".sthang/macos-release-build.json", (b"", 0))[0]
    derived_bytes = candidate.get(".sthang/macos-derived-runtime.json", (b"", 0))[0]
    lock_bytes = candidate.get("package-lock.json", (b"", 0))[0]
    require(candidate.get(".sthang/macos-curated-runtime", (b"", 0))[0].strip() == b"production-runtime-v1",
            "The curated runtime marker is invalid.")
    try:
        evidence = json.loads(evidence_bytes)
        derived = json.loads(derived_bytes)
    except (ValueError, UnicodeError) as error:
        raise AcceptanceFailure("Candidate derived build evidence is invalid.") from error
    lock_hash = digest(lock_bytes)
    require(evidence.get("schemaVersion") == 1 and evidence.get("packageLockSha256") == lock_hash
            and derived.get("schemaVersion") == 2 and derived.get("packageLockSha256") == lock_hash,
            "Candidate build evidence does not bind the locked npm dependency graph.")
    require(derived.get("sourceCommit") == commit and derived.get("sourceTree") == tree
            and derived.get("buildEvidenceSha256") == digest(evidence_bytes),
            "Candidate derived-runtime provenance does not match its source.")
    require(identity.get("buildEvidenceSha256") == digest(evidence_bytes)
            and identity.get("derivedRuntimeManifestSha256") == digest(derived_bytes)
            and unsigned.get("setup", {}).get("packageLockSha256") == lock_hash,
            "Unsigned manifest provenance does not match source-owned evidence.")
    files = evidence.get("files")
    require(isinstance(files, list) and bool(files) and files == derived.get("files"),
            "Derived runtime differs from committed source-owned build evidence.")
    generated.update(record.get("path", "") for record in files if isinstance(record, dict))
    require(candidate.keys() == source.keys() | generated,
            "Candidate archive has unexpected or missing source/derived files.")
    for record in files:
        require(isinstance(record, dict) and set(record) == {"path", "size", "sha256"},
                "Malformed source-owned derived file record.")
        name = record["path"]
        require(isinstance(name, str) and name.startswith(DERIVED_ROOTS) and name in candidate
                and record["size"] == len(candidate[name][0])
                and record["sha256"] == digest(candidate[name][0]),
                "Derived production build bytes differ from committed source evidence.")
    for record in unsigned.get("setup", {}).get("pythonFiles", []):
        require(isinstance(record, dict) and re.fullmatch(r"local-timing/requirements(?:-[a-z0-9-]+)?\.txt", str(record.get("path", ""))),
                "Unsigned Python dependency input path is invalid.")
        name = record["path"]
        require(name in candidate and record.get("sha256") == digest(candidate[name][0]),
                "Unsigned Python dependency input does not match package.")
    require(candidate["package.json"][0] and json.loads(candidate["package.json"][0]).get("version") == CANDIDATE_VERSION,
            "Candidate package version differs from reviewed release.")


def sanitized_failure_tail(log: pathlib.Path, work: pathlib.Path,
                           env: dict[str, str]) -> str:
    """Expose actionable native errors without printing raw logs or credentials."""
    raw = log.read_bytes()[-8192:].decode("utf-8", errors="replace")
    replacements = [
        (str(pathlib.Path.home()), "[runner-home]"),
        (env.get("STHANG_STUDIO_STATE_ROOT", ""), "[isolated-state]"),
        (str(work), "[runner-temp]"),
    ]
    safe: list[str] = []
    for item in raw.splitlines()[-30:]:
        # An entire credential-bearing diagnostic must be hidden, not merely
        # partially masked; runtime scripts must not expose env values.
        if re.search(
            r"(?i)(?:authorization|bearer|password|secret|api[_ -]?key|"
            r"(?:access|github|gh)[-_ ]?token|\btoken\s*[:=]|"
            r"gh[pousr]_[A-Za-z0-9]|github_pat_|AIza[0-9A-Za-z])",
            item,
        ):
            safe.append("[credential-bearing diagnostic redacted]")
            continue
        line = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", item)
        line = re.sub(r"(?i)\b(?:https?|ftp)://[^\s'\"<>]+", "[external-url]", line)
        for path, placeholder in replacements:
            if path:
                line = line.replace(path, placeholder)
        safe.append(line[:240])
    return "\n".join(safe)[-4096:]


def run_logged(label: str, command: list[str], work: pathlib.Path, *,
               env: dict[str, str], cwd: pathlib.Path | None = None,
               timeout: int = 900, must_fail: bool = False) -> None:
    log = work / f"command-{label}.log"
    with log.open("wb") as stream:
        try:
            result = subprocess.run(
                command, cwd=cwd or PROJECT_ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=stream, stderr=subprocess.STDOUT, check=False, timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise AcceptanceFailure(f"{label} exceeded its bounded runtime.") from error
    okay = result.returncode != 0 if must_fail else result.returncode == 0
    if not okay:
        print(
            f"Sanitized {label} diagnostic (last 30 lines, bounded):\n"
            f"{sanitized_failure_tail(log, work, env)}",
            file=sys.stderr,
        )
    require(okay, f"{label} returned an unexpected exit status ({result.returncode}); "
                  "raw process output remains in isolated runner storage only.")


def state_sentinels(state: pathlib.Path) -> dict[pathlib.Path, bytes]:
    records = {
        state / "data/ci-mac-project.json": b'{"project":"ci-placeholder"}\n',
        state / "uploads/ci-media-placeholder.txt": b"ci synthetic media placeholder\n",
        state / "exports/ci-export-placeholder.txt": b"ci synthetic export placeholder\n",
        state / "history/ci-history-placeholder.txt": b"ci synthetic history placeholder\n",
        state / "apps-data/ci-settings-placeholder.txt": b"ci synthetic settings placeholder\n",
        state / "app/apps/server/.env": b"STHANG_CI_PLACEHOLDER=preserve-this-ci-only-value\n",
    }
    for file, contents in records.items():
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(contents)
    return records


def confirm_state(records: dict[pathlib.Path, bytes]) -> None:
    require(all(file.is_file() and file.read_bytes() == content for file, content in records.items()),
            "Mac manual upgrade lost or modified protected synthetic state.")


def installed_version(app: pathlib.Path) -> str:
    try:
        return str(json.loads((app / "package.json").read_text("utf-8"))["version"])
    except (OSError, KeyError, ValueError) as error:
        raise AcceptanceFailure("Installed Mac application version is missing.") from error


def installed_python_version(app: pathlib.Path, version: str, env: dict[str, str]) -> str:
    process = subprocess.run(
        [str(app / ".venv/bin/python"), "-c",
         'import platform,sys; print(".".join(map(str,sys.version_info[:3]))+" "+platform.machine())'],
        cwd=app, env=env, capture_output=True, check=False, timeout=15,
    )
    require(process.returncode == 0, "Installed native timing Python did not execute.")
    result = process.stdout.decode("ascii", errors="replace").strip()
    match = re.fullmatch(r"3\.12\.(\d+) arm64", result)
    # The genuine v0.85.6 release pins 3.12.14, while the v0.89.0
    # candidate raises the supported floor to 3.12.15. The runner's
    # modern bootstrap can also supply 3.12.15 to the old installer.
    minimum_patch = 14 if version == BASELINE_VERSION else 15
    require(match is not None and int(match.group(1)) >= minimum_patch,
            f"Installed {version} timing environment is not native Python 3.12.{minimum_patch}+.")
    return result.split()[0]


def installed_ffmpeg_version(app: pathlib.Path, env: dict[str, str]) -> str:
    script = r'''
set -euo pipefail
ROOT="$1"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host
studio_macos_select_ffmpeg
printf '%s\n' "$STUDIO_FFMPEG_PATH"
version_output="$("$STUDIO_FFMPEG_PATH" -version)"
printf '%s\n' "$version_output" | /usr/bin/sed -n '1p'
'''
    process = subprocess.run(
        ["/bin/bash", "-c", script, "macos-acceptance", str(app)],
        cwd=app, env=env, capture_output=True, check=False, timeout=30,
    )
    require(process.returncode == 0, "Could not identify tested native FFmpeg build.")
    lines = process.stdout.decode("utf-8", errors="replace").splitlines()
    require(len(lines) == 2, "Native FFmpeg selection did not report one executable and version.")
    declared = re.search(
        r'^STUDIO_MANAGED_FFMPEG_VERSION="([A-Za-z0-9.+_-]{1,60})"$',
        (app / "scripts/macos-managed-runtime.sh").read_text("utf-8"), re.MULTILINE,
    )
    require(declared is not None, "Selected Mac runtime has no reviewed managed FFmpeg pin.")
    expected = (pathlib.Path(env["STHANG_STUDIO_STATE_ROOT"]) / "tools" / "macos-arm64"
                / f"ffmpeg-{declared.group(1)}" / "bin" / "ffmpeg")
    require(pathlib.Path(lines[0]).resolve() == expected.resolve(),
            "Native test used host FFmpeg instead of the selected release's managed FFmpeg pin.")
    match = re.match(r"ffmpeg version ([A-Za-z0-9.+_-]{1,60})(?:\s|$)", lines[1])
    require(match is not None, "Native FFmpeg build did not identify its version.")
    return match.group(1)


def native_checks(app: pathlib.Path, version: str, work: pathlib.Path,
                  env: dict[str, str]) -> str:
    require(installed_version(app) == version, "Native installed package version is incorrect.")
    require((app / ".venv/bin/python").is_file(), "Native timing environment was not installed.")
    for excluded in ("esbuild", "vite", "tsx", "typescript", "react", "lucide-react"):
        require(not (app / "node_modules" / excluded).exists(),
                "Curated Mac installation unexpectedly contains development/web packages.")
    run_logged("timing-" + version,
               [str(app / ".venv/bin/python"), "-B", str(app / "scripts/check-macos-timing.py"), "--ready"],
               work, env=env, cwd=app, timeout=180)
    ass = work / "macos-native-caption.ass"
    ass.write_text(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding\n"
        "Style: Default,Arial,22,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,1,0,2,12,12,12,1\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,ភាសាខ្មែរ English\n",
        encoding="utf-8",
    )
    ffmpeg_probe = r'''
set -euo pipefail
ROOT="$1"
WORK="$2"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host
studio_macos_select_node
studio_macos_select_ffmpeg
studio_macos_ffmpeg_ok "$STUDIO_FFMPEG_PATH" "$STUDIO_FFPROBE_PATH"
cd "$WORK"
"$STUDIO_FFMPEG_PATH" -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x180:r=1 -vf ass=macos-native-caption.ass -frames:v 1 -pix_fmt yuv420p -c:v libx264 -y macos-native-caption.mp4
"$STUDIO_FFPROBE_PATH" -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 macos-native-caption.mp4 | grep -x h264
'''
    run_logged("ffmpeg-" + version, ["/bin/bash", "-c", ffmpeg_probe, "macos-acceptance",
                                     str(app), str(work)], work, env=env, cwd=app, timeout=120)
    run_logged("curated-" + version,
               ["node", str(app / "scripts/smoke-macos-curated-runtime.mjs"), str(app)],
               work, env=env, cwd=app, timeout=90)
    run_broker_probe(app, version, work, env)
    return f"Python {installed_python_version(app, version, env)}, FFmpeg {installed_ffmpeg_version(app, env)}"


def run_broker_probe(app: pathlib.Path, version: str, work: pathlib.Path,
                     env: dict[str, str]) -> None:
    log = work / f"broker-{version}.log"
    require((app / "scripts/launch-studio-macos.sh").is_file(),
            "Installed stable Mac broker is missing.")
    local = dict(env)
    local["KCS_OPEN_BROWSER"] = "false"
    local["KCS_NONINTERACTIVE"] = "1"
    # Loopback health must never be delegated to a runner-configured HTTP proxy.
    local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    child = None
    with log.open("wb") as output:
        try:
            child = subprocess.Popen(
                ["/bin/bash", str(app / "run-macos.sh")],
                cwd=app, env=local, stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
            )
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                require(child.poll() is None, "Installed Mac broker exited before health.")
                try:
                    with local_http.open("http://127.0.0.1:8787/api/health", timeout=2) as reply:
                        health = json.load(reply)
                    with local_http.open("http://127.0.0.1:8787/", timeout=2) as reply:
                        page = reply.read(512 * 1024)
                    if (health.get("ok") is True and health.get("engineVersion") == version
                            and b'<div id="root"></div>' in page):
                        if version == BASELINE_VERSION:
                            # The actual v0.85.6 broker predates the independent
                            # studio-web-identity.json contract. Only check its
                            # historical API version and rendered UI here.
                            return
                        # v0.89.0 requires exact, independently built web identity,
                        # as well as the API version and visible SPA shell.
                        local_web = json.loads(
                            (app / "apps/web/dist/studio-web-identity.json").read_text("utf-8"))
                        with local_http.open("http://127.0.0.1:8787/studio-web-identity.json", timeout=2) as reply:
                            web = json.load(reply)
                        if (web.get("schemaVersion") == 1
                                and web.get("service") == "sthang-studio-web"
                                and web.get("version") == version
                                and web.get("buildId") == local_web.get("buildId")):
                            return
                except (OSError, ValueError, urllib.error.URLError):
                    pass
                time.sleep(0.35)
            raise AcceptanceFailure("Installed stable broker did not serve exact-version API/UI health.")
        finally:
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=8)


def summary(results: list[str], commit: str, recovery_sha: str, ota_sha: str) -> None:
    report = [
        "## Native Apple Silicon prepublication evidence",
        f"- Source candidate: `{commit}`",
        f"- Recovery ZIP SHA-256: `{recovery_sha}`",
        f"- OTA ZIP SHA-256: `{ota_sha}`",
        f"- Runtime host: macOS {platform.mac_ver()[0]} arm64 on a GitHub-hosted macOS 15 runner; "
        "other supported macOS versions untested.",
        *[f"- {item}" for item in results],
        "- **Production signature and public pointer verification: separate release gate.** "
        "Installed-broker checks above use an ephemeral CI signing fixture and actual native candidate bytes. "
        "This run never uses a production signing key or promotes `macos-arm64/latest.json`.",
        "- FFmpeg source provenance remains independently gated; native codec execution "
        "does not grant a provenance exception for this release.",
    ]
    path = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if path:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write("\n".join(report) + "\n")
    else:
        print("\n".join(report))


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        # The exact tag must resolve uniquely in an authenticated draft-capable
        # listing; a nearby published tag cannot stand in for a missing draft.
        sample = [
            {"tag_name": "v0.85.6", "draft": False, "assets": []},
            {"tag_name": "v0.89.0", "draft": True, "assets": []},
        ]
        assert release_metadata(sample, "v0.89.0") is sample[1]
        assert release_metadata(sample, "v0.85.6") is sample[0]
        for records, tag in (
            (sample, "v0.89"),
            (sample + [sample[1].copy()], "v0.89.0"),
            ([{"tag_name": "v0.89.0", "assets": []}], "v0.89.0"),
        ):
            try:
                release_metadata(records, tag)
            except AcceptanceFailure:
                pass
            else:
                raise AssertionError("Missing, duplicate or malformed draft release was accepted.")
        fixture = io.BytesIO()
        with zipfile.ZipFile(fixture, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("valid/test.txt", "ok")
        assert zip_entries(fixture.getvalue())["valid/test.txt"][0] == b"ok"
        for path in ("../escape", "foo\\bar", "data/secret", ".env", "some/path/../back", "foo//bar"):
            try:
                archive_path(path)
            except AcceptanceFailure:
                pass
            else:
                raise AssertionError(f"unsafe path accepted: {path}")
        collision = io.BytesIO()
        with zipfile.ZipFile(collision, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("Foo/a.txt", "first")
            archive.writestr("foo/A.txt", "second")
        try:
            zip_entries(collision.getvalue())
        except AcceptanceFailure:
            pass
        else:
            raise AssertionError("case-colliding archive was accepted")
        link = io.BytesIO()
        with zipfile.ZipFile(link, "w", zipfile.ZIP_DEFLATED) as archive:
            info = zipfile.ZipInfo("escape-link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "elsewhere")
        try:
            zip_entries(link.getvalue())
        except AcceptanceFailure:
            pass
        else:
            raise AssertionError("symlink archive was accepted")
        assert digest(b"test") == hashlib.sha256(b"test").hexdigest()
        print("macOS acceptance helper synthetic archive checks passed.")
        return
    require(not sys.argv[1:], "Unexpected macOS acceptance helper arguments.")
    require(platform.system() == "Darwin" and platform.machine() == "arm64",
            "Native Apple Silicon macOS (arm64) runner is required.")
    require(sys.version_info[:3] >= (3, 12, 15) and sys.version_info[:2] == (3, 12),
            "Native reviewed Python 3.12.15+ is required.")
    require(os.environ.get("GITHUB_REPOSITORY", "").casefold() == REPOSITORY.casefold(),
            "Workflow must run in the Sthang Studio GitHub repository.")
    require(os.environ.get("GH_TOKEN"), "Authenticated GitHub workflow token is required for draft release assets.")
    node = subprocess.run(
        ["node", "-p", 'process.versions.node + " " + process.arch'],
        cwd=PROJECT_ROOT, capture_output=True, check=False, timeout=15,
    )
    require(node.returncode == 0 and node.stdout.decode("ascii").strip() == "24.21.0 arm64",
            "The workflow must run reviewed Node 24.21.0 arm64.")
    tag = os.environ.get("STUDIO_CANDIDATE_TAG", "")
    commit = os.environ.get("STUDIO_CANDIDATE_COMMIT", "").lower()
    recovery_sha = os.environ.get("STUDIO_RECOVERY_SHA256", "").lower()
    ota_sha = os.environ.get("STUDIO_OTA_SHA256", "").lower()
    require(tag == "v" + CANDIDATE_VERSION and bool(HEX40.fullmatch(commit))
            and bool(HEX64.fullmatch(recovery_sha)) and bool(HEX64.fullmatch(ota_sha)),
            "Provide exact v0.89.0 tag, full commit and two reviewed SHA-256 values.")
    require(os.environ.get("HOME") and os.environ.get("RUNNER_TEMP"),
            "Runner HOME and RUNNER_TEMP must be available.")
    temp = pathlib.Path(os.environ["RUNNER_TEMP"]).resolve()
    state = pathlib.Path(os.environ["STHANG_STUDIO_STATE_ROOT"]).resolve()
    require(state != temp and temp in state.parents,
            "Studio acceptance state must remain inside RUNNER_TEMP.")
    work = temp / "sthang-studio-macos-acceptance"
    require(not work.exists() and work != state and work not in state.parents,
            "Mac acceptance temporary paths are not isolated.")
    work.mkdir(parents=True)
    require(not (pathlib.Path.home() / "Applications/Sthang Studio.app").exists()
            and not (pathlib.Path.home() / "Applications/Sthang Studio.command").exists(),
            "The runner already contains a Studio launcher; native acceptance needs an empty runner.")
    environment = os.environ.copy()
    # The read-only workflow GitHub token is required to fetch draft assets, but
    # no GitHub token is ever passed into a downloaded application/installer.
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN",
                 "ACTIONS_ID_TOKEN_REQUEST_TOKEN"):
        environment.pop(name, None)
    environment["STHANG_STUDIO_STATE_ROOT"] = str(state)
    # Keep the reviewed Node/private-Python tool directories and native macOS
    # system tools. Excluding Homebrew/system extras forces an actual test of
    # the release-managed, checksum-pinned FFmpeg fallback on this clean runner.
    node_path = shutil.which("node")
    require(node_path is not None, "Reviewed Node executable cannot be located.")
    environment["PATH"] = ":".join((
        str(pathlib.Path(node_path).absolute().parent),
        str(pathlib.Path(sys.executable).absolute().parent),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ))
    environment["TMPDIR"] = str(work)
    environment["PIP_CACHE_DIR"] = str(work / "pip-cache")
    environment["XDG_CACHE_HOME"] = str(work / "xdg-cache")
    environment["HF_HOME"] = str(work / "huggingface-cache")
    environment["KCS_NONINTERACTIVE"] = "1"
    environment["KCS_OPEN_BROWSER"] = "false"
    environment["ORT_DISABLE_TELEMETRY"] = "1"
    environment["HF_HUB_DISABLE_TELEMETRY"] = "1"
    environment["DO_NOT_TRACK"] = "1"
    results: list[str] = []
    print("Checking selected draft/release asset provenance...", flush=True)
    try:
        releases = command_json([
            "gh", "api", "--method", "GET", f"repos/{REPOSITORY}/releases?per_page=100",
        ])
        release = release_metadata(releases, tag)
        tree = resolve_release_source(release, commit)
        baseline_release = release_metadata(releases, "v" + BASELINE_VERSION)
        basename = f"Sthang-Studio-macOS-Apple-Silicon-v{BASELINE_VERSION}.zip"
        recovery_name = f"Sthang-Studio-macOS-Apple-Silicon-v{CANDIDATE_VERSION}.zip"
        ota_name = f"Sthang-Studio-OTA-macOS-Apple-Silicon-v{CANDIDATE_VERSION}.zip"
        manifest_name = f"Sthang-Studio-OTA-macOS-Apple-Silicon-v{CANDIDATE_VERSION}.release-unsigned.json"
        required = [
            (baseline_release, "v" + BASELINE_VERSION, basename, BASELINE_SHA256),
            (release, tag, recovery_name, recovery_sha),
            (release, tag, ota_name, ota_sha),
        ]
        downloaded: dict[str, pathlib.Path] = {}
        for metadata, selected_tag, name, expected_sha in required:
            asset_metadata(metadata, name, expected_sha)
            asset_metadata(metadata, name + ".sha256")
            folder = work / ("baseline" if selected_tag == "v" + BASELINE_VERSION else "candidate")
            file = fetch_asset(selected_tag, name, folder)
            require(file_digest(file) == expected_sha,
                    "Downloaded package did not match reviewed SHA-256.")
            checksum = fetch_asset(selected_tag, name + ".sha256", folder)
            checksum_asset(checksum, name, expected_sha)
            downloaded[name] = file
        asset_metadata(release, manifest_name)
        manifest_file = fetch_asset(tag, manifest_name, work / "candidate")
        unsigned = json.loads(manifest_file.read_text("utf-8"))
        baseline_entries = zip_entries(downloaded[basename])
        recovery_entries = zip_entries(downloaded[recovery_name])
        ota_entries = zip_entries(downloaded[ota_name])
        baseline_payload = payload_entries(baseline_entries, BASELINE_VERSION)
        require("package.json" in baseline_payload
                and json.loads(baseline_payload["package.json"][0]).get("version") == BASELINE_VERSION,
                "Pinned v0.85.6 recovery package has the wrong source version.")
        candidate_payload = payload_entries(recovery_entries, CANDIDATE_VERSION)
        candidate_ota = {name: value for name, value in ota_entries.items()}
        package = unsigned.get("package", {})
        require(package.get("sha256") == ota_sha
                and package.get("sizeBytes") == downloaded[ota_name].stat().st_size
                and package.get("unpackedSizeBytes") == sum(len(data) for data, _ in candidate_ota.values()),
                "Unsigned manifest does not match selected OTA archive size/hash.")
        validate_source_evidence(commit, tree, candidate_ota, candidate_payload, unsigned)
        baseline_root = work / "baseline-extracted"
        candidate_root = work / "candidate-extracted"
        extract_verified(baseline_entries, baseline_root)
        extract_verified(recovery_entries, candidate_root)
        extracted_baseline = baseline_root / f"Sthang Studio {BASELINE_VERSION}" / "Sthang Studio Files"
        extracted_candidate = candidate_root / f"Sthang Studio {CANDIDATE_VERSION}" / "Sthang Studio Files"
        # Reuse Studio's existing unsigned release protocol validator. This is not
        # a signed or production live-OTA verification.
        run_logged("unsigned-protocol",
                   ["node", str(extracted_candidate / "scripts/update-release.mjs"), "verify-unsigned",
                    "--trust-root", str(extracted_candidate / "config/update-trust-root-macos.json"),
                    "--manifest", str(manifest_file), "--package", str(downloaded[ota_name])],
                   work, env=environment, cwd=extracted_candidate, timeout=50)
        results.append("PASS: downloaded GitHub baseline and selected candidate asset checksums, "
                       "source commit/tree, recovery/OTA byte equivalence, signed-protocol *unsigned* candidate schema, "
                       "and committed derived-runtime hashes.")
        print("Installing published v0.85.6 Mac bootstrap...", flush=True)
        run_logged("baseline-installer",
                   ["/bin/bash", str(extracted_baseline / "scripts/install-release-package-macos.sh"),
                    str(extracted_baseline)], work, env=environment, timeout=1200)
        app = state / "app"
        require(installed_version(app) == BASELINE_VERSION, "Bootstrap did not install v0.85.6.")
        baseline_runtime = native_checks(app, BASELINE_VERSION, work, environment)
        results.append("PASS: genuine v0.85.6 Apple Silicon installer, KFA tokenizer/ONNX model-load smoke and "
                       "curated Node runtime, libass Khmer/English render, H.264 encoder and stable broker API/UI "
                       f"({baseline_runtime}).")
        records = state_sentinels(state)
        old_script_hash = file_digest(app / "run-macos.sh")
        old_trust_hash = file_digest(app / "config/update-trust-root-macos.json")
        ota_work = work / "native-ota"
        ota_work.mkdir()
        print("Checking actual v0.85.6 broker preparation, OTA activation and rollback...", flush=True)
        ota_request = {
            "stateRoot": str(state),
            "candidatePackagePath": str(downloaded[ota_name]),
            "unsignedManifestPath": str(manifest_file),
            "expectedCommit": commit,
            "workRoot": str(ota_work),
        }
        run_logged("native-installed-ota",
                   ["node", str(PROJECT_ROOT / "scripts/ci/macos-ota-acceptance.mjs"),
                    "--request", json.dumps(ota_request, separators=(",", ":"))],
                   work, env=environment, timeout=3600)
        confirm_state(records)
        require(installed_version(app) == BASELINE_VERSION
                and file_digest(app / "run-macos.sh") == old_script_hash
                and file_digest(app / "config/update-trust-root-macos.json") == old_trust_hash,
                "Native OTA fixture did not restore the exact original baseline and production public trust.")
        results.append("PASS: installed v0.85.6 broker checked/downloaded/prepared the actual v0.89.0 OTA ZIP, "
                       "rejected corruption, recovered preparation/interruption and injected health failures, "
                       "and served exact candidate API/web/KFA health while preserving state. "
                       "Signatures used an ephemeral CI fixture key; production signing/pointer verification is separate.")
        update_pointer = state / "updates/active.json"
        update_pointer.parent.mkdir(parents=True, exist_ok=True)
        update_pointer.write_text('{"ci":"synthetic manual recovery pointer"}\n', encoding="utf-8")
        previous_pointer = update_pointer.read_bytes()
        sabotaged = work / "candidate-injected-failure"
        shutil.copytree(extracted_candidate, sabotaged)
        (sabotaged / "apps/server/dist/index.js").unlink()
        print("Checking actual failed Mac manual installer rollback...", flush=True)
        run_logged("expected-rollback-installer",
                   ["/bin/bash", str(sabotaged / "scripts/install-release-package-macos.sh"),
                    str(sabotaged)], work, env=environment, timeout=180, must_fail=True)
        require(installed_version(app) == BASELINE_VERSION
                and file_digest(app / "run-macos.sh") == old_script_hash
                and file_digest(app / "config/update-trust-root-macos.json") == old_trust_hash,
                "The failed Mac installer did not restore the old bootstrap.")
        require(update_pointer.read_bytes() == previous_pointer,
                "Failed manual upgrade lost previous OTA control data.")
        confirm_state(records)
        require((pathlib.Path.home() / "Applications/Sthang Studio.command").is_file()
                and (pathlib.Path.home() / "Applications/Sthang Studio.app").is_dir(),
                "Failed manual upgrade did not restore Mac launchers.")
        # Remove only the synthetic marker (never created from a real signed offer).
        update_pointer.unlink()
        run_broker_probe(app, BASELINE_VERSION, work, environment)
        results.append("PASS: genuine intentional manual upgrade setup failure restored "
                       "the v0.85.6 baseline, Finder/command launchers, synthetic state and control pointer.")
        # Manual recovery should deliberately reset obsolete OTA control pointers
        # only on a successful commit. This is a synthetic marker, never a signed
        # active update or a production trust alteration.
        update_pointer.write_bytes(previous_pointer)
        print("Installing exact selected v0.89.0 Mac recovery candidate...", flush=True)
        run_logged("candidate-installer",
                   ["/bin/bash", str(extracted_candidate / "scripts/install-release-package-macos.sh"),
                    str(extracted_candidate)], work, env=environment, timeout=1200)
        require(installed_version(app) == CANDIDATE_VERSION,
                "Candidate manual install did not activate the selected version.")
        require(not update_pointer.exists(),
                "Successful manual recovery left a stale active OTA control pointer.")
        confirm_state(records)
        require(file_digest(app / "config/update-trust-root-macos.json") == old_trust_hash,
                "Candidate manual recovery changed the stable production Mac trust root.")
        candidate_runtime = native_checks(app, CANDIDATE_VERSION, work, environment)
        results.append("PASS: genuine v0.89.0 Mac manual recovery installation, state preservation, "
                       f"KFA tokenizer/model-load, native libass/libx264 and exact API/web runtime health "
                       f"({candidate_runtime}).")
    except AcceptanceFailure as error:
        results.append(f"FAIL: {error}")
        raise
    finally:
        summary(results, commit, recovery_sha, ota_sha)
    print("Native installer and installed-broker OTA checks PASSED; production signature/pointer verification remains separate.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (AcceptanceFailure, AssertionError, KeyError, TypeError, ValueError, OSError) as error:
        print(f"MACOS ACCEPTANCE FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from None
