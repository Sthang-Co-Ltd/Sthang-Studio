# Responsive native caption preview

Status: released in the Sthang Studio `0.85.x` Public Beta line and retained in
`0.85.5`.

Base: `c49a614b532d86a94e57fb5374d193633dd978d8`.
Change ID: `studio-smooth-native-preview-20260916`.

## Two feedback paths, one authoritative renderer

The browser may translate/scale the last matching native RGBA frame for Size and
Position. It never typesets captions with CSS. Native rounded font size/margins
define the anchor, and translations are projected into the contained video frame,
not the letterbox or source-sized CSS pixels. Changed caption text/state, output
resolution, clipped pixels or any other changed style field disable interpolation.
Size feedback temporarily scales effects and does not predict line wrapping.

The refining label stays visible until a matching native PNG is decoded. A failed
request remains an error with Retry, never a false exact result. Final export
continues to consume the saved appearance and unchanged shared ASS recipe.

Appearance publication is coalesced to browser animation frames. Pointer release,
pointer cancel, keyboard release, blur and workspace cleanup flush the last value.
Native starts are separated by at least 40 ms during interaction, with one request
in flight and no FIFO of intermediate slider values. A started current-frame
request may finish instead of being repeatedly killed; the newest value runs next.
Lookahead waits for editing to settle. Payloads contain only captions contributing
to requested states, including overlaps and remapped focus indices.

## Persistent native processes

Up to two project/media-scoped FFmpeg workers stay alive between preview requests.
The selected font staging identity, output dimensions, focus mode, executable and
alpha capability participate in the worker key. Font availability/bytes are still
checked when acquiring a lease; this does not pin a removed/replaced font silently.

FFmpeg's documented `-reinit_filter 1` behavior reloads the ASS filter when seed
frame dimensions alternate. Complete padded PPM packets avoid image2pipe waiting
for the next request. The seed is resized to the real output canvas before the
unchanged complex-shaped ASS composition; no source video is decoded for captions.
Static active states are rebased to time zero, preserving overlapping cue order.
The exact black/white coverage-recovery compositor is retained.

This is a **persistent FFmpeg process, not persistent libass glyph/layout caches**:
graph reinitialization deliberately reloads the changed document. A separate
direct-libass daemon would require its own binary supply chain, version/parity
validation and packaging. This implementation adds no such dependency and never
switches to a different installed libass or browser/WASM layout implementation.

PNGs stream through bounded, chunk-framed stdout; bounding boxes are associated
with the single outstanding frame. Workers time out, terminate on cancellation,
and expire after 15 seconds idle. Scratch cleanup waits for process closure and
outstanding writes. Project/media invalidation and font-library changes dispose
workers. Unsupported/crashed transport falls back to the established one-shot
native renderer and cools down repeated transport attempts for 60 seconds.
Cancellation never invokes fallback. See `PRIVACY.md` for local scratch retention.

## Local validation

Run from a source checkout with Node dependencies, FFmpeg complex shaping and a
compatible local Khmer regular/bold font:

```text
npm run test:video-export
npm run test:caption-renderer
npm run test:browser
npm run benchmark:caption-preview
npm run typecheck
npm run build
```

Tests compare native PNG bytes and bounds across live style changes, overlaps,
gaps, focus masks, portrait/square/4K frames and effects. Existing native tests also
compare actual MP4/export rasterization and check source preservation. Browser
tests delay native responses and exercise pointer/keyboard/cancel convergence,
display-scale geometry, stale response rejection and caption gaps. The FFmpeg 7.1
test explicitly skips when its optional local fixture is absent.

The benchmark uses only synthetic Khmer/Latin captions and isolated temporary
state. It reports one-shot medians, first persistent render and warmed medians,
and refuses results unless every native PNG/bound matches and one process handles
all 12 requests. These are native-render timings, not end-to-end UI latency or a
60-FPS guarantee. Real Windows workloads and real Apple Silicon/Safari acceptance
remain necessary before broad release claims.

## Recorded local benchmark — 2026-09-16

Final local validation on the implementation tree:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; approved brand assets verified |
| `npm run test:video-export` | 62 passed |
| `npm run test:caption-renderer` | 17 passed, 1 optional FFmpeg 7.1 fixture skipped |
| `npm run test:browser` | 67 passed in the final full run |
| `npm run test:macos` | 79 passed in the Windows shell/runtime-policy harness; not native macOS execution |
| `npm run test:web-optimizations` | 8 passed |
| `npm run test:public` | 16 passed |
| `npm run check:public` | Passed |
| `git diff --check` | Passed |

Initial browser runs exposed startup harness deadlines, not failing history
assertions. An isolated server startup probe measured 10.3 seconds on this PC;
the disk-backed suite's old six-second gate was replaced with a bounded 20-second
readiness window and one-second request timeout. Its history assertions and
interaction timeouts are unchanged. The complete 67-test suite was then rerun
successfully. Synthetic real-native screenshots were inspected for both the
visible refining label and its removal after the exact replacement.

### Native-render measurements

Windows, Intel Core i5-12500, Node 24.13.0, FFmpeg 8.1.1 Gyan full build,
Noto Sans Khmer. Twelve synthetic Khmer/Latin size/position samples per geometry;
capability/font discovery warmed before either path. Median warm time excludes
the persistent process's first request. No other test command ran concurrently.

| Output canvas | One-shot median | Persistent first request | Persistent warm median |
| --- | ---: | ---: | ---: |
| 640 × 360 | 106.7 ms | 98.1 ms | 29.9 ms |
| 1080 × 1920 | 166.3 ms | 137.9 ms | 86.6 ms |
| 3840 × 2160 | 343.3 ms | 270.1 ms | 232.5 ms |

Every PNG and caption bound matched the corresponding one-shot response exactly.
Each geometry used one persistent native process for all twelve requests, with no
fallback. These are synthetic native-render timings, not browser-frame timings,
real-project performance claims, or a guarantee of 60 FPS. The separate immediate
pixel transform supplies feedback while full-resolution native rendering catches up.

## Public impact and publication boundary

Public impact: required. Product-owned README, PRODUCT, DESIGN, PRIVACY, CHANGELOG
and manifest describe the changed interaction/exactness boundary and local scratch
lifecycle. No release version, download link, OTA pointer or artwork is changed.

At a separately approved release, propose HQ feature/limitation and data-processing
evidence updates, then Distribution `/studio/` website/docs synchronization. Exact
external files and approval digests must be resolved in those governed checkouts;
this task does not authorize or perform cross-repository writes or deployment.
