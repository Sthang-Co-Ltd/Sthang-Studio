from __future__ import annotations

import pathlib
import sys
import zipfile


UNIX_SCRIPT_SUFFIXES = {".sh", ".command"}
CANONICAL_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
FORBIDDEN_PARTS = {
    "data",
    "uploads",
    "exports",
    "tools",
    "node_modules",
    ".venv",
    ".timing-envs",
    ".timing-setup.lock",
    ".timing-transaction.json",
    ".timing-transaction.json.tmp",
    "versions",
    "updates",
    "release-artifacts",
}


def zip_info(path: pathlib.Path, arcname: str, executable: bool) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(arcname, CANONICAL_ZIP_TIME)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o100755 if executable else 0o100644) << 16
    return info


def normalized_bytes(path: pathlib.Path) -> bytes:
    data = path.read_bytes()
    if path.suffix in UNIX_SCRIPT_SUFFIXES:
        data = data.replace(b"\r\n", b"\n")
        if b"\r" in data:
            raise ValueError(f"macOS OTA shell entrypoint contains an unsupported carriage-return byte: {path}")
    return data


def allowed(relative: pathlib.PurePosixPath) -> bool:
    lowered = {part.casefold() for part in relative.parts}
    if any(part.startswith((".venv.rollback-", ".venv.pending-")) for part in lowered) or lowered & FORBIDDEN_PARTS:
        return False
    if any(part.casefold() == ".env" for part in relative.parts):
        return False
    return relative.as_posix() != ".sthang-update-version.json"


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: create-macos-ota-zip.py <payload-root> <output.zip>", file=sys.stderr)
        return 2
    root = pathlib.Path(sys.argv[1]).resolve()
    output = pathlib.Path(sys.argv[2]).resolve()
    if not root.is_dir():
        print(f"payload root does not exist: {root}", file=sys.stderr)
        return 2
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    try:
        with zipfile.ZipFile(output, "w", allowZip64=False) as archive:
            for path in sorted(root.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"macOS OTA payload contains a symlink: {path.relative_to(root).as_posix()}")
                if not path.is_file():
                    continue
                relative = pathlib.PurePosixPath(path.relative_to(root).as_posix())
                if not allowed(relative):
                    raise ValueError(f"macOS OTA payload contains protected runtime state: {relative}")
                data = normalized_bytes(path)
                executable = path.suffix in UNIX_SCRIPT_SUFFIXES
                archive.writestr(zip_info(path, relative.as_posix(), executable), data)
    except Exception as error:
        if output.exists():
            output.unlink()
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
