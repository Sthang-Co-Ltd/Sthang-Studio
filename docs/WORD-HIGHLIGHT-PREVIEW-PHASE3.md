# Spoken-word highlighting — Responsive native preview Phase 3

Change ID: `studio-word-preview-responsiveness-20261008`

Status: **source-only; public impact required before any future release**.
This work follows Phase 1 project-wide local preparation and Phase 2 Khmer
forced-alignment provenance. The published Studio `0.85.6` release and
`.sthang/product-manifest.json` remain unchanged; this handoff is not a release
acceptance, published-download or deployment claim.

## Problems and bounded source changes

The original preview was driven primarily by HTML media `timeupdate`, which can
be much less frequent than short spoken-word intervals. It also grouped up to
eight uncached word paint states into one native preview HTTP response; the
current word could not appear until FFmpeg rendered every future state in that
batch. Repeated warm renders needlessly created and deleted a temporary worker
directory, and rewrote identical local ASS text on repeated samples.

Phase 3 responds to video-frame paint-boundary changes inside
`NativeCaptionPreview` via `requestVideoFrameCallback` where available, while
retaining standard media events and parent time updates as fallback. A decoded
frame only triggers a local overlay refresh when the native paint state changes,
not a React application-wide render on every frame. It selects a single exact
native frame for any currently missing spoken word and separately prefetches at
most four distinct future paint states within the current cue. An already-started
current render may finish when the video advances to another word in the same
cue, avoiding costly abort/restart loops. New media, caption edits, styling,
resolution or focus still invalidate the relevant pixels; old paint keys cannot
be mislabeled as the new word's exact frame.

The subsequent priority and cache correction keeps a single pending future
paint when playback reaches it, but interrupts a multi-paint prefetch if one of
its words becomes current. The newly current word then gets a separate native
request without waiting for the rest of that batch. During playback, lookahead
warms one subsequent paint; while paused, it may prepare up to four paints in a
bounded nine-state window. At the 24-image cache limit, older paints outside
the nearby/current display can be evicted to keep lookahead useful later in a
long clip. Complete decoded batches are admitted atomically within the existing
image/count limits, so a failed image cannot publish an incomplete cache update.

The persistent FFmpeg worker now avoids creating scratch directories solely to
discover that a compatible worker is already available. It also skips writing
unchanged ASS/focus documents, while reinitializing the native filter for every
requested seed and rereading the exact same native document. Renderer limits,
worker disposal, cancellation, fallback and no-hosted-transfer semantics remain
unchanged. Native preview and MP4 continue sharing ASS rendering, exact word
offsets, Khmer shaping, line wrapping, alpha recovery and Review Focus geometry.

## Reproducible synthetic evidence

Environment: Windows, reviewed Node `v24.21.0`, Intel Core i5-12500,
`Noto Sans Khmer`, FFmpeg `8.1.1` full build. All benchmark data is synthetic,
local-only and not derived from user media. Neither audio nor API keys are used.

Repeatable command: `node --import tsx scripts/benchmark-word-preview-phase3.mts`.
Four warm measurements at each size compare a single current spoken-word render
against waiting for eight distinct word paint states in a single native response.

| Native preview size | Current word response median | Former eight-paint response median |
| --- | ---: | ---: |
| 640 × 360 | 30.8 ms | 227.3 ms |
| 1080 × 1920 | 80.5 ms | 656.5 ms |

First-word PNG output was byte-identical to the same word in the full batch.
The persistent native worker did not restart or fall back during these samples.
These results measure **server-native response availability**, not browser paint
latency, end-to-end frame rate or a guaranteed speedup on real video projects.

The preexisting `npm run benchmark:caption-preview` also compares the ordinary
one-frame persistent renderer against its one-shot native reference. Baseline
warm medians were 31, 85.9 and 235 ms at 640×360, 1080×1920 and 3840×2160;
after these source changes they were 29.5, 81.4 and 245.2 ms respectively.
All compared native reference frames remained byte-identical, but these small,
mixed-direction differences are not evidence of a reliable raw renderer speedup.
The primary improvement is prioritizing the requested frame instead of delaying
it behind future paints.

### Follow-up priority/cache regression verification — 8 October 2026

Independent review of the corrected source found no remaining material
scheduling or cache-admission blocker. On reviewed Windows Node `v24.21.0`, the
focused Phase 3 browser scenarios passed and the wider 75-case browser run
passed across native preview, Appearance, motion, Review and word editing.
The added browser regressions verify that an unfinished four-paint lookahead
yields to a newly current word before its response completes, with exact native
PNG/bounds parity; they also exercise more than 24 spoken paints, demonstrate
at least 24 decoded and reused prefetched states, continue lookahead after cache
pressure, and refetch an evicted earlier word without altering saved timings.

The 97 word-timing/batch/Khmer provenance tests passed. Native caption renderer
and persistent preview checks passed 26 tests, with one optional FFmpeg 7.1
compatibility fixture skipped because that build was unavailable. Type checking,
production build, approved-brand verification and product-manifest verification
passed. These are source and synthetic acceptance results, not a measurement of
real Khmer speech boundary accuracy or low-powered-device playback latency.

## Safeguards and acceptance limits

- Spoken-word paint remains entirely native FFmpeg/libass, not CSS text painting.
- Existing project captions, manual word timings and source media are unchanged.
- Missing/review-required word timing still makes the caption plain.
- The same captured paint state is used in native preview and captioned MP4.
- Volatile per-look native PNG frames remain capped at 24 images / 32 MiB.
- Replay opening and motion effects retain their separate bounded preparation.
- Existing preview-service timeouts, two-worker bound and native fallback remain.
- No new provider, network audio transfer, dependency or release artifact.

Real user acceptance should measure rapid Khmer word transitions during
continuous playback, seeks, buffering, phone-sized layouts, low-powered devices,
different frame rates, and 4K previews. Compare late/blank native paints,
presented versus requested video timestamps, CPU and memory use, cancellation,
and native preview/MP4 pixels. Synthetic response timings must not be presented
as a universal frame-rate or latency guarantee.

## Public-impact and governance handoff

**Public impact: required**, because perceived preview responsiveness is
user-visible. Source evidence is `README.md`, `PRODUCT.md`, `DESIGN.md`,
`docs/FINE-TIMING.md`, `CHANGELOG.md`, this handoff and new unit/native/browser
tests. A future authorized HQ Phase 3 intake should review product copy and
real-device acceptance evidence before Sthang Distribution Phase 2 synchronizes
the `/studio/` website/docs. No HQ/Distribution mutation, version promotion,
GitHub Release or deployment is authorized by this source task.
