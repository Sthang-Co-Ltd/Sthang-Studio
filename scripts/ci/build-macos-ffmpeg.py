#!/usr/bin/env python3
"""Build and audit FFmpeg 8.1.3 for native Apple Silicon from exact source pins.

This is an evidence generator, never an installer or publisher. A separately
reviewed JSON lock names the source for every compiler-built dependency,
including the Meson, Ninja and pkgconf build tools. The Xcode clang, SDK and
system make are native runner inputs whose exact identities go in the receipt.
No package manager, git clone, signing key or release API is used.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCK = ROOT / "config/macos-ffmpeg-build-lock.json"
WORKFLOW = ROOT / ".github/workflows/macos-ffmpeg-runtime.yml"
EXPECTED_SOURCES = {
    "meson", "ninja", "pkgconf", "freetype", "fribidi",
    "harfbuzz", "libass", "x264", "ffmpeg",
}
VERSION = "8.1.3"
MIN_MACOS = "12.3"
MAX_DOWNLOAD = 90 * 1024 * 1024
MAX_EXTRACTED = 400 * 1024 * 1024
MAX_ENTRIES = 30000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ARCHIVE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*\.(?:tar\.gz|tar\.bz2|tar\.xz|zip)$")
PROTECTED = {"..", "", "."}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class BuildFailure(RuntimeError):
    """A missing or unverified prerequisite must stop the release candidate."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildFailure(message)


def digest(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def json_text(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=True, sort_keys=True, indent=2) + "\n"


def within_path(root: pathlib.Path, relative: str) -> pathlib.Path:
    require(isinstance(relative, str) and relative != "", "An archive path is missing.")
    require(not relative.startswith("/") and "\\" not in relative
            and not any(ord(ch) < 32 for ch in relative), "Unsafe archive path: " + relative)
    parts = pathlib.PurePosixPath(relative).parts
    require(parts and not any(part in PROTECTED or ":" in part for part in parts),
            "Unsafe archive path: " + relative)
    return root.joinpath(*parts)


def check_lock(path: pathlib.Path) -> dict:
    require(path.is_file(), "Missing reviewed FFmpeg build lock: " + str(path))
    data = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(data, dict) and data.get("schemaVersion") == 1,
            "Unsupported FFmpeg build lock schema.")
    target = data.get("target")
    require(isinstance(target, dict), "Missing FFmpeg target in source lock.")
    for name, expected in (("platform", "macos-arm64"), ("minMacos", MIN_MACOS),
                           ("ffmpegVersion", VERSION)):
        require(target.get(name) == expected, "Unreviewed FFmpeg target: " + name)
    epoch = target.get("sourceDateEpoch")
    require(type(epoch) is int and 946684800 <= epoch <= 4102444800,
            "Source-date epoch must be a fixed Unix timestamp in the reviewed lock.")
    toolchain = data.get("toolchain")
    require(isinstance(toolchain, dict)
            and toolchain.get("runner") == "macos-15"
            and toolchain.get("architecture") == "arm64"
            and toolchain.get("developerDir") == "/Applications/Xcode_16.4.app/Contents/Developer"
            and toolchain.get("xcodeVersion") == "16.4"
            and toolchain.get("xcodeBuild") == "16F6"
            and toolchain.get("macosSdkVersion") == "15.5"
            and toolchain.get("pythonVersion") == "3.12.15"
            and toolchain.get("deploymentTarget") == MIN_MACOS,
            "Builder requires the exact reviewed Xcode 16.4 / SDK 15.5 / Python 3.12.15 arm64 lock.")
    policy = data.get("buildPolicy")
    require(isinstance(policy, dict), "Missing reviewed static FFmpeg build policy.")
    require(policy.get("environment", {}).get("MACOSX_DEPLOYMENT_TARGET") == MIN_MACOS
            and policy.get("environment", {}).get("SOURCE_DATE_EPOCH") == str(epoch),
            "FFmpeg build policy environment does not match its target.")
    require(set(policy.get("requiredFfmpegConfigure", [])) == {
        "--enable-gpl", "--enable-version3", "--enable-static", "--disable-shared",
        "--enable-libass", "--enable-libharfbuzz", "--enable-libx264",
        "--disable-autodetect", "--disable-doc", "--disable-ffplay", "--disable-debug",
    }, "Unreviewed required FFmpeg build-feature policy.")
    require(set(policy.get("forbiddenFfmpegConfigure", [])) == {
        "--enable-nonfree", "--enable-openssl", "--enable-libfdk-aac",
        "--enable-librtmp", "--enable-libfontconfig",
    }, "Unreviewed forbidden FFmpeg build-feature policy.")
    sources = data.get("sources")
    require(isinstance(sources, list) and len(sources) == len(EXPECTED_SOURCES),
            "Expected exactly nine pinned sources, including Meson, Ninja and pkgconf.")
    by_name = {}
    archives = set()
    for source in sources:
        require(isinstance(source, dict), "Invalid FFmpeg source record.")
        name = source.get("name")
        require(isinstance(name, str) and name in EXPECTED_SOURCES and name not in by_name,
                "Unexpected, missing or duplicate pinned FFmpeg source.")
        require(isinstance(source.get("version"), str) and bool(source["version"].strip()),
                "Source " + name + " is missing an exact version or commit.")
        require(source.get("entrypoint") in {
            "configure", "meson.py", "meson.build", "configure.py --bootstrap",
        }, "Pinned source " + name + " does not declare an accepted source build entrypoint.")
        filename = source.get("archive")
        require(isinstance(filename, str) and bool(ARCHIVE_RE.fullmatch(filename))
                and filename not in archives, "Unreviewed source archive name: " + name)
        archives.add(filename)
        url = source.get("url")
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        require(parsed is not None and parsed.scheme == "https" and parsed.hostname
                and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and bool(parsed.path),
                "Source URL must be an exact HTTPS archive address without credentials: " + name)
        sha = source.get("sha256")
        require(isinstance(sha, str) and bool(SHA256_RE.fullmatch(sha))
                and sha != "0" * 64, "Source " + name + " lacks an exact SHA-256 pin.")
        licenses = source.get("licensePaths")
        require(isinstance(licenses, list) and len(licenses) > 0 and len(set(licenses)) == len(licenses),
                "Source " + name + " must declare actual license paths.")
        for license_path in licenses:
            require(isinstance(license_path, str), "Invalid license path for " + name)
            within_path(pathlib.Path("license-check"), license_path)
        by_name[name] = source
    require(set(by_name) == EXPECTED_SOURCES, "Some required FFmpeg sources are not pinned.")
    require(by_name["ffmpeg"]["version"] == VERSION,
            "FFmpeg source must be the exact 8.1.3 release.")
    return {"target": target, "toolchain": toolchain, "buildPolicy": policy,
            "sources": by_name, "lockSha256": digest(path)}


def native_identity() -> dict:
    require(platform.system() == "Darwin" and platform.machine() == "arm64",
            "This builder must run natively on Apple Silicon arm64.")
    require(platform.mac_ver()[0].split(".")[0] == "15",
            "The reviewed builder requires the native macOS 15 arm64 runner.")
    return {"system": platform.system(), "architecture": platform.machine(),
            "platform": platform.platform(), "python": sys.version.split()[0]}


def captured(argv: list[str], *, cwd: pathlib.Path | None = None,
             env: dict | None = None) -> str:
    proc = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True,
                          errors="replace", timeout=90, check=False)
    require(proc.returncode == 0, "Failed to inspect build tool: "
            + shlex.join(argv) + "\n" + (proc.stdout + proc.stderr)[-2000:])
    return (proc.stdout + proc.stderr).strip()


class Builder:
    def __init__(self, lock: dict, work: pathlib.Path):
        self.lock = lock
        self.work = work
        self.archives = work / "archives"
        self.sources = work / "source"
        self.builds = work / "build"
        self.tools = work / "build-tools"
        self.prefix = work / "static-prefix"
        self.logs = work / "logs"
        self.artifacts = work / "artifacts"
        self.source_paths: dict[str, pathlib.Path] = {}
        self.downloads: dict[str, pathlib.Path] = {}
        self.commands: list[dict] = []
        self.make_jobs = str(min(max(os.cpu_count() or 2, 2), 8))
        self.env: dict[str, str] = {}
        self.sdk = ""
        self.meson_script = ""

    def prepare(self) -> None:
        # An explicitly new working directory prevents accidental deletion of
        # unrelated caches, previous runs or owner-owned release artifacts.
        require(not self.work.exists(), "Build destination already exists: " + str(self.work))
        host = self.lock["toolchain"]
        require(platform.python_version() == host["pythonVersion"],
                "Native builder Python does not match the reviewed Python 3.12.15 lock.")
        selected_developer_dir = pathlib.Path(host["developerDir"])
        require(selected_developer_dir.is_dir(),
                "Reviewed Xcode 16.4 developer directory is not installed.")
        xcode_env = dict(os.environ, DEVELOPER_DIR=str(selected_developer_dir))
        xcode = captured(["/usr/bin/xcodebuild", "-version"], env=xcode_env)
        require(xcode.splitlines() == [
            "Xcode " + host["xcodeVersion"], "Build version " + host["xcodeBuild"]],
            "Installed Xcode version/build is different from the reviewed toolchain.")
        observed_sdk = captured(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"], env=xcode_env)
        require(observed_sdk == host["macosSdkVersion"],
                "Selected SDK differs from reviewed macOS 15.5 SDK.")
        for directory in (self.archives, self.sources, self.builds, self.tools,
                          self.prefix / "bin", self.logs, self.artifacts):
            directory.mkdir(parents=True, exist_ok=True)
        self.sdk = captured(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], env=xcode_env)
        require(pathlib.Path(self.sdk).is_dir(), "Selected Xcode SDK does not exist.")
        self.env = dict(os.environ)
        self.env.update({
            "PATH": str(self.tools / "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin",
            "DEVELOPER_DIR": str(selected_developer_dir),
            "MACOSX_DEPLOYMENT_TARGET": MIN_MACOS,
            "SDKROOT": self.sdk,
            "CC": "/usr/bin/clang",
            "CXX": "/usr/bin/clang++",
            "CFLAGS": "-arch arm64 -mmacosx-version-min=" + MIN_MACOS + " -O2 -fPIC",
            "CXXFLAGS": "-arch arm64 -mmacosx-version-min=" + MIN_MACOS + " -O2 -fPIC",
            "CPPFLAGS": "-I" + str(self.prefix / "include"),
            "LDFLAGS": "-arch arm64 -mmacosx-version-min=" + MIN_MACOS + " -L" + str(self.prefix / "lib"),
            "PKG_CONFIG_LIBDIR": str(self.prefix / "lib/pkgconfig") + ":" + str(self.prefix / "share/pkgconfig"),
            "PKG_CONFIG_PATH": "",
            "PKG_CONFIG_SYSROOT_DIR": "",
            "SOURCE_DATE_EPOCH": str(self.lock["target"]["sourceDateEpoch"]),
            "ZERO_AR_DATE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LC_ALL": "C",
            "TZ": "UTC",
        })
        # Do not allow ambient Homebrew build paths to influence native linking.
        for key in ("CPATH", "LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
                    "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "CCACHE_DIR"):
            self.env.pop(key, None)
        # Build helpers need no GitHub/Actions signing, publishing, or cloud
        # credentials. Exclude them from every downloaded source's child process.
        for key in list(self.env):
            if (key in {
                "GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL",
                "ACTIONS_RUNTIME_URL", "ACTIONS_RESULTS_URL", "SSH_AUTH_SOCK",
                "GIT_ASKPASS",
            } or key.endswith(("_TOKEN", "_SECRET", "_PASSWORD", "_API_KEY"))):
                self.env.pop(key, None)

    def run(self, label: str, argv: list[str], *, cwd: pathlib.Path | None = None,
            timeout: int = 2400) -> str:
        require(bool(argv) and all(isinstance(item, str) and item for item in argv),
                "Invalid build command.")
        log = self.logs / (label + ".log")
        print("BUILD:", label, flush=True)
        entry = {"step": label, "argv": argv, "cwd": str(cwd) if cwd else None,
                 "log": "logs/" + log.name}
        self.commands.append(entry)
        with log.open("w", encoding="utf-8") as stream:
            stream.write("Command: " + shlex.join(argv) + "\n")
            stream.write("Working directory: " + str(cwd) + "\n")
            stream.flush()
            try:
                proc = subprocess.run(argv, cwd=cwd, env=self.env, stdout=stream,
                                      stderr=subprocess.STDOUT, check=False, timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                raise BuildFailure("Build step timed out: " + label) from exc
        if proc.returncode != 0:
            raise BuildFailure("Build step " + label + " failed (" + str(proc.returncode)
                               + "). Last log output:\n"
                               + log.read_text(encoding="utf-8", errors="replace")[-8000:])
        return digest(log)

    def download(self, name: str) -> None:
        source = self.lock["sources"][name]
        filename = source["archive"]
        target = self.archives / filename
        req = urllib.request.Request(source["url"], headers={
            "User-Agent": "Sthang-Studio-FFmpeg-provenance-builder/1",
            "Accept-Encoding": "identity",
        })
        total = 0
        h = hashlib.sha256()
        print("SOURCE:", name, source["version"], flush=True)
        try:
            with urllib.request.urlopen(req, timeout=90) as response, target.open("xb") as sink:
                end = urllib.parse.urlsplit(response.url)
                require(end.scheme == "https", "Source redirected to non-HTTPS origin: " + name)
                declared = response.headers.get("content-length")
                require(declared is None or int(declared) <= MAX_DOWNLOAD,
                        "Pinned source archive exceeds size ceiling: " + name)
                while True:
                    part = response.read(1024 * 1024)
                    if not part:
                        break
                    total += len(part)
                    require(total <= MAX_DOWNLOAD, "Pinned source download is oversized: " + name)
                    h.update(part)
                    sink.write(part)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        require(total > 0 and h.hexdigest() == source["sha256"],
                "Source bytes do not match the reviewed SHA-256 pin: " + name)
        self.downloads[name] = target

    def extract(self, name: str) -> None:
        filename = self.downloads[name]
        destination = self.sources / name
        destination.mkdir()
        top_roots: set[str] = set()
        extracted = 0
        count = 0
        seen_files: set[str] = set()

        def write_member(member_name: str, file_object: object, size: int, executable: bool) -> None:
            nonlocal extracted, count
            raw = member_name.rstrip("/")
            path = within_path(destination, raw)
            pieces = pathlib.PurePosixPath(raw).parts
            require(len(pieces) > 0, "Empty source archive member.")
            top_roots.add(pieces[0])
            count += 1
            require(count <= MAX_ENTRIES, "Source archive has too many entries: " + name)
            extracted += size
            require(extracted <= MAX_EXTRACTED, "Source archive expansion exceeded limit: " + name)
            if file_object is None:
                path.mkdir(parents=True, exist_ok=True)
                return
            require(raw not in seen_files and path != destination, "Duplicate source file: " + raw)
            seen_files.add(raw)
            path.parent.mkdir(parents=True, exist_ok=True)
            require(not path.exists(), "Source archive overwrote another member: " + raw)
            with path.open("xb") as stream:
                remaining = size
                while remaining:
                    block = file_object.read(min(1024 * 1024, remaining))
                    require(bool(block), "Truncated source archive member: " + raw)
                    stream.write(block)
                    remaining -= len(block)
            path.chmod(0o755 if executable else 0o644)

        if filename.suffix == ".zip":
            with zipfile.ZipFile(filename) as archive:
                for member in archive.infolist():
                    kind = (member.external_attr >> 16) & 0o170000
                    require(kind != stat.S_IFLNK, "Source archives must not contain symlinks.")
                    require(kind in (0, stat.S_IFREG, stat.S_IFDIR), "Source archive has special files.")
                    if member.is_dir():
                        write_member(member.filename, None, 0, False)
                    else:
                        with archive.open(member) as stream:
                            write_member(member.filename, stream, member.file_size,
                                         bool((member.external_attr >> 16) & 0o111))
        else:
            with tarfile.open(filename, mode="r:*") as archive:
                for member in archive:
                    if member.issym():
                        # The exact SHA-pinned HarfBuzz 14.6.0 release aliases
                        # CLAUDE.md to its regular AGENTS.md documentation.
                        # Materialize those authenticated bytes, never follow
                        # an archive-controlled link into the host filesystem.
                        require(name == "harfbuzz"
                                and member.name.endswith("/CLAUDE.md")
                                and member.linkname == "AGENTS.md",
                                "Unreviewed source archive symlink: " + member.name)
                        target_name = str(
                            pathlib.PurePosixPath(member.name).parent / member.linkname)
                        target_info = archive.getmember(target_name)
                        require(target_info.isfile(),
                                "Reviewed HarfBuzz documentation link target is not a regular file.")
                        target_stream = archive.extractfile(target_info)
                        require(target_stream is not None,
                                "Reviewed HarfBuzz documentation target cannot be read.")
                        with target_stream:
                            write_member(member.name, target_stream, target_info.size, False)
                        continue
                    require(member.isfile() or member.isdir(),
                            "Source archive has links or unsupported member type: " + member.name)
                    if member.isdir():
                        write_member(member.name, None, 0, False)
                    else:
                        stream = archive.extractfile(member)
                        require(stream is not None, "Could not read source archive entry.")
                        with stream:
                            write_member(member.name, stream, member.size, bool(member.mode & 0o111))
        require(len(top_roots) == 1, "Source archive needs one unambiguous top-level directory: " + name)
        source_root = destination / next(iter(top_roots))
        require(source_root.is_dir(), "Source archive root is missing: " + name)
        entrypoint = self.lock["sources"][name]["entrypoint"].split()[0]
        require((source_root / entrypoint).is_file(),
                "Pinned source does not contain its reviewed build entrypoint: " + name)
        for license_path in self.lock["sources"][name]["licensePaths"]:
            license_file = within_path(source_root, license_path)
            require(license_file.is_file() and not license_file.is_symlink(),
                    "Pinned source is missing required license file: " + name + "/" + license_path)
        self.source_paths[name] = source_root

    def bootstrap_tools(self) -> None:
        tools_bin = self.tools / "bin"
        pkgconf_root = self.source_paths["pkgconf"]
        require((pkgconf_root / "configure").is_file(), "Pinned pkgconf needs a dist archive with configure.")
        self.run("pkgconf-configure",
                 ["/bin/bash", "configure", "--prefix=" + str(self.tools),
                  "--disable-shared", "--enable-static"], cwd=pkgconf_root)
        self.run("pkgconf-make", ["/usr/bin/make", "-j", self.make_jobs], cwd=pkgconf_root)
        self.run("pkgconf-install", ["/usr/bin/make", "install"], cwd=pkgconf_root)
        pkgconf = tools_bin / "pkgconf"
        require(pkgconf.is_file(), "Pinned pkgconf did not install a pkgconf binary.")
        if not (tools_bin / "pkg-config").exists():
            (tools_bin / "pkg-config").symlink_to("pkgconf")

        meson_root = self.source_paths["meson"]
        self.meson_script = str(meson_root / "meson.py")
        require(pathlib.Path(self.meson_script).is_file(), "Pinned Meson lacks its standalone meson.py.")
        ninja_root = self.source_paths["ninja"]
        require((ninja_root / "configure.py").is_file(), "Pinned Ninja lacks source bootstrap.")
        self.run("ninja-bootstrap", [sys.executable, "configure.py", "--bootstrap"],
                 cwd=ninja_root)
        ninja = ninja_root / "ninja"
        require(ninja.is_file(), "Pinned Ninja bootstrap failed to produce a binary.")
        shutil.copy2(ninja, tools_bin / "ninja")
        (tools_bin / "ninja").chmod(0o755)
        for label, argv in (
            ("ninja", [str(tools_bin / "ninja"), "--version"]),
            ("pkgconf", [str(tools_bin / "pkgconf"), "--version"]),
            ("meson", [sys.executable, self.meson_script, "--version"]),
        ):
            self.commands.append({"step": "tool-version-" + label, "argv": argv,
                                  "result": captured(argv, env=self.env)})

    def meson_build(self, name: str, options: list[str]) -> None:
        build = self.builds / name
        source = self.source_paths[name]
        config = [
            sys.executable, self.meson_script, "setup", str(build), str(source),
            "--prefix=" + str(self.prefix), "--libdir=lib",
            "--buildtype=release", "--default-library=static", "--wrap-mode=nodownload",
            *options,
        ]
        self.run(name + "-configure", config)
        self.run(name + "-compile", [sys.executable, self.meson_script, "compile",
                                     "-C", str(build), "-j", self.make_jobs])
        self.run(name + "-install", [sys.executable, self.meson_script, "install",
                                     "-C", str(build), "--no-rebuild"])

    def autoconf_build(self, name: str, options: list[str]) -> None:
        source = self.source_paths[name]
        require((source / "configure").is_file(), name + " source lacks generated configure.")
        self.run(name + "-configure",
                 ["/bin/bash", "configure", "--prefix=" + str(self.prefix),
                  "--disable-shared", "--enable-static", *options], cwd=source)
        self.run(name + "-make", ["/usr/bin/make", "-j", self.make_jobs], cwd=source)
        self.run(name + "-install", ["/usr/bin/make", "install"], cwd=source)

    def build_dependencies(self) -> None:
        # Remove optional dynamic dependencies by building a closed static
        # prefix. libass uses native CoreText font discovery and HarfBuzz's
        # built-in Unicode shaper; no additional system font library is linked.
        self.autoconf_build("freetype", [
            "--without-bzip2", "--without-png", "--without-harfbuzz",
            "--without-brotli", "--without-zlib",
        ])
        self.autoconf_build("fribidi", ["--disable-docs"])
        self.meson_build("harfbuzz", [
            "-Dglib=disabled", "-Dgobject=disabled", "-Dcairo=disabled",
            "-Dicu=disabled", "-Dgraphite2=disabled", "-Dfreetype=disabled",
            "-Dcoretext=disabled", "-Dfontations=disabled", "-Dharfrust=disabled",
            "-Dzlib=disabled", "-Dpng=disabled", "-Draster=disabled",
            "-Dvector=disabled", "-Dgpu=disabled", "-Dsubset=disabled",
            "-Dtests=disabled", "-Ddocs=disabled", "-Dutilities=disabled",
        ])
        self.autoconf_build("libass", [
            "--enable-coretext", "--disable-fontconfig",
            "--disable-directwrite", "--disable-libunibreak",
            "--enable-require-system-font-provider",
            "--disable-test", "--disable-compare", "--disable-asm",
        ])
        for library in ("libfreetype.a", "libfribidi.a", "libharfbuzz.a", "libass.a"):
            require((self.prefix / "lib" / library).is_file(),
                    "Required static shaping library is missing: " + library)
        # Build x264 with its own source-distribution configure. Keep arm64
        # assembly enabled; the standalone CLI and OpenCL are not needed for
        # libx264 and would introduce additional runtime surfaces.
        x264_source = self.source_paths["x264"]
        require((x264_source / "configure").is_file(), "Pinned x264 lacks its own configure.")
        # Unlike Autotools, x264 has no --disable-shared option. Its build is
        # static-only by default; request static explicitly and verify outputs.
        self.run("x264-configure", [
            "/bin/bash", "configure", "--prefix=" + str(self.prefix),
            "--enable-static", "--disable-cli", "--disable-opencl", "--enable-pic",
        ], cwd=x264_source)
        self.run("x264-make", ["/usr/bin/make", "-j", self.make_jobs], cwd=x264_source)
        self.run("x264-install", ["/usr/bin/make", "install"], cwd=x264_source)
        require((self.prefix / "lib/libx264.a").is_file(),
                "Pinned x264 did not produce the required static library.")
        require(not any(self.prefix.glob("lib/libx264*.dylib")),
                "x264 unexpectedly installed a dynamic library.")
        for name, package in (
            ("freetype", "freetype2"), ("fribidi", "fribidi"),
            ("harfbuzz", "harfbuzz"), ("libass", "libass"), ("x264", "x264"),
        ):
            output = captured([str(self.tools / "bin/pkgconf"), "--static", "--libs", package],
                              env=self.env)
            require(bool(output) and "-L" + str(self.prefix / "lib") in output,
                    "Static pkgconf source is incomplete: " + name)
            self.commands.append({"step": "static-pkgconf-" + name, "output": output})

    def build_ffmpeg(self) -> None:
        source = self.source_paths["ffmpeg"]
        require((source / "configure").is_file(), "FFmpeg 8.1.3 source lacks configure.")
        options = [
            "--prefix=" + str(self.prefix),
            "--arch=aarch64", "--target-os=darwin",
            "--cc=/usr/bin/clang", "--cxx=/usr/bin/clang++",
            "--pkg-config=" + str(self.tools / "bin/pkgconf"),
            "--pkg-config-flags=--static",
            "--extra-cflags=-arch arm64 -mmacosx-version-min=" + MIN_MACOS + " -I" + str(self.prefix / "include"),
            "--extra-ldflags=-arch arm64 -mmacosx-version-min=" + MIN_MACOS + " -L" + str(self.prefix / "lib"),
            # HarfBuzz static objects require Apple's native libc++ runtime.
            # libass CoreText font lookup uses Apple system frameworks only.
            "--extra-libs=-lc++ -framework ApplicationServices -framework CoreFoundation",
            "--disable-shared", "--enable-static",
            "--disable-autodetect", "--disable-debug", "--disable-doc",
            "--disable-ffplay", "--enable-ffmpeg", "--enable-ffprobe",
            "--enable-gpl", "--enable-version3",
            "--enable-libass", "--enable-libharfbuzz",
            "--enable-libfribidi", "--enable-libfreetype",
            "--enable-libx264",
            # Apple's SDK provides /usr/lib/libz, with no external source
            # dependency. Keep PNG and compressed-media baseline behavior
            # despite explicit third-party --disable-autodetect.
            "--enable-zlib",
            "--enable-pic",
        ]
        require(not any("--enable-nonfree" in item or "--enable-openssl" in item
                        for item in options), "Forbidden FFmpeg license/configuration.")
        self.run("ffmpeg-configure", ["/bin/bash", "configure", *options], cwd=source)
        self.run("ffmpeg-make", ["/usr/bin/make", "-j", self.make_jobs], cwd=source, timeout=3600)
        self.run("ffmpeg-install", ["/usr/bin/make", "install"], cwd=source)
        self.commands.append({"step": "ffmpeg-options", "argv": options})

    def toolchain_receipt(self) -> dict:
        sdk_settings = pathlib.Path(self.sdk) / "SDKSettings.json"
        require(sdk_settings.is_file(), "Selected macOS SDK lacks SDKSettings.json.")
        tracked_executables = {
            "clang": pathlib.Path(captured(["/usr/bin/xcrun", "--find", "clang"], env=self.env)),
            "clang++": pathlib.Path(captured(["/usr/bin/xcrun", "--find", "clang++"], env=self.env)),
            "make": pathlib.Path("/usr/bin/make"),
            "python": pathlib.Path(sys.executable),
            "tar": pathlib.Path("/usr/bin/tar"),
            "sh": pathlib.Path("/bin/sh"),
        }
        for label, executable in tracked_executables.items():
            require(executable.resolve().is_file(), "Required host executable is absent: " + label)
        identities = {
            "runnerImage": os.environ.get("ImageOS", "") + " " + os.environ.get("ImageVersion", ""),
            "developerDir": self.env["DEVELOPER_DIR"],
            "sdkPath": self.sdk,
            "sdkVersion": captured(["/usr/bin/xcrun", "--sdk", "macosx",
                                    "--show-sdk-version"], env=self.env),
            "sdkSettingsSha256": digest(sdk_settings),
            "executables": {
                label: {"path": str(executable), "resolvedPath": str(executable.resolve()),
                        "sha256": digest(executable.resolve())}
                for label, executable in tracked_executables.items()
            },
            "compiler": captured(["/usr/bin/clang", "--version"], env=self.env),
            "compilerCpp": captured(["/usr/bin/clang++", "--version"], env=self.env),
            "xcode": captured(["/usr/bin/xcodebuild", "-version"], env=self.env),
            "macos": captured(["/usr/bin/sw_vers", "-productVersion"], env=self.env),
            "make": captured(["/usr/bin/make", "--version"], env=self.env),
            "pythonVersion": sys.version.split()[0],
            "pinnedTools": {},
        }
        for name, path, args in (
            ("ninja", self.tools / "bin/ninja", ["--version"]),
            ("pkgconf", self.tools / "bin/pkgconf", ["--version"]),
        ):
            identities["pinnedTools"][name] = {
                "sha256": digest(path),
                "version": captured([str(path), *args], env=self.env),
            }
        identities["pinnedTools"]["meson"] = {
            "sourceSha256": digest(pathlib.Path(self.meson_script)),
            "version": captured([sys.executable, self.meson_script, "--version"], env=self.env),
        }
        return identities

    def native_binary(self, file: pathlib.Path) -> dict:
        require(file.is_file(), "Missing FFmpeg/ffprobe binary: " + str(file))
        arches = captured(["/usr/bin/lipo", "-archs", str(file)]).split()
        require(arches == ["arm64"], "Binary is not arm64-only: " + file.name)
        summary = captured(["/usr/bin/file", "-b", str(file)])
        require("Mach-O" in summary and "arm64" in summary and "executable" in summary,
                "Binary is not a native Mach-O executable: " + file.name)
        links_output = captured(["/usr/bin/otool", "-L", str(file)])
        libraries = []
        for line in links_output.splitlines()[1:]:
            link = line.strip().split(" (", 1)[0].strip()
            if not link:
                continue
            require(link.startswith("/usr/lib/") or link.startswith("/System/Library/Frameworks/"),
                    "Non-system dynamic library found in FFmpeg runtime: " + link)
            libraries.append(link)
        require(bool(libraries), "otool reported no native system linkage.")
        min_versions: list[str] = []
        load_commands = captured(["/usr/bin/otool", "-l", str(file)])
        for block in re.split(r"(?m)^\s*Load command \d+\s*$", load_commands):
            if re.search(r"(?m)^\s*cmd LC_BUILD_VERSION\s*$", block):
                match = re.search(r"(?m)^\s*minos (\d+\.\d+(?:\.\d+)?)\s*$", block)
                require(match is not None, "Missing LC_BUILD_VERSION minimum macOS version.")
                min_versions.append(match.group(1))
            if re.search(r"(?m)^\s*cmd LC_VERSION_MIN_MACOSX\s*$", block):
                match = re.search(r"(?m)^\s*version (\d+\.\d+(?:\.\d+)?)\s*$", block)
                require(match is not None, "Missing legacy LC_VERSION_MIN_MACOSX.")
                min_versions.append(match.group(1))
        require(bool(min_versions), "No deployment-floor load command for " + file.name)
        def tuple_version(value: str) -> tuple[int, ...]:
            parts = [int(bit) for bit in value.split(".")]
            return tuple((parts + [0, 0, 0])[:3])
        require(all(tuple_version(v) <= tuple_version(MIN_MACOS) for v in min_versions),
                "Runtime raises the supported macOS 12.3 floor: " + file.name)
        vtool = captured(["/usr/bin/xcrun", "vtool", "-show-build", str(file)], env=self.env)
        require("macos" in vtool.lower() and "12.3" in vtool,
                "vtool did not corroborate native macOS 12.3 deployment target.")
        return {"sha256": digest(file), "sizeBytes": file.stat().st_size, "file": summary,
                "architectures": arches, "minimumMacos": min_versions,
                "otoolLibraries": libraries, "otoolLoadCommands": load_commands,
                "vtoolBuild": vtool}

    def smoke(self) -> dict:
        ffmpeg = self.prefix / "bin/ffmpeg"
        ffprobe = self.prefix / "bin/ffprobe"
        require(ffmpeg.is_file() and ffprobe.is_file(), "Both FFmpeg and ffprobe are required.")
        buildconf = captured([str(ffmpeg), "-hide_banner", "-buildconf"], env=self.env)
        probe_version = captured([str(ffprobe), "-hide_banner", "-version"], env=self.env)
        ffmpeg_version = captured([str(ffmpeg), "-hide_banner", "-version"], env=self.env)
        license_text = captured([str(ffmpeg), "-hide_banner", "-L"], env=self.env)
        require("GNU General Public License" in license_text
                and re.search(r"\bversion 3\b", license_text, flags=re.I) is not None,
                "FFmpeg did not report the required GPL version 3 license.")
        require("ffmpeg version " + VERSION in ffmpeg_version
                and "ffprobe version " + VERSION in probe_version,
                "FFmpeg and ffprobe binaries must both report 8.1.3.")
        for option in (
            "--enable-gpl", "--enable-version3", "--enable-libass",
            "--enable-libharfbuzz", "--enable-libfribidi",
            "--enable-libfreetype", "--enable-libx264", "--enable-zlib",
        ):
            require(option in buildconf, "Required FFmpeg build feature is absent: " + option)
        for forbidden in self.lock["buildPolicy"]["forbiddenFfmpegConfigure"]:
            require(forbidden not in buildconf, "Forbidden FFmpeg configuration: " + forbidden)
        ass_help = captured([str(ffmpeg), "-hide_banner", "-h", "filter=ass"], env=self.env)
        require("shaping" in ass_help.lower() and "complex" in ass_help.lower(),
                "ASS filter lacks complex Khmer shaping selection.")
        filters = captured([str(ffmpeg), "-hide_banner", "-filters"], env=self.env)
        encoders = captured([str(ffmpeg), "-hide_banner", "-encoders"], env=self.env)
        decoders = captured([str(ffmpeg), "-hide_banner", "-decoders"], env=self.env)
        for filter_name in ("ass", "subtitles", "drawtext"):
            require(bool(re.search(r"(?m)^\s*[A-Z.]{3,5}\s+"
                                   + re.escape(filter_name) + r"\s", filters)),
                    "Required FFmpeg filter missing: " + filter_name)
        require(re.search(r"\blibx264\b", encoders) is not None, "libx264 encoder missing.")
        for codec in ("h264", "hevc", "aac", "png"):
            require(re.search(r"(?m)^\s*[A-Z.]{5,8}\s+" + codec + r"\s", decoders) is not None,
                    "Expected baseline FFmpeg decoder missing: " + codec)

        smoke_dir = self.work / "smoke"
        smoke_dir.mkdir()
        ass_file = smoke_dir / "khmer.ass"
        ass_file.write_text(
            "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            "Style: Default,Khmer Sangam MN,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,5,12,12,20,1\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,"
            "សួស្តី កម្ពុជា\n"
            "Dialogue: 0,0:00:00.30,0:00:01.00,Default,,0,0,0,,"
            "Khmer + English\n", encoding="utf-8")
        common = [str(ffmpeg), "-hide_banner", "-v", "verbose",
                  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=25:d=1", "-frames:v", "1"]
        plain = captured([*common, "-f", "framemd5", "-"], cwd=smoke_dir, env=self.env)
        overlaid = captured([*common, "-vf", "ass=khmer.ass", "-f", "framemd5", "-"],
                            cwd=smoke_dir, env=self.env)

        def framehash(output: str) -> str:
            matches = re.findall(r"(?m)^\s*\d+,\s*\d+,[^\n]*?,\s*([0-9a-f]{32})\s*$", output)
            require(len(matches) == 1, "Expected exactly one rendered video frame.")
            return matches[0]

        require(framehash(plain) != framehash(overlaid),
                "Native libass Khmer/English overlay produced unchanged pixels.")
        require(re.search(r"(?i)font provider.*core.?text", overlaid) is not None,
                "libass did not report the required CoreText font provider.")
        media = smoke_dir / "khmer-h264.mp4"
        self.run("smoke-libass-h264", [
            str(ffmpeg), "-hide_banner", "-y", "-v", "info",
            "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
            "-vf", "ass=khmer.ass", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
            "-t", "1", "-movflags", "+faststart", str(media),
        ], cwd=smoke_dir)
        track = json.loads(captured([str(ffprobe), "-v", "error",
                                     "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt",
                                     "-of", "json", str(media)], env=self.env))
        streams = track.get("streams", [])
        video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
        audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
        require(len(video_streams) == 1 and video_streams[0].get("codec_name") == "h264"
                and video_streams[0].get("width") == 640 and video_streams[0].get("height") == 360
                and len(audio_streams) == 1 and audio_streams[0].get("codec_name") == "aac",
                "Native ffprobe did not verify the H.264/AAC smoke video and audio.")
        return {
            "checkedFilters": ["ass", "subtitles", "drawtext"],
            "assShapingHelp": ass_help,
            "checkedEncoders": ["libx264"],
            "checkedDecoders": ["h264", "hevc", "aac", "png"],
            "fontProvider": "CoreText",
            "plainFrameMd5": framehash(plain),
            "khmerFrameMd5": framehash(overlaid),
            "smokeMp4Sha256": digest(media),
            "ffprobeStreams": streams,
            "ffmpegVersion": ffmpeg_version.splitlines()[0],
            "ffprobeVersion": probe_version.splitlines()[0],
            "ffmpegLicense": license_text,
            "configuration": buildconf,
        }

    def artifact_zip(self, filename: str, entries: dict[str, tuple[pathlib.Path | bytes, bool]]) -> pathlib.Path:
        out = self.artifacts / filename
        require(not out.exists(), "Refusing to overwrite an existing build artifact.")
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED,
                             compresslevel=9, allowZip64=True) as archive:
            for name, (content, executable) in sorted(entries.items()):
                within_path(pathlib.Path("zip-root"), name)
                info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
                info.create_system = 3
                info.external_attr = (0o100755 if executable else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                info._compresslevel = 9
                data = content if isinstance(content, bytes) else content.read_bytes()
                archive.writestr(info, data)
        return out

    def package(self, identity: dict, smoke: dict) -> None:
        base = "Sthang-Studio-FFmpeg-" + VERSION + "-macOS-arm64"
        ffmpeg = self.prefix / "bin/ffmpeg"
        ffprobe = self.prefix / "bin/ffprobe"
        binary_evidence = {"ffmpeg": self.native_binary(ffmpeg),
                           "ffprobe": self.native_binary(ffprobe)}
        toolchain = self.toolchain_receipt()
        log_checksums = {
            log.name: {"sha256": digest(log), "sizeBytes": log.stat().st_size}
            for log in sorted(self.logs.glob("*.log"))
        }
        runtime_entries: dict[str, tuple[pathlib.Path | bytes, bool]] = {
            "Tools/ffmpeg": (ffmpeg, True), "Tools/ffprobe": (ffprobe, True),
            "README-SOURCE-AND-LICENSES.txt": (
                ("STHANG STUDIO FFmpeg 8.1.3 arm64 native build candidate\n"
                 "The combined FFmpeg + x264 build uses GNU GPL version 3 or later.\n"
                 "All redistributed third-party license texts are preserved verbatim\n"
                 "under THIRD_PARTY_LICENSES/. FreeType is used under the FreeType\n"
                 "License alternative; see freetype/LICENSE.TXT and docs/FTL.TXT\n"
                 "for the full original license text and copyright notices.\n"
                 "This software is based in part on the work of the Independent JPEG Group.\n"
                 "This is not an Apple-signed or notarized application.\n"
                 "Required complete corresponding source asset:\n"
                 + base + "-corresponding-source.zip\n"
                 "Distribution requires separate independent legal and release approval.\n"
                 ).encode("utf-8"), False),
        }
        for name in sorted(("ffmpeg", "freetype", "fribidi", "harfbuzz", "libass", "x264")):
            for license_path in self.lock["sources"][name]["licensePaths"]:
                original = within_path(self.source_paths[name], license_path)
                runtime_entries["THIRD_PARTY_LICENSES/" + name + "/" + license_path] = (
                    original, False,
                )
        tools = self.artifact_zip(base + "-tools.zip", runtime_entries)
        source_entries: dict[str, tuple[pathlib.Path | bytes, bool]] = {
            "scripts/ci/build-macos-ffmpeg.py": (pathlib.Path(__file__), False),
            "config/macos-ffmpeg-build-lock.json": (LOCK, False),
            ".github/workflows/macos-ffmpeg-runtime.yml": (WORKFLOW, False),
            "BUILD-INSTRUCTIONS.txt": (
                ("Sources: nine exact SHA-256 verified source archives in sources/.\n"
                 "Build: on native Apple Silicon, Xcode clang/SDK and system make;\n"
                 "run python3 -B scripts/ci/build-macos-ffmpeg.py after selecting\n"
                 "a reviewed Python 3.12 and verifying the committed lock.\n"
                 "No package manager, floating checkout or signing key is used.\n"
                 "The source distribution accompanies a GPL version 3 FFmpeg build.\n"
                 "No source patches were applied; the exact raw archives are included.\n"
                 "See each listed license, BUILD-PROVENANCE.json and the build receipt.\n").encode("utf-8"), False),
            "SOURCE-PATCHES.txt": (b"No patches. All nine source archives were used unchanged.\n", False),
        }
        sources_receipt = []
        for name, source in sorted(self.lock["sources"].items()):
            archive = self.downloads[name]
            source_entries["sources/" + name + "/" + source["archive"]] = (archive, False)
            licenses = []
            for license_path in source["licensePaths"]:
                file = within_path(self.source_paths[name], license_path)
                source_entries["licenses/" + name + "/" + license_path] = (file, False)
                licenses.append({"path": license_path, "sha256": digest(file)})
            sources_receipt.append({
                "name": name, "version": source["version"], "url": source["url"],
                "archive": source["archive"], "sha256": digest(archive),
                "sizeBytes": archive.stat().st_size, "licenses": licenses,
            })
        for log in sorted(self.logs.glob("*.log")):
            source_entries["logs/" + log.name] = (log, False)
        source_entries["BUILD-PROVENANCE.json"] = (json_text({
            "schemaVersion": 1, "sourceLockSha256": self.lock["lockSha256"],
            "sourceInputs": sources_receipt,
            "toolchain": toolchain, "buildHost": identity,
            "configureAndCompileCommands": self.commands,
            "logChecksums": log_checksums, "binaryEvidence": binary_evidence,
            "smoke": smoke, "sourcePatches": [],
            "licenseReviewStatus": "independent-review-required-before-distribution",
        }).encode("utf-8"), False)
        sources_zip = self.artifact_zip(base + "-corresponding-source.zip", source_entries)
        for item in (tools, sources_zip):
            (self.artifacts / (item.name + ".sha256")).write_text(
                digest(item) + "  " + item.name + "\n", encoding="ascii")
        receipt = {
            "schemaVersion": 1, "purpose": "native-macos-ffmpeg-source-provenance",
            "releaseVersion": VERSION, "target": self.lock["target"],
            "sourceLockSha256": self.lock["lockSha256"],
            "sourceInputs": sources_receipt,
            "buildHost": identity, "toolchain": toolchain,
            "environment": {k: self.env[k] for k in (
                "MACOSX_DEPLOYMENT_TARGET", "SDKROOT", "CC", "CXX",
                "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS",
                "PKG_CONFIG_LIBDIR", "PKG_CONFIG_PATH", "SOURCE_DATE_EPOCH",
                "LC_ALL", "TZ", "DEVELOPER_DIR",
            )},
            "commands": self.commands, "logChecksums": log_checksums,
            "sourcePatches": [],
            "binaryEvidence": binary_evidence, "smoke": smoke,
            "artifacts": [
                {"name": item.name, "sha256": digest(item), "sizeBytes": item.stat().st_size}
                for item in (tools, sources_zip)
            ],
            "sourceRevision": os.environ.get("GITHUB_SHA", ""),
            "releaseStatus": "local-actions-artifacts-only-no-signing-or-publication",
            "reproducibility": "fixed archive layout; independently rebuild and compare actual hashes on each runner image",
        }
        receipt_path = self.artifacts / (base + ".build-receipt.json")
        receipt_path.write_text(json_text(receipt), encoding="utf-8")
        (self.artifacts / (receipt_path.name + ".sha256")).write_text(
            digest(receipt_path) + "  " + receipt_path.name + "\n", encoding="ascii")
        # Include complete build logs for future source/flag review. These are
        # separate Actions-only evidence, never user-install payload content.
        logs_zip = self.artifact_zip(base + "-build-logs.zip", {
            "logs/" + log.name: (log, False) for log in sorted(self.logs.glob("*.log"))
        })
        (self.artifacts / (logs_zip.name + ".sha256")).write_text(
            digest(logs_zip) + "  " + logs_zip.name + "\n", encoding="ascii")
        print("Mac FFmpeg provenance artifacts verified under " + str(self.artifacts), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-only", action="store_true",
                        help="Verify the source lock schema and pins without network or compilation.")
    args = parser.parse_args()
    lock = check_lock(LOCK)
    print("LOCK: nine SHA-256 pinned archives, FFmpeg 8.1.3, Apple arm64 / macOS 12.3", flush=True)
    if args.validate_only:
        return
    identity = native_identity()
    require(WORKFLOW.is_file(), "Pinned workflow source missing.")
    base = pathlib.Path(os.environ.get("STUDIO_FFMPEG_WORK_DIR", ""))
    require(base.is_absolute() and str(base) not in ("/", "/tmp"),
            "Provide STUDIO_FFMPEG_WORK_DIR as a dedicated absolute build directory.")
    builder = Builder(lock, base)
    builder.prepare()
    for name in sorted(EXPECTED_SOURCES):
        builder.download(name)
        builder.extract(name)
    builder.bootstrap_tools()
    builder.build_dependencies()
    builder.build_ffmpeg()
    smoke = builder.smoke()
    builder.package(identity, smoke)


if __name__ == "__main__":
    try:
        main()
    except (BuildFailure, OSError, ValueError, KeyError, subprocess.SubprocessError,
            tarfile.TarError, zipfile.BadZipFile) as error:
        print("MACOS FFMPEG PROVENANCE BUILD FAILED: " + str(error), file=sys.stderr)
        raise SystemExit(1) from None
