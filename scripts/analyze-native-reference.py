"""Offline inspection of retained synthetic native references; never runs FFmpeg.

Requires Pillow. The report distinguishes PNG alpha occupancy from the renderer's
stderr-derived bounds without changing any fixture, assertion, or source file.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

from PIL import Image


def inspect_batch(manifest):
    directory = manifest.parent
    snapshot = json.loads(manifest.read_text(encoding="utf-8"))
    artifacts = json.loads((directory / "artifacts.json").read_text(encoding="utf-8"))
    capture = json.loads((directory / "capture-status.json").read_text(encoding="utf-8"))
    stderr = (directory / "ffmpeg-stderr.txt").read_text(encoding="utf-8") if (directory / "ffmpeg-stderr.txt").exists() else ""
    bboxes = []
    # Independent field parsing intentionally does not reuse the product regex.
    for line in stderr.splitlines():
        kind = re.search(r"\[bbox@(caption|focus)\b", line)
        if not kind:
            continue
        fields = dict(re.findall(r"\b([A-Za-z][A-Za-z0-9_]*):\s*(-?\d+(?:\.\d+)?)", line))
        bboxes.append({"kind": kind[1], **fields})
    frames = []
    times = snapshot["input"]["timesMs"]
    associations = snapshot.get("frames", [])
    for png in sorted(directory.glob("*.png")):
        index = int(png.stem) - 1
        with Image.open(png) as image:
            alpha = image.convert("RGBA").getchannel("A")
            histogram = alpha.histogram()
            occupancy = alpha.getbbox()
            above_one = alpha.point(lambda value: 255 if value > 1 else 0).getbbox()
            size = image.size
        associated = associations[index] if index < len(associations) else None
        bounds = associated.get("bounds") if associated else None
        if occupancy and bounds:
            classification = "pixels-and-bounds-present"
        elif occupancy:
            classification = "pixels-present-bounds-missing"
        elif bounds:
            classification = "bbox-present-pixels-absent"
        else:
            classification = "pixels-absent"
        checksum = hashlib.sha256(png.read_bytes()).hexdigest()
        expected_hash = artifacts.get("artifacts", {}).get(png.name, {}).get("sha256")
        frames.append({
            "file": png.name, "index": index,
            "atMs": times[index] if index < len(times) else None,
            "width": size[0], "height": size[1], "sha256": checksum,
            "artifactHashMatches": checksum == expected_hash,
            "alphaNonzeroPixels": sum(histogram[1:]), "alphaAboveOnePixels": sum(histogram[2:]),
            "alphaBoundsExclusive": occupancy, "alphaAboveOneBoundsExclusive": above_one,
            "associatedFrame": associated, "classification": classification,
            "stderrBboxesAtIndex": [bbox for bbox in bboxes if bbox.get("n") == str(index)],
        })
    return {
        "capture": capture, "renderCompleted": snapshot["completed"],
        "requestedTimesMs": times, "pngCount": len(frames), "expectedPngCount": len(times),
        "processExitCode": snapshot.get("process", {}).get("exitCode"),
        "productParsedBboxes": snapshot.get("parsedBboxes"), "independentStderrBboxes": bboxes,
        "frames": frames,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    batches = []
    for manifest in sorted(root.rglob("render.json")):
        try:
            batches.append({"batch": manifest.parent.relative_to(root).as_posix(), **inspect_batch(manifest)})
        except Exception as error:
            # Do not print potentially sensitive exception contents or raw paths.
            batches.append({"batch": manifest.parent.relative_to(root).as_posix(), "inspectionError": type(error).__name__})
    result = {"schemaVersion": 1, "method": "Pillow RGBA alpha occupancy, independent stderr field parsing", "batches": batches}
    text = json.dumps(result, indent=2)
    if args.output:
        # Exclusive creation preserves original evidence and earlier analyses.
        with args.output.open("x", encoding="utf-8") as output:
            output.write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    main()
