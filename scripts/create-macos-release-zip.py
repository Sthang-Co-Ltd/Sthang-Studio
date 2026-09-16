from __future__ import annotations

import os
import pathlib
import sys
import time
import zipfile


def zip_info(path: pathlib.Path, arcname: str, executable: bool) -> zipfile.ZipInfo:
    stat = path.stat()
    info = zipfile.ZipInfo(arcname, tuple(list(time.localtime(stat.st_mtime))[:6]))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = 0o100755 if executable else 0o100644
    info.external_attr = mode << 16
    return info


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: create-macos-release-zip.py <package-folder> <output.zip>", file=sys.stderr)
        return 2

    package_root = pathlib.Path(sys.argv[1]).resolve()
    output = pathlib.Path(sys.argv[2]).resolve()
    if not package_root.is_dir():
        print(f"package folder does not exist: {package_root}", file=sys.stderr)
        return 2

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    base = package_root.name
    with zipfile.ZipFile(output, "w", allowZip64=True) as archive:
        for path in sorted(package_root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(package_root).as_posix()
            arcname = f"{base}/{relative}"
            executable = path.suffix in {".sh", ".command"}
            info = zip_info(path, arcname, executable)
            with path.open("rb") as source, archive.open(info, "w") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    target.write(chunk)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
