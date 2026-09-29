from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import zipfile


MAX_ENTRIES = 20_000
HEX_40 = set("0123456789abcdef")
HEX_64 = set("0123456789abcdef")
DERIVED_ROOTS = (
    "apps/server/dist/",
    "apps/web/dist/",
    "packages/shared/dist/",
)
PROTECTED_PARTS = {
    "data",
    "uploads",
    "exports",
    "tools",
    "node_modules",
    ".venv",
    "versions",
    "updates",
    "release-artifacts",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def json_file(path: pathlib.Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        raise RuntimeError(f"{label} is invalid or missing.") from exc
    if not isinstance(value, dict):
        fail(f"{label} is invalid.")
    return value


def sha256_path(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def exact_hash(value: object, label: str, length: int = 64) -> str:
    raw = str(value or "").strip().lower()
    allowed = HEX_64 if length == 64 else HEX_40
    if len(raw) != length or any(char not in allowed for char in raw):
        fail(f"{label} is invalid.")
    return raw


def under(parent: pathlib.Path, child: pathlib.Path) -> bool:
    try:
        child.relative_to(parent)
        return child != parent
    except ValueError:
        return False


def fsync_directory(directory: pathlib.Path) -> None:
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def atomic_json(path: pathlib.Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temp.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fsync_directory(path.parent)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def normalized_archive_path(raw: str) -> str:
    if not raw or len(raw) > 512 or "\x00" in raw or "\\" in raw or raw.startswith("/"):
        fail("The update archive contains an unsafe path.")
    parts = raw.rstrip("/").split("/")
    if not parts or any(not part or part in {".", ".."} for part in parts):
        fail("The update archive contains an unsafe path.")
    if any(":" in part or part[-1:] in {" ", "."} for part in parts):
        fail("The update archive contains an unsafe path.")
    lowered = [part.casefold() for part in parts]
    if any(part in PROTECTED_PARTS for part in lowered):
        fail("The update archive contains protected runtime state.")
    if any(part == ".env" for part in lowered):
        fail("The update archive contains protected local settings.")
    path = "/".join(parts)
    if path == ".sthang-update-version.json":
        fail("The update archive contains protected activation state.")
    return path


def safe_extract_opened(
    archive_stream,
    destination: pathlib.Path,
    signed_unpacked_size: int,
) -> set[str]:
    archive_stream.seek(0)
    with zipfile.ZipFile(archive_stream) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_ENTRIES:
            fail("The update archive entry count is invalid.")
        seen: set[str] = set()
        total = 0
        files: set[str] = set()
        for info in infos:
            normalized = normalized_archive_path(info.filename)
            conflict_key = unicodedata.normalize("NFC", normalized).casefold()
            if conflict_key in seen:
                fail("The update archive contains duplicate or case-conflicting paths.")
            seen.add(conflict_key)
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type and file_type not in {stat.S_IFREG, stat.S_IFDIR}:
                fail("The update archive contains a symbolic link or special file.")
            if info.is_dir():
                continue
            total += info.file_size
            if total > signed_unpacked_size:
                fail("The update archive expands beyond its signed size limit.")
            files.add(normalized)
        if total != signed_unpacked_size:
            fail("The update archive expanded size does not match its signed manifest.")

        for info in infos:
            normalized = normalized_archive_path(info.filename)
            target = destination.joinpath(*normalized.split("/"))
            if not under(destination, target):
                fail("The update archive target is invalid.")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = 0o755 if target.suffix in {".sh", ".command"} else 0o644
            with archive.open(info, "r") as source:
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
                try:
                    with os.fdopen(descriptor, "wb", closefd=False) as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
                        output.flush()
                        os.fsync(output.fileno())
                finally:
                    os.close(descriptor)
            os.chmod(target, mode)
            if target.stat().st_size != info.file_size:
                fail("An update archive entry was not extracted completely.")
    return files


def derived_files(root: pathlib.Path) -> set[str]:
    result: set[str] = set()
    for relative_root in DERIVED_ROOTS:
        folder = root.joinpath(*relative_root.rstrip("/").split("/"))
        if not folder.is_dir():
            fail(f"The prepared update is missing {relative_root}.")
        for path in folder.rglob("*"):
            if path.is_symlink():
                fail("The prepared derived runtime contains a symlink.")
            if path.is_file():
                result.add(path.relative_to(root).as_posix())
    return result


def verify_derived(root: pathlib.Path, signed: dict) -> str:
    manifest_path = root / ".sthang" / "macos-derived-runtime.json"
    evidence_path = root / ".sthang" / "macos-release-build.json"
    expected_evidence_hash = exact_hash(
        signed.get("source", {}).get("buildEvidenceSha256"),
        "The signed source-owned build evidence hash",
    )
    if sha256_path(evidence_path) != expected_evidence_hash:
        fail("The source-owned release build evidence failed signed verification.")
    expected_manifest_hash = exact_hash(
        signed.get("source", {}).get("derivedRuntimeManifestSha256"),
        "The signed derived-runtime manifest hash",
    )
    if sha256_path(manifest_path) != expected_manifest_hash:
        fail("The derived-runtime manifest failed signed verification.")
    manifest = json_file(manifest_path, "The macOS derived-runtime manifest")
    if manifest.get("schemaVersion") != 2:
        fail("The macOS derived-runtime manifest schema is invalid.")
    if exact_hash(manifest.get("sourceCommit"), "The derived source commit", 40) != exact_hash(
        signed.get("source", {}).get("commit"), "The signed source commit", 40
    ):
        fail("The derived-runtime source commit does not match the signed release.")
    if exact_hash(manifest.get("sourceTree"), "The derived source tree", 40) != exact_hash(
        signed.get("source", {}).get("tree"), "The signed source tree", 40
    ):
        fail("The derived-runtime source tree does not match the signed release.")
    if exact_hash(manifest.get("buildEvidenceSha256"), "The derived build evidence hash") != expected_evidence_hash:
        fail("The derived runtime does not match the signed source-owned build evidence.")
    lock_hash = exact_hash(signed.get("setup", {}).get("packageLockSha256"), "The signed package-lock hash")
    if exact_hash(manifest.get("packageLockSha256"), "The derived package-lock hash") != lock_hash:
        fail("The derived-runtime package lock does not match the signed release.")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        fail("The derived-runtime manifest contains no files.")
    expected_paths: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            fail("The derived-runtime manifest contains an invalid file record.")
        relative = str(record.get("path") or "")
        if not relative.startswith(DERIVED_ROOTS) or relative in expected_paths:
            fail("The derived-runtime manifest contains an invalid file path.")
        expected_paths.add(relative)
        file = root.joinpath(*relative.split("/"))
        if not file.is_file() or file.is_symlink():
            fail(f"The prepared update is missing derived file {relative}.")
        if file.stat().st_size != int(record.get("size", -1)):
            fail(f"The prepared derived file has an unexpected size: {relative}.")
        if sha256_path(file) != exact_hash(record.get("sha256"), "A derived file hash"):
            fail(f"The prepared derived file failed verification: {relative}.")
    if derived_files(root) != expected_paths:
        fail("The prepared update contains unmanifested or missing derived files.")
    evidence = json_file(evidence_path, "The source-owned macOS release build evidence")
    if evidence.get("schemaVersion") != 1 or exact_hash(evidence.get("packageLockSha256"), "The source-owned package-lock hash") != lock_hash:
        fail("The source-owned release build evidence identity is invalid.")
    if evidence.get("files") != records:
        fail("The derived runtime differs from the source-owned release build evidence.")
    return expected_manifest_hash


def verify_prepared_target(
    target: pathlib.Path,
    version: str,
    manifest_digest: str,
    package_sha: str,
    package_lock_sha: str,
    derived_manifest_sha: str,
) -> None:
    marker = json_file(target / ".sthang-update-version.json", "The prepared version marker")
    expected = {
        "schemaVersion": 1,
        "platform": "macos-arm64",
        "version": version,
        "manifestDigest": manifest_digest,
        "packageSha256": package_sha,
        "packageLockSha256": package_lock_sha,
        "derivedRuntimeManifestSha256": derived_manifest_sha,
    }
    for key, value in expected.items():
        if marker.get(key) != value:
            fail("The existing immutable version directory does not match this release.")
    for relative in (
        "run-macos.sh",
        "scripts/dev.mjs",
        "apps/server/dist/index.js",
        "apps/web/dist/index.html",
        "packages/shared/dist/index.js",
        "node_modules",
        ".venv/bin/python",
    ):
        if not target.joinpath(*relative.split("/")).exists():
            fail(f"The existing immutable version is incomplete: {relative}.")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: prepare-studio-update-macos.py <pending-install.json>", file=sys.stderr)
        return 2
    pending_path = pathlib.Path(sys.argv[1]).resolve()
    pending = json_file(pending_path, "The pending Studio update")
    if pending.get("schemaVersion") != 1 or pending.get("platform") != "macos-arm64" or not pending.get("verifiedAt"):
        fail("The pending macOS update was not verified by the stable Studio broker.")

    update_root = pending_path.parent
    state_root = update_root.parent.resolve()
    if pending_path.name != "pending-install.json" or update_root.name != "updates":
        fail("The pending macOS update location is invalid.")
    if pathlib.Path(str(pending.get("installRoot") or "")).resolve() != state_root:
        fail("The pending macOS update install root is invalid.")
    if pathlib.Path(str(pending.get("updateRoot") or "")).resolve() != update_root:
        fail("The pending macOS update state root is invalid.")
    versions_root = pathlib.Path(str(pending.get("versionsRoot") or "")).resolve()
    if versions_root != state_root / "versions":
        fail("The pending macOS version root is invalid.")

    version = str(pending.get("targetVersion") or "")
    target_relative = str(pending.get("targetRelativePath") or "").replace("\\", "/")
    if target_relative != f"versions/{version}":
        fail("The pending macOS update target is invalid.")
    target = (state_root / "versions" / version).resolve()
    if target.parent != versions_root:
        fail("The pending macOS update target escaped the immutable version root.")

    manifest_path = pathlib.Path(str(pending.get("manifestPath") or "")).resolve()
    package_path = pathlib.Path(str(pending.get("packagePath") or "")).resolve()
    stage_root = update_root / "staging" / version
    if manifest_path.parent != stage_root or package_path.parent != stage_root:
        fail("The staged macOS update paths are invalid.")
    manifest_digest = exact_hash(pending.get("manifestDigest"), "The pending manifest digest")
    manifest_bytes = manifest_path.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != manifest_digest:
        fail("The staged macOS manifest failed its final byte check.")
    manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
    if (
        manifest.get("schemaVersion") != 2
        or manifest.get("product") != "sthang-studio"
        or manifest.get("platform") != "macos-arm64"
        or manifest.get("channel") != "preview"
        or manifest.get("version") != version
    ):
        fail("The staged signed macOS manifest identity is invalid.")
    compatibility = manifest.get("compatibility", {})
    if compatibility.get("minMacos") != "12.3" or compatibility.get("arch") != "arm64":
        fail("The staged macOS compatibility contract is invalid.")
    setup = manifest.get("setup", {})
    if setup.get("strategy") != "macos-curated-runtime":
        fail("The staged macOS setup strategy is invalid.")

    package = manifest.get("package", {})
    package_sha = exact_hash(package.get("sha256"), "The staged package hash")
    signed_size = int(package.get("sizeBytes") or 0)
    signed_unpacked = int(package.get("unpackedSizeBytes") or 0)
    if signed_size <= 0 or signed_unpacked <= 0 or package_path.stat().st_size != signed_size:
        fail("The staged macOS package size failed verification.")

    work_root = update_root / "work" / f"{version}-{os.getpid()}-{time.time_ns()}"
    extract_root = work_root / "source"
    extract_root.mkdir(parents=True, exist_ok=False)
    try:
        with package_path.open("rb") as package_stream:
            digest = hashlib.sha256()
            while True:
                chunk = package_stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if digest.hexdigest() != package_sha:
                fail("The staged macOS package failed its final byte check.")
            safe_extract_opened(package_stream, extract_root, signed_unpacked)

        package_json = json_file(extract_root / "package.json", "The prepared package.json")
        if package_json.get("version") != version:
            fail("The prepared package version does not match the signed release.")
        lock_sha = exact_hash(setup.get("packageLockSha256"), "The signed package-lock hash")
        if sha256_path(extract_root / "package-lock.json") != lock_sha:
            fail("The prepared package lock failed signed verification.")
        python_files = setup.get("pythonFiles")
        if not isinstance(python_files, list) or not python_files:
            fail("The signed Python dependency declaration is invalid.")
        for record in python_files:
            if not isinstance(record, dict):
                fail("A signed Python dependency declaration is invalid.")
            relative = str(record.get("path") or "").replace("\\", "/")
            if not relative.startswith("local-timing/requirements") or not relative.endswith(".txt"):
                fail("A signed Python dependency path is invalid.")
            if sha256_path(extract_root.joinpath(*relative.split("/"))) != exact_hash(record.get("sha256"), "A signed Python dependency hash"):
                fail("A Python dependency file failed signed verification.")
        marker = extract_root / ".sthang" / "macos-curated-runtime"
        if marker.read_text(encoding="ascii").strip() != "production-runtime-v1":
            fail("The prepared update is not a curated macOS production runtime.")
        derived_sha = verify_derived(extract_root, manifest)

        env = os.environ.copy()
        env["STHANG_STUDIO_STATE_ROOT"] = str(state_root)
        env["KCS_NONINTERACTIVE"] = "1"
        env["KCS_OPEN_BROWSER"] = "false"
        result = subprocess.run(
            ["/bin/bash", str(extract_root / "INSTALL-MACOS.sh")],
            cwd=extract_root,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            fail("The staged macOS application dependency setup failed.")

        atomic_json(
            extract_root / ".sthang-update-version.json",
            {
                "schemaVersion": 1,
                "platform": "macos-arm64",
                "version": version,
                "manifestDigest": manifest_digest,
                "packageSha256": package_sha,
                "packageLockSha256": lock_sha,
                "derivedRuntimeManifestSha256": derived_sha,
                "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )
        verify_prepared_target(extract_root, version, manifest_digest, package_sha, lock_sha, derived_sha)
        versions_root.mkdir(parents=True, exist_ok=True)
        if target.exists():
            verify_prepared_target(target, version, manifest_digest, package_sha, lock_sha, derived_sha)
        else:
            os.replace(extract_root, target)
            fsync_directory(target.parent)
            verify_prepared_target(target, version, manifest_digest, package_sha, lock_sha, derived_sha)
        atomic_json(
            update_root / "receipts" / f"{version}.json",
            {
                "schemaVersion": 1,
                "platform": "macos-arm64",
                "version": version,
                "manifestDigest": manifest_digest,
                "packageSha256": package_sha,
                "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
