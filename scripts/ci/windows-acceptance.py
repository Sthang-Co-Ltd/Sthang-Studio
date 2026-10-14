"""Native Windows 0.85.6 -> 0.86.0 acceptance on a fresh GitHub Windows runner.

This prepublication gate never signs, publishes or promotes a production update.
Application files, state and package downloads stay inside RUNNER_TEMP. KFA uses
its initially empty native cache in the disposable runner USERPROFILE.
The shell-integration exception is the actual Windows Desktop KnownFolder
within the disposable runner USERPROFILE. The two Studio shortcut names must
be absent before setup, and only newly created links into this install may be
removed after all native test processes stop. Original release helpers stay intact.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

REPO = "Sthang-Co-Ltd/Sthang-Studio"
BASELINE = "0.85.6"
CANDIDATE = "0.86.0"
BASELINE_SHA = "7df41f4fbc60d5d877ccef37a73e6dc871f012e83b3ba765df1af3744cb72a3c"
HEX40 = re.compile(r"[a-f0-9]{40}\Z")
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
BRANCH = re.compile(r"[A-Za-z0-9_./-]{1,160}\Z")
PROJECT = Path(__file__).resolve().parents[2]
MAX_ASSET_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
DESKTOP_SHORTCUTS = ("Sthang Studio.lnk", "Khmer Caption Studio.lnk")
OTA_PAYLOAD = (
    "apps", "packages", "local-timing", "scripts", "config", ".sthang",
    ".env.example", "package.json", "package-lock.json", "INSTALL-NEW-PC.bat",
    "setup-windows.bat", "setup-local-timing-windows.bat", "run-windows.bat",
    "STOP-STHANG-STUDIO.bat", "STOP-KHMER-CAPTION-STUDIO.bat", "README.md",
    "LICENSE", "PRIVACY.md", "SECURITY.md", "SUPPORT.md",
    "THIRD_PARTY_NOTICES.md", "TRADEMARKS.md",
)


class AcceptanceFailure(Exception):
    pass


def require(ok: bool, message: str) -> None:
    if not ok:
        raise AcceptanceFailure(message)


def sha256(file: Path) -> str:
    hasher = hashlib.sha256()
    with file.open("rb") as reader:
        for chunk in iter(lambda: reader.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def run(args: list[str], *, cwd: Path = PROJECT, env: dict | None = None,
        timeout: int = 120, label: str = "command", log: Path | None = None,
        expect_failure: bool = False) -> subprocess.CompletedProcess:
    if log:
        with log.open("xb") as writer:
            result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=writer, stderr=subprocess.STDOUT,
                                    timeout=timeout, check=False)
    else:
        result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    if ((result.returncode == 0) if expect_failure else (result.returncode != 0)):
        if log and log.is_file():
            tail = "\n".join(log.read_text("utf-8", errors="replace").splitlines()[-18:])
            tail = re.sub(r"https?://\S+", "[service endpoint]", tail)
            tail = re.sub(r"[A-Za-z]:\\[^\s\"']+", "[runner path]", tail)
            tail = re.sub(r"(?i)(API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+",
                          "[redacted setting]", tail)
            print(f"Bounded native {label} diagnostic:\n{tail[-1700:]}", file=sys.stderr)
        raise AcceptanceFailure(f"{label} {'unexpectedly succeeded' if expect_failure else 'failed'}.")
    return result


def git(*args: str) -> str:
    result = run(["git", *args], label="Git source verification")
    return result.stdout.decode("utf-8", errors="strict").strip()


def gh_json(*args: str) -> list[dict]:
    result = run(["gh", *args], label="GitHub release metadata")
    try:
        document = json.loads(result.stdout)
    except (UnicodeError, ValueError) as error:
        raise AcceptanceFailure("GitHub release metadata was malformed.") from error
    require(isinstance(document, list) and len(document) <= 100
            and all(isinstance(item, dict) for item in document),
            "GitHub's first 100 releases have an unexpected response shape.")
    return document


def release(releases: list[dict], tag: str) -> dict:
    # GET /releases/tags/{tag} may return 404 for existing draft releases.
    matches = [item for item in releases if item.get("tag_name") == tag]
    require(len(matches) == 1,
            "Exact release tag is missing or duplicated in the first 100 releases.")
    value = matches[0]
    require(type(value.get("draft")) is bool and isinstance(value.get("assets"), list),
            "GitHub release status or assets have an unexpected shape.")
    return value


def source_identity(info: dict, commit: str) -> None:
    """Bind the exact draft source to freshly fetched accepted main, not the CI harness."""
    ref = info.get("target_commitish", "")
    if HEX40.fullmatch(ref):
        require(ref == commit, "The draft release targets a different source commit.")
    else:
        require(bool(BRANCH.fullmatch(ref)) and ".." not in ref.split("/"),
                "The draft release target is not a safe explicit branch.")
        line = git("ls-remote", "--heads", "origin", f"refs/heads/{ref}")
        require(line == f"{commit}\trefs/heads/{ref}",
                "The draft release branch has drifted from the selected commit.")
    tagged = git("ls-remote", "--tags", "--refs", "origin", f"refs/tags/v{CANDIDATE}")
    if tagged:
        peeled = git("ls-remote", "--tags", "origin", f"refs/tags/v{CANDIDATE}^{{}}")
        tag_commit = peeled.split("\t")[0] if peeled else tagged.split("\t")[0]
        require(tag_commit == commit, "The candidate tag points to a different commit.")
    main_line = git("ls-remote", "--heads", "origin", "refs/heads/main")
    match = re.fullmatch(r"([a-f0-9]{40})\trefs/heads/main", main_line)
    require(match is not None, "Accepted origin/main must resolve to exactly one full commit.")
    git("fetch", "--no-tags", "origin", "refs/heads/main")
    require(git("rev-parse", "FETCH_HEAD") == match.group(1),
            "Freshly fetched origin/main changed during acceptance.")
    require(git("rev-parse", "--verify", f"{commit}^{{commit}}") == commit,
            "The exact candidate source commit is unavailable in the accepted repository.")
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, match.group(1)],
        cwd=PROJECT, stdin=subprocess.DEVNULL, capture_output=True, timeout=45, check=False,
    )
    require(ancestor.returncode == 0,
            "The exact candidate source commit is not an ancestor of freshly fetched origin/main.")


def asset_record(info: dict, name: str, expected: str | None = None) -> None:
    matches = [item for item in info["assets"] if item.get("name") == name]
    require(len(matches) == 1 and matches[0].get("state") == "uploaded",
            "A required release asset is missing or not uploaded.")
    size = matches[0].get("size")
    require(type(size) is int and 0 < size <= MAX_ASSET_BYTES,
            "A selected release asset has an invalid byte size.")
    if expected is not None:
        require(matches[0].get("digest") == "sha256:" + expected,
                "GitHub's asset SHA-256 differs from the selected immutable input.")


def download_asset(tag: str, name: str, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    require(not target.exists(), "A selected release download destination already exists.")
    run(["gh", "release", "download", tag, "--repo", REPO,
         "--pattern", name, "--dir", str(directory)], timeout=300,
        label="Exact GitHub release asset download")
    require(target.is_file() and 0 < target.stat().st_size <= MAX_ASSET_BYTES,
            "The required release asset was not downloaded completely.")
    return target


def verify_sidecar(sidecar: Path, name: str, digest: str) -> None:
    try:
        value = sidecar.read_text("ascii").strip()
    except (UnicodeError, OSError) as error:
        raise AcceptanceFailure("Release checksum sidecar was unreadable.") from error
    require(value == f"{digest}  {name}", "Release checksum sidecar disagrees with the selected asset.")


def safe_name(name: str) -> str:
    require(bool(name) and len(name) <= 512 and not name.startswith(("/", "\\"))
            and "\\" not in name and "\x00" not in name,
            "Release ZIP has an invalid filename.")
    segments = name.rstrip("/").split("/")
    require(all(segment and segment not in (".", "..") and ":" not in segment
                and not segment.endswith((" ", "."))
                and not re.search(r"[\x00-\x1f\x7f]", segment)
                and not re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", segment)
                for segment in segments),
            "Release ZIP has an unsafe path component.")
    return "/".join(segments)


def zip_files(file: Path | io.BytesIO, *, windows_recovery: bool = False) -> dict[str, bytes]:
    entries: dict[str, bytes] = {}
    seen: set[str] = set()
    total = 0
    with zipfile.ZipFile(file) as archive:
        require(len(archive.infolist()) <= 20000, "Release ZIP has too many entries.")
        for info in archive.infolist():
            # The sha-verified Windows recovery ZIPs use .NET's native '\'
            # separators. OTA/Git source archives must remain strict POSIX ZIPs.
            # On Windows, Python normalizes ZipInfo.filename automatically;
            # orig_filename retains the ZIP's actual entry spelling so strict
            # OTA validation cannot silently accept backslash separators.
            raw = info.orig_filename
            name = safe_name(raw.replace("\\", "/") if windows_recovery else raw)
            folded = name.casefold()
            require(folded not in seen, "Release ZIP has duplicate or case-conflicting paths.")
            seen.add(folded)
            mode = (info.external_attr >> 16) & 0o170000
            require(mode not in (0o120000, 0o060000, 0o020000),
                    "Release ZIP has a link or special file.")
            total += info.file_size
            require(total <= MAX_EXPANDED_BYTES, "Release ZIP exceeds the uncompressed size ceiling.")
            if info.is_dir() or (windows_recovery and raw.endswith("\\")):
                require(info.file_size == 0, "Release ZIP has a nonempty directory entry.")
                continue
            entries[name] = archive.read(info)
    return entries


def verify_git_source_projection(ota_files: dict[str, bytes],
                                 source_files: dict[str, bytes]) -> None:
    # Git releases can use different ZIP compression/metadata across Git
    # versions. The reviewed OTA ZIP SHA-256 is checked independently above;
    # this gate binds every selected source path and its exact extracted bytes.
    require(ota_files.keys() == source_files.keys(),
            "The OTA archive file set differs from the exact Git source selection.")
    require(all(ota_files[name] == contents for name, contents in source_files.items()),
            "The OTA archive file contents differ from the exact Git source selection.")


def assert_payload(entries: dict[str, bytes], version: str) -> dict[str, bytes]:
    prefix = f"Sthang Studio {version}/Sthang Studio Files/"
    require(f"Sthang Studio {version}/Install Sthang Studio.bat" in entries,
            "Recovery ZIP lacks the genuine Windows installer.")
    require(f"Sthang Studio {version}/Read Me.txt" in entries,
            "Recovery ZIP lacks its top-level recovery instructions.")
    require(all(name.startswith(f"Sthang Studio {version}/") for name in entries),
            "Recovery ZIP has an unexpected top-level directory.")
    payload = {key[len(prefix):]: content for key, content in entries.items() if key.startswith(prefix)}
    require(json.loads(payload["package.json"]).get("version") == version,
            "Recovery ZIP contains the wrong package version.")
    for required in ("package-lock.json", "config/update-trust-root.json",
                     "scripts/update-runtime.mjs", "scripts/prepare-studio-update.ps1"):
        require(required in payload, "Recovery ZIP is missing a native updater component.")
    require(not any(item in payload for item in ("apps/server/.env", "data/projects.json")),
            "Recovery ZIP contains private runtime state.")
    return payload


def unpack(entries: dict[str, bytes], root: Path) -> None:
    require(not root.exists(), "A release extraction destination is not fresh.")
    root.mkdir(parents=True)
    for name, content in entries.items():
        destination = root.joinpath(*name.split("/"))
        require(root in destination.parents, "Release extraction path escaped its fresh root.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as writer:
            writer.write(content)


def candidate_manifest(file: Path, ota: Path, entries: dict[str, bytes]) -> dict:
    manifest = json.loads(file.read_text("utf-8"))
    require(isinstance(manifest, dict) and "signature" not in manifest,
            "Only the genuine unsigned candidate manifest is allowed.")
    require(manifest.get("schemaVersion") == 1 and manifest.get("product") == "sthang-studio"
            and manifest.get("platform") == "windows-x64"
            and manifest.get("channel") == "preview"
            and manifest.get("version") == CANDIDATE,
            "Unsigned manifest does not describe Windows 0.86.0.")
    package = manifest.get("package", {})
    require(package.get("url") == f"https://updates.sthang.app/studio/windows/v{CANDIDATE}/Sthang-Studio-OTA-v{CANDIDATE}.zip"
            and package.get("sha256") == sha256(ota)
            and package.get("sizeBytes") == ota.stat().st_size
            and package.get("unpackedSizeBytes") == sum(len(item) for item in entries.values()),
            "Unsigned candidate manifest does not match the byte-exact OTA ZIP.")
    require(manifest.get("compatibility", {}).get("minBrokerVersion") == "1.0.0"
            and manifest.get("compatibility", {}).get("manualInstallerRequired") is False,
            "Candidate cannot be applied by the genuine v0.85.6 Windows broker.")
    setup = manifest.get("setup", {})
    require(setup.get("strategy") == "npm-ci-and-local-timing"
            and setup.get("packageLockSha256") == hashlib.sha256(entries["package-lock.json"]).hexdigest(),
            "Candidate reviewed Node dependency graph does not match its manifest.")
    expected_python = {
        filename: hashlib.sha256(content).hexdigest()
        for filename, content in entries.items()
        if filename.startswith("local-timing/requirements") and filename.endswith(".txt")
        and "/" not in filename[len("local-timing/"):]
    }
    actual_python = {item["path"]: item["sha256"] for item in setup.get("pythonFiles", [])}
    require(bool(expected_python) and actual_python == expected_python,
            "The OTA manifest does not bind the exact Python requirement files.")
    return manifest


def strip_inherited_psmodulepath(child: dict[str, str]) -> None:
    # pwsh.exe 7 -> Python/cmd.exe -> powershell.exe 5.1 would otherwise
    # inherit PS7 module paths and resolve incompatible Utility modules.
    # Windows PowerShell reconstructs its native defaults when this is absent.
    for key in tuple(child):
        if key.casefold() == "psmodulepath":
            child.pop(key, None)


def stripped_child_environment(local_app: Path, work: Path) -> dict[str, str]:
    child = dict(os.environ)
    strip_inherited_psmodulepath(child)
    for key in list(child):
        if (key in {"GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK",
                     "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
                     "ACTIONS_ID_TOKEN_REQUEST_URL", "NODE_OPTIONS",
                     "GOOGLE_API_KEY", "GEMINI_API_KEY",
                     "STHANG_STUDIO_UPDATE_PRIVATE_KEY_FILE"}
                or key.endswith(("_TOKEN", "_SECRET", "_PASSWORD", "_API_KEY"))):
            child.pop(key, None)
    local_app.mkdir(parents=True)
    for name in ("roaming", "temp", "npm-cache", "pip-cache", "hf-cache"):
        (work / name).mkdir(exist_ok=True)
    child.update({"LOCALAPPDATA": str(local_app), "APPDATA": str(work / "roaming"),
                  "TEMP": str(work / "temp"), "TMP": str(work / "temp"),
                  "NPM_CONFIG_CACHE": str(work / "npm-cache"),
                  "PIP_CACHE_DIR": str(work / "pip-cache"), "HF_HOME": str(work / "hf-cache"),
                  "KCS_NONINTERACTIVE": "1", "KCS_OPEN_BROWSER": "false",
                  "ORT_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                  "DO_NOT_TRACK": "1", "STHANG_STUDIO_ACCEPTANCE_RUN": "1"})
    return child


def native_powershell_hash_preflight(child_env: dict[str, str]) -> None:
    # Check the real WinPS 5.1 Utility cmdlet with the exact child environment
    # that will reach the unmodified v0.85.6 launcher and OTA setup scripts.
    script = (
        "$ErrorActionPreference = 'Stop'; "
        "if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5.1 required.' }; "
        "Get-Command -Name Get-FileHash -ErrorAction Stop | Out-Null; "
        "(Get-FileHash -LiteralPath 'scripts/ci/windows-acceptance.py' -Algorithm SHA256).Hash"
    )
    checked = run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=PROJECT, env=child_env, timeout=30,
        label="Native Windows PowerShell 5.1 SHA-256 preflight",
    )
    require(checked.stdout.decode("ascii", errors="strict").strip().lower()
            == sha256(PROJECT / "scripts/ci/windows-acceptance.py"),
            "Native Windows PowerShell 5.1 Get-FileHash did not compute the expected SHA-256.")


def desktop_preflight(runner_temp: Path) -> Path:
    """Guard the actual, untouched KnownFolder Desktop on a fresh Windows runner."""
    user = os.environ.get("USERPROFILE", "")
    require(bool(user) and Path(user).is_absolute(), "The runner USERPROFILE is invalid.")
    profile = Path(user).resolve(strict=True)
    require(profile.is_dir(), "The runner USERPROFILE does not exist.")
    observation = run([
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write([Environment]::GetFolderPath('Desktop'))",
    ], timeout=30, label="Read native Windows Desktop KnownFolder")
    raw = observation.stdout.decode("utf-8-sig").strip()
    require(bool(raw) and Path(raw).is_absolute(),
            "Windows did not return an absolute Desktop KnownFolder.")
    unexpanded = Path(raw)
    require(unexpanded.is_dir(), "The native Windows Desktop folder is missing.")
    stat = unexpanded.lstat()
    require(not unexpanded.is_symlink()
            and not (getattr(stat, "st_file_attributes", 0) & 0x400),
            "A reparse-point Desktop cannot be used for native shell acceptance.")
    desktop = unexpanded.resolve(strict=True)
    require(profile in desktop.parents and desktop != profile,
            "The actual Desktop KnownFolder must be inside the fresh runner USERPROFILE.")
    require(desktop != runner_temp and desktop not in runner_temp.parents
            and runner_temp not in desktop.parents,
            "The Desktop and temporary application state must remain separate.")
    for name in DESKTOP_SHORTCUTS:
        require(not os.path.lexists(desktop / name),
                "The fresh runner Desktop already has a Studio shortcut; no overwrite is allowed.")
    return desktop


def desktop_shortcut_action(desktop: Path, installed: Path, environment: dict[str, str], action: str) -> None:
    """Verify/remove only new link files whose COM targets are under installed."""
    require(action in ("verify", "cleanup"), "Unexpected Desktop verification action.")
    require(desktop.is_dir() and installed.is_dir(),
            "Native Desktop/installation folders must exist before COM inspection.")
    child = dict(environment)
    child.update({
        "STHANG_CI_KNOWN_DESKTOP": str(desktop),
        "STHANG_CI_INSTALLED_ROOT": str(installed),
        "STHANG_CI_SHORTCUT_ACTION": action,
    })
    script = r"""
$ErrorActionPreference = 'Stop'
$known = [Environment]::GetFolderPath('Desktop')
$expected = [Environment]::GetEnvironmentVariable('STHANG_CI_KNOWN_DESKTOP')
$root = [Environment]::GetEnvironmentVariable('STHANG_CI_INSTALLED_ROOT')
$action = [Environment]::GetEnvironmentVariable('STHANG_CI_SHORTCUT_ACTION')
if (-not $known -or -not $expected -or -not $root -or $action -cnotin @('verify','cleanup')) {
  throw 'Missing bounded native Desktop acceptance parameters.'
}
$actual = [IO.Path]::GetFullPath($known).TrimEnd('\')
$required = [IO.Path]::GetFullPath($expected).TrimEnd('\')
if (-not [string]::Equals($actual, $required, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The actual Desktop KnownFolder changed during acceptance.'
}
$install = [IO.Path]::GetFullPath($root).TrimEnd('\')
$prefix = $install + '\'
$names = @('Sthang Studio.lnk', 'Khmer Caption Studio.lnk')
$shell = New-Object -ComObject WScript.Shell
if ($action -ceq 'verify' -and -not (Test-Path -LiteralPath (Join-Path $actual $names[0]) -PathType Leaf)) {
  throw 'The unchanged Windows installer failed to create its genuine Desktop shortcut.'
}
foreach ($name in $names) {
  $shortcutPath = Join-Path $actual $name
  if (-not (Test-Path -LiteralPath $shortcutPath)) { continue }
  $item = Get-Item -LiteralPath $shortcutPath -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'A Studio shortcut name is not a normal link file; no modification is permitted.'
  }
  $target = [string]($shell.CreateShortcut($shortcutPath).TargetPath)
  if (-not $target -or -not [IO.Path]::IsPathRooted($target)) {
    throw 'A Studio shortcut has no absolute COM target; leave it unchanged.'
  }
  $target = [IO.Path]::GetFullPath($target)
  if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetFileName($target), 'run-windows.bat', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A Studio shortcut target is unrelated to this test installation; leave it unchanged.'
  }
  if ($action -ceq 'cleanup') {
    Remove-Item -LiteralPath $shortcutPath -Force
    if (Test-Path -LiteralPath $shortcutPath) { throw 'Owned shortcut cleanup did not complete.' }
  }
}
"""
    run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env=child, cwd=installed, timeout=30,
        label=f"Native runner Desktop shortcut {action}")


@contextmanager
def genuine_desktop_session(desktop: Path, installed: Path, environment: dict[str, str]):
    """Clean only COM-owned runner shortcuts, after all native children stop."""
    def cleanup() -> None:
        if installed.is_dir():
            # Cleanup mode is separately confined to GitHub Actions and this
            # run's known RUNNER_TEMP application root. It is also used if the
            # full OTA helper failed/was interrupted after spawning Studio.
            # Pass the root via environment, NOT the Node process command line:
            # Win32_Process ownership scans must never match the helper itself.
            stop_env = dict(environment)
            stop_env["STHANG_CI_STOP_ROOT"] = str(installed)
            run(["node", str(PROJECT / "scripts" / "ci" / "windows-ota-acceptance.mjs"),
                 "--stop-owned"], cwd=PROJECT, env=stop_env,
                timeout=60, label="Stop native disposable Studio processes")
            desktop_shortcut_action(desktop, installed, environment, "cleanup")

    try:
        yield
    except BaseException as original:
        try:
            cleanup()
        except Exception as cleanup_error:
            # Preserve the original native failure even if the separate
            # Desktop safety guard also fails during final cleanup.
            raise AcceptanceFailure(
                f"Primary native acceptance failure: {original}. "
                f"Secondary Desktop cleanup failure: {cleanup_error}."
            ) from original
        raise
    else:
        cleanup()


def acceptance() -> None:
    require(sys.platform == "win32" and os.environ.get("RUNNER_OS") == "Windows"
            and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_REPOSITORY", "").lower() == REPO.lower(),
            "Only an owned native GitHub Windows runner can execute this acceptance.")
    require(os.environ.get("RUNNER_ENVIRONMENT", "github-hosted") == "github-hosted",
            "Self-hosted or shared Windows profiles are not accepted.")
    require(sys.version_info[:3] == (3, 12, 15), "Exact reviewed Python 3.12.15 is required.")
    require(shutil.which("gh") is not None and shutil.which("node") is not None,
            "Native runner is missing GitHub CLI or reviewed Node.")
    require(os.environ.get("GH_TOKEN"),
            "Authenticated GitHub workflow token is required for draft release assets.")
    commit = os.environ.get("STUDIO_CANDIDATE_COMMIT", "").lower()
    recovery_sha = os.environ.get("STUDIO_RECOVERY_SHA256", "").lower()
    ota_sha = os.environ.get("STUDIO_OTA_SHA256", "").lower()
    require(bool(HEX40.fullmatch(commit)) and bool(HEX64.fullmatch(recovery_sha))
            and bool(HEX64.fullmatch(ota_sha)),
            "Exact candidate commit and two independently reviewed archive digests are required.")
    harness_sha = git("rev-parse", "HEAD")
    require(bool(HEX40.fullmatch(harness_sha))
            and harness_sha == os.environ.get("GITHUB_SHA", "").lower(),
            "Workflow checkout does not match this exact reviewed CI harness commit.")
    node_version = run(["node", "-p", "process.version + ' ' + process.arch"], label="Native Node check")
    require(node_version.stdout.decode().strip() == "v24.21.0 x64", "Exact reviewed Node 24.21.0 x64 is required.")
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(runner_temp.is_dir(), "RUNNER_TEMP must already exist.")
    desktop = desktop_preflight(runner_temp)
    # KFA/appdirs uses the native Windows cache KnownFolder, independent of a
    # process LOCALAPPDATA override. Permit this ordinary model download only
    # in an initially empty cache on this disposable GitHub-hosted profile.
    native_cache = run([
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::Out.Write([Environment]::GetFolderPath('LocalApplicationData'))",
    ], timeout=30, label="Read native KFA cache KnownFolder")
    cache_base = Path(native_cache.stdout.decode("utf-8-sig").strip()).resolve(strict=True)
    runner_profile = Path(os.environ["USERPROFILE"]).resolve(strict=True)
    require(runner_profile in cache_base.parents,
            "Native KFA cache must stay within the disposable runner profile.")
    require(not (cache_base / "kfa").exists(),
            "The runner already contains a KFA cache; use a fresh hosted runner.")
    print("Native KFA model cache uses the fresh runner's Windows KnownFolder; app state uses RUNNER_TEMP.", flush=True)
    work = runner_temp / "sthang-windows-acceptance"
    require(not work.exists(), "The acceptance work root already exists; use a fresh runner.")
    work.mkdir()
    print("Selecting exact draft/source and immutable release checksums...", flush=True)
    releases = gh_json("api", "--method", "GET", f"repos/{REPO}/releases?per_page=100")
    chosen = release(releases, f"v{CANDIDATE}")
    source_identity(chosen, commit)
    print(f"PASS: reviewed native harness {harness_sha}, accepted release candidate {commit}; "
          "draft target and fresh origin/main ancestry verified.", flush=True)
    old = release(releases, f"v{BASELINE}")
    plans = [
        (old, BASELINE, f"Sthang-Studio-Windows-v{BASELINE}.zip", BASELINE_SHA, work / "baseline"),
        (chosen, CANDIDATE, f"Sthang-Studio-Windows-v{CANDIDATE}.zip", recovery_sha, work / "candidate"),
        (chosen, CANDIDATE, f"Sthang-Studio-OTA-v{CANDIDATE}.zip", ota_sha, work / "candidate"),
    ]
    downloaded: dict[str, Path] = {}
    for metadata, version, name, digest, folder in plans:
        asset_record(metadata, name, digest)
        asset_record(metadata, name + ".sha256")
        file = download_asset("v" + version, name, folder)
        sidecar = download_asset("v" + version, name + ".sha256", folder)
        require(sha256(file) == digest, "Downloaded asset digest did not match its exact approved input.")
        verify_sidecar(sidecar, name, digest)
        downloaded[name] = file
    manifest_name = f"Sthang-Studio-OTA-v{CANDIDATE}.release.unsigned.json"
    asset_record(chosen, manifest_name)
    unsigned_path = download_asset(f"v{CANDIDATE}", manifest_name, work / "candidate")
    baseline_name = f"Sthang-Studio-Windows-v{BASELINE}.zip"
    recovery_name = f"Sthang-Studio-Windows-v{CANDIDATE}.zip"
    ota_name = f"Sthang-Studio-OTA-v{CANDIDATE}.zip"
    baseline_files = zip_files(downloaded[baseline_name], windows_recovery=True)
    candidate_files = zip_files(downloaded[recovery_name], windows_recovery=True)
    ota_files = zip_files(downloaded[ota_name])
    original = assert_payload(baseline_files, BASELINE)
    recovery = assert_payload(candidate_files, CANDIDATE)
    require(ota_files and all(name in recovery and recovery[name] == data for name, data in ota_files.items()),
            "Recovery ZIP source bytes disagree with the selected OTA candidate.")
    unsigned = candidate_manifest(unsigned_path, downloaded[ota_name], ota_files)
    require(json.loads(ota_files["package.json"]).get("version") == CANDIDATE,
            "OTA package source version is wrong.")
    for relative in ("scripts/update-runtime.mjs", "scripts/update-protocol.mjs",
                     "config/update-trust-root.json"):
        require(original[relative] != b"" and recovery[relative] != b"",
                "Baseline or target is missing nonempty signed-update controls.")
    print("PASS: GitHub asset digests/sidecars, baseline source, recovery/OTA parity and unsigned release manifest.", flush=True)
    # Compare the OTA ZIP against Git archive from the exact checked-out commit.
    archive = work / "exact-source-ota.zip"
    run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive",
         "--format=zip", "--output=" + str(archive), commit, "--", *OTA_PAYLOAD],
        label="Exact candidate source archive")
    verify_git_source_projection(ota_files, zip_files(archive))
    print("PASS: selected OTA file set and every file's bytes match the exact Git source commit.", flush=True)
    extraction = work / "baseline-extracted"
    unpack(baseline_files, extraction)
    baseline_source = extraction / f"Sthang Studio {BASELINE}" / "Sthang Studio Files"
    local_app = work / "state" / "local"
    child_env = stripped_child_environment(local_app, work)
    native_powershell_hash_preflight(child_env)
    print("PASS: native Windows PowerShell 5.1 resolved Get-FileHash and verified the CI source SHA-256.", flush=True)
    installed = local_app / "Sthang Studio" / "app"
    require(not installed.exists(), "Native test installation root must be fresh.")
    # The genuine installer and later candidate use Windows' real KnownFolder.
    # Nothing is substituted in signed or extracted release source.
    shortcut_name = "scripts/ensure-shortcut.ps1"
    shortcut_original = original[shortcut_name]
    extracted_shortcut = baseline_source / "scripts" / "ensure-shortcut.ps1"
    require(extracted_shortcut.read_bytes() == shortcut_original,
            "The baseline shortcut helper does not match genuine release bytes.")
    require(recovery[shortcut_name] == ota_files[shortcut_name],
            "The recovery and OTA candidate shell helpers differ.")
    for name in DESKTOP_SHORTCUTS:
        require(not os.path.lexists(desktop / name),
                "A Studio shortcut appeared before installation; no overwrite is allowed.")
    print("Installing the genuine, checksum-verified Windows 0.85.6 baseline...", flush=True)
    installer = baseline_source / "scripts" / "install-release-package.ps1"
    with genuine_desktop_session(desktop, installed, child_env):
        run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(installer), "-SourceRoot", str(baseline_source)],
            cwd=baseline_source, env=child_env, timeout=3600,
            label="Genuine 0.85.6 Windows installation", log=work / "native-0856-install.log")
        require(json.loads((installed / "package.json").read_text("utf-8")).get("version") == BASELINE,
                "The genuine Windows bootstrap did not install 0.85.6.")
        require((installed / shortcut_name).read_bytes() == shortcut_original,
                "The installed baseline shell helper was unexpectedly modified.")
        desktop_shortcut_action(desktop, installed, child_env, "verify")
        trust_file = installed / "config" / "update-trust-root.json"
        require(sha256(trust_file) == hashlib.sha256(original["config/update-trust-root.json"]).hexdigest(),
                "The baseline installation changed its production public trust root.")
        print("PASS: real 0.85.6 setup with original public trust and runner Desktop integration.", flush=True)
        node_script = PROJECT / "scripts" / "ci" / "windows-ota-acceptance.mjs"
        # The native OTA helper requires its workspace to be disjoint from the
        # installed app; both are sibling directories under this runner's work.
        ota_work = work / "native-ota"
        require(not ota_work.exists(), "The native OTA fixture work root must be fresh.")
        ota_work.mkdir()
        request = {"installedRoot": str(installed), "workRoot": str(ota_work),
                   "candidateZip": str(downloaded[ota_name]),
                   "unsignedManifest": str(unsigned_path), "expectedCommit": commit}
        child_env["STUDIO_WINDOWS_OTA_REQUEST"] = json.dumps(request, separators=(",", ":"))
        # The genuine 0.85.6 source uses tsx; no compiled server dist is made.
        # Its original launcher and candidate OTA shell helpers remain intact.
        run(["node", "--import", "tsx", str(node_script)], cwd=installed,
            env=child_env, timeout=80 * 60,
            label="Genuine installed Windows broker OTA acceptance", log=work / "native-windows-ota.log")
        desktop_shortcut_action(desktop, installed, child_env, "verify")
        print("PASS: native old-broker OTA health/state and explicitly synthetic rollback cases.", flush=True)
    for name in DESKTOP_SHORTCUTS:
        require(not os.path.lexists(desktop / name),
                "Owned runner Desktop shortcuts were not cleaned after native shutdown.")
    print("PASS: runner Desktop shortcuts cleaned only after the native children stopped.", flush=True)
    print("WINDOWS 0.85.6 -> 0.86.0 NATIVE FIXTURE ACCEPTANCE PASS; production signature/pointer not exercised.", flush=True)


def self_test(actual_recovery: Path | None = None) -> None:
    assert HEX40.fullmatch("a" * 40) and HEX64.fullmatch(BASELINE_SHA)
    assert safe_name("apps/server/src/index.ts") == "apps/server/src/index.ts"
    sample_environment = {
        "PSModulePath": "PS7-user-modules", "PSMODULEPATH": "PS7-system-modules",
        "psmodulepath": "PS7-built-in-modules", "PATH": "unchanged-PATH",
        "LOCALAPPDATA": "unchanged-LOCALAPPDATA",
    }
    strip_inherited_psmodulepath(sample_environment)
    assert sample_environment == {"PATH": "unchanged-PATH",
                                  "LOCALAPPDATA": "unchanged-LOCALAPPDATA"}
    simulated_work = Path("runner-temp") / "sthang-windows-acceptance"
    simulated_install = simulated_work / "state" / "local" / "Sthang Studio" / "app"
    simulated_ota_work = simulated_work / "native-ota"
    simulated_candidate = simulated_work / "candidate" / f"Sthang-Studio-OTA-v{CANDIDATE}.zip"
    assert (not simulated_install.is_relative_to(simulated_ota_work)
            and not simulated_ota_work.is_relative_to(simulated_install)
            and not simulated_candidate.is_relative_to(simulated_ota_work)
            and simulated_install.is_relative_to(simulated_work)
            and simulated_ota_work.is_relative_to(simulated_work))
    source_files = {"apps/server/src/index.ts": b"source",
                    "package.json": b'{"version":"0.86.0"}'}
    verify_git_source_projection(dict(source_files), source_files)
    # Repacked archives may have different compression and therefore different
    # whole-ZIP hashes while still containing identical reviewed source bytes.
    stored, compressed = io.BytesIO(), io.BytesIO()
    for target, method in ((stored, zipfile.ZIP_STORED),
                           (compressed, zipfile.ZIP_DEFLATED)):
        with zipfile.ZipFile(target, "w", compression=method) as writer:
            for name, data in source_files.items():
                writer.writestr(name, data)
    assert hashlib.sha256(stored.getvalue()).digest() != hashlib.sha256(compressed.getvalue()).digest()
    verify_git_source_projection(zip_files(stored), zip_files(compressed))
    for invalid in (
        {"apps/server/src/index.ts": b"tampered",
         "package.json": source_files["package.json"]},
        {"package.json": source_files["package.json"]},
        {**source_files, "unexpected.txt": b"extra"},
    ):
        try:
            verify_git_source_projection(invalid, source_files)
        except AcceptanceFailure:
            pass
        else:
            raise AssertionError("Git source projection accepted tampered, missing or extra file.")
    sample = [
        {"tag_name": "v0.85.6", "draft": False, "assets": []},
        {"tag_name": "v0.86.0", "draft": True, "assets": []},
    ]
    assert release(sample, "v0.86.0") is sample[1]
    assert release(sample, "v0.85.6") is sample[0]
    for records, tag in (
        (sample, "v0.86"),
        (sample + [sample[1].copy()], "v0.86.0"),
        ([{"tag_name": "v0.86.0", "draft": True}], "v0.86.0"),
    ):
        try:
            release(records, tag)
        except AcceptanceFailure:
            pass
        else:
            raise AssertionError("Missing, duplicate or malformed draft release was accepted.")

    def fixture(*names: str) -> io.BytesIO:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as writer:
            for name in names:
                # Python's ZipInfo constructor canonicalizes separators on
                # Windows. Set the member name afterward to exercise raw .NET
                # backslash entries and malformed mixed-separator archives.
                record = zipfile.ZipInfo("placeholder")
                record.filename = name
                writer.writestr(record, b"fixture contents")
        stream.seek(0)
        return stream

    genuine_windows_style = fixture(
        r"Sthang Studio 0.86.0\Install Sthang Studio.bat",
        r"Sthang Studio 0.86.0\Sthang Studio Files\scripts\update-runtime.mjs",
    )
    files = zip_files(genuine_windows_style, windows_recovery=True)
    assert sorted(files) == [
        "Sthang Studio 0.86.0/Install Sthang Studio.bat",
        "Sthang Studio 0.86.0/Sthang Studio Files/scripts/update-runtime.mjs",
    ]
    assert zip_files(fixture("source/scripts/update-runtime.mjs")) == {
        "source/scripts/update-runtime.mjs": b"fixture contents",
    }

    def must_reject(names: tuple[str, ...], *, recovery: bool = True) -> None:
        try:
            zip_files(fixture(*names), windows_recovery=recovery)
        except AcceptanceFailure:
            return
        raise AssertionError(f"Unsafe archive path or collision was accepted: {names!r}")

    # The strict OTA/Git parser must continue refusing Windows-style paths.
    must_reject((r"source\scripts\update-runtime.mjs",), recovery=False)
    for unsafe in (
        r"..\escape.txt",
        r"Root\..\escape.txt",
        r"Root/subdir\..\escape.txt",
        r"C:\escape.txt",
        r"C:escape.txt",
        r"\\server\share\escape.txt",
        r"Root\CON.txt",
        r"Root\\double-separator.txt",
    ):
        must_reject((unsafe,))
    for duplicates in (
        (r"Root\file.txt", "Root/file.txt"),
        (r"Root\File.TXT", "root/file.txt"),
    ):
        must_reject(duplicates)

    link = io.BytesIO()
    with zipfile.ZipFile(link, "w") as writer:
        record = zipfile.ZipInfo("placeholder")
        record.filename = r"Root\linked-file"
        record.create_system = 3
        record.external_attr = 0o120777 << 16
        writer.writestr(record, b"link target")
    link.seek(0)
    try:
        zip_files(link, windows_recovery=True)
    except AcceptanceFailure:
        pass
    else:
        raise AssertionError("Windows recovery ZIP symlink was accepted")

    if actual_recovery is not None:
        require(actual_recovery.name == f"Sthang-Studio-Windows-v{CANDIDATE}.zip",
                "The real recovery self-test requires the reviewed candidate filename.")
        actual_files = zip_files(actual_recovery, windows_recovery=True)
        assert_payload(actual_files, CANDIDATE)
        print(f"PASS: real Windows v{CANDIDATE} recovery ZIP ({len(actual_files)} normalized file entries).")
    print("Windows acceptance helper static guards PASS (no native installation).")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"] and len(sys.argv) in (2, 3):
        self_test(Path(sys.argv[2]) if len(sys.argv) == 3 else None)
    else:
        try:
            require(not sys.argv[1:], "Unexpected Windows acceptance helper arguments.")
            acceptance()
        except (AcceptanceFailure, ValueError, KeyError, OSError, subprocess.TimeoutExpired,
                zipfile.BadZipFile) as exc:
            print(f"WINDOWS ACCEPTANCE FAILED: {exc}", file=sys.stderr)
            sys.exit(1)
