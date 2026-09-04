# Captioned video export

> **Status:** implemented on the feature branch/source line; not public-release evidence.
>
> The current public Studio release remains whatever exact version is verified by
> `.sthang/product-manifest.json` and the corresponding GitHub Release evidence.
> Do not advertise captioned-video export as publicly available until the release
> validation and synchronization gates below are complete.

## Purpose

Sthang Studio supports two deliberately different outputs:

1. **SRT** — portable caption text + timing for continued editing elsewhere.
2. **Captioned video** — a new local MP4 with the saved project caption appearance
   rendered into the picture.

The finished-video path exists so a creator can keep the look they reviewed in
Studio without relying on an editing application to recreate font, size, color,
outline, background, or position. It is not intended to turn Studio into a
multi-track general-purpose video editor.

## Appearance workflow

Caption appearance is edited **before export** as project state. A video project
with captions exposes a focused **Appearance** workspace alongside Review, Fine
timing, Accuracy, Caption grouping, and Details.

The Appearance workspace keeps the real video visible and temporarily applies the
current styling to Studio's editor caption overlay. This makes font, size, color,
position, outline, shadow, width, alignment and background decisions visible
against the creator's actual footage instead of a generic sample panel.

This browser treatment remains intentionally approximate. It is editor chrome,
not a rendered frame, and it is removed when the creator leaves Appearance. The
final MP4 is still rendered by FFmpeg/libass and is authoritative.

The common appearance path is intentionally small: preset, Khmer font, text color,
size and position. Specialist controls stay under **More appearance**, while
preset creation/deletion stays under **Manage presets**. Project appearance saves
automatically and the final workspace value is flushed when leaving so moving
straight to Export does not silently lose the latest adjustment.

Export does not duplicate these styling controls. It re-reads the saved project
appearance, shows a compact summary plus **Edit appearance**, and includes that
appearance in the immutable render snapshot. If a saved font is unavailable to
the local renderer, Studio blocks the finished-video action and sends the creator
back to Appearance rather than silently substituting typography.

Appearance remains independent of caption text/timing, locks, correction memory,
Review behavior, SRT serialization and source media.

## Quality contract

The renderer supports these output targets for SDR sources:

- Original / match source;
- HD 720p;
- Full HD 1080p;
- QHD 1440p;
- 4K UHD 2160p.

Preset dimensions fit the source inside the selected resolution envelope while
preserving aspect ratio and orientation. Studio never implicitly crops. If the
selected target is larger than the source, the UI labels the output **Upscaled**;
upscaling does not claim to recover source detail.

Frame rate defaults to source timestamps. Fixed 24, 25, 30, 50, or 60 fps is an
explicit CFR conversion. The source-matched path keeps VFR output when the input
is variable-frame-rate.

H.264 is the compatibility default. HEVC is shown only when the local runtime can
actually initialize an HEVC encoder. Hardware choices are likewise exposed only
after a real one-frame encode probe; detecting a GPU name is not sufficient.
Software encoding uses constant-quality presets unless an advanced bitrate is
supplied. Hardware encoders use quality-aware target bitrate bounds.

Audio tracks are mapped from the source. AAC is stream-copied when all mapped
audio is already MP4-compatible AAC; otherwise Studio transcodes the mapped audio
to AAC rather than silently dropping it. Output verification fails if a source
with audio produces no output audio stream.

## Color and HDR

The current renderer is intentionally an **SDR release path**.

Studio probes pixel format, bit depth, color primaries, transfer, matrix/range,
rotation, sample aspect ratio, codecs, frame rate and audio streams before render.
Known HDR10/PQ, HLG, Dolby Vision, and unknown HDR/BT.2020 transfer combinations
are blocked. Studio does not silently tone-map or strip HDR and then report a
normal successful export.

A future HDR release requires real color-managed validation for:

- 10-bit processing and subtitle composition;
- HDR10/PQ metadata preservation;
- HLG preservation;
- explicit HDR-to-SDR conversion when deliberately selected;
- Dolby Vision handling that does not imply unsupported metadata preservation.

## Khmer caption rendering

Final MP4 caption rendering uses ASS/libass through the local FFmpeg `subtitles`
filter. This allows deterministic fill, outline, shadow/background, alignment,
position and margin behavior.

The renderer:

- escapes ASS control characters from caption text;
- preserves explicit line breaks;
- adds render-only wrapping for long Khmer without spaces using Khmer grapheme
  segmentation rather than English word-spacing assumptions;
- scales caption size, outline, shadow and background padding with output frame
  height;
- constrains captions to a project-selected maximum frame width;
- uses reviewed Khmer-capable fonts available on the system.

Windows **Khmer UI** is the default supported system font. Noto Sans Khmer may be
used when the user has it installed. Studio does not redistribute a new font in
this implementation.

The Appearance workspace's live browser overlay is intentionally labeled as an
approximate preview. The final MP4 is rendered by FFmpeg/libass; release validation
must inspect actual rendered frames rather than treating CSS preview parity as
proof.

## Non-destructive job model

Starting a video export saves an immutable snapshot of:

- caption text and timing;
- saved project caption appearance;
- video export settings;
- source media filename + size identity.

The creator can continue editing captions or appearance while the saved snapshot
renders. Those later edits do not mutate the running export.

Video exports run on a separate serialized export lane from caption-generation
jobs. A long 4K render therefore does not block transcription/regeneration, while
only one video render runs at a time to avoid uncontrolled local CPU/GPU and disk
pressure.

Media replacement/deletion is blocked while any project job still uses the
source. An interrupted export can restart from its saved snapshot; a completed
export discards its large caption snapshot from job persistence.

## Render transaction

A render performs these steps:

1. re-probe the current local capability/source state;
2. check estimated output size against free disk space with safety reserve;
3. write a temporary ASS document inside `exports/.working/`;
4. render to a `.partial.mp4` file;
5. report machine-readable FFmpeg progress;
6. honor cancellation by terminating the local encoder and removing partial work;
7. verify dimensions, duration, video codec and required audio with `ffprobe`;
8. decode-check frames near the beginning, middle and end;
9. atomically rename the verified partial file into the export directory.

The source file is never overwritten. The public `/exports` local route exposes
only completed files; working files remain under a dot directory and are denied by
the static route.

## Installation/runtime contract

Captioned video needs more than the presence of `ffmpeg.exe`:

- FFmpeg `subtitles`/libass filter;
- a reviewed Khmer font;
- a usable H.264 encoder;
- optional HEVC/hardware encoders if advanced options are to be shown.

The UI probes these capabilities and fails closed with a recovery message. The
current installer may use a system/WinGet FFmpeg or its reviewed direct fallback;
therefore release validation must test the exact ordinary-user Windows package,
not merely a developer machine where a different FFmpeg build happens to work.

The default local upload allowance is 8 GB (operator override supported) so
ordinary 4K phone media is not rejected by the previous 500 MB default before the
renderer can inspect it.

## Release validation matrix

Do not call the feature release-ready until real Windows media tests cover at
least:

- 720p, 1080p, 1440p and 4K sources/outputs;
- landscape, portrait, square and unusual aspect ratios;
- 24/25/30/50/60 fps and representative phone VFR;
- rotation metadata and non-square sample-aspect inputs;
- H.264 and HEVC SDR, including an available 10-bit SDR case;
- Intel, NVIDIA, AMD and software-only encoder environments where practical;
- AAC source-copy and non-AAC audio-transcode paths;
- multiple audio streams;
- Khmer-only, Khmer-English, punctuation, manual line breaks, long no-space Khmer,
  outline/background/position combinations, and all offered fonts;
- Appearance workspace live-preview behavior at normal Windows scaling levels,
  including autosave, presets, unavailable-font recovery, and moving directly
  from Appearance to Export;
- cancellation, interruption/resume, low disk space and encoder failure;
- A/V duration/sync across the full rendered output;
- output upload/playback in representative publishing/editor applications.

Known HDR sources should demonstrate the explicit block, not a rendered result,
until the HDR work above is separately completed.

## Public-impact and release gates

This feature materially changes Studio's public output capability, so public
impact is **required** when released.

Before public publication:

1. complete the real-media Windows matrix above;
2. review the exact FFmpeg build/license/codec implications for the ordinary-user
   package;
3. create a new product change ID rather than mutating the governed v0.8.0 change;
4. update product-owned README/changelog/release evidence without claiming a
   release before it exists;
5. publish a deliberate release under the normal release approval gates;
6. run approved Sthang HQ intake for the new Studio public claims;
7. run approved Distribution synchronization for `/studio/` website/docs.

Merging source alone is not release proof and does not authorize HQ, Distribution,
OTA promotion, deployment, or release publication.
