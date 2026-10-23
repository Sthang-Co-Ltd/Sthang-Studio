# Caption-list rendering benchmark

Tracker #10 is measurement, with no product optimization in this change.

```text
npm ci
npm run benchmark:caption-list -- data/working/caption-list-new-run
```

Use a new evidence directory whose parent exists. The command builds production
assets, runs all 38 browser isolation guards, and launches a production-only
frontend under an owned local namespace/port/process identity. It rejects a stale
build identity, foreign/unprefixed frontend requests, and an existing evidence
directory. It uses the existing synthetic API/media fixture; no user projects,
providers, installed Studio, signing, updates, or hosted services are contacted.
FFmpeg, the installed Playwright Chromium, and compatible local Khmer fonts are
prerequisites. macOS strict-isolation support remains unavailable in this harness.

The benchmark is separate from the ordinary browser suite. It renders the real
production App/CaptionEditor rather than timing a selection helper. Each size has
five fresh-document opens, ten trusted single-character keyboard inputs per
open, and 120 scroll-frame intervals per open. It checks every row exists and the
edited text remains correct. A local pinned Plus Jakarta Sans font is loaded;
Khmer glyph fallback uses this machine's installed fonts. The synthetic four-second
media is not played; long caption timelines test list scaling only. Plain
approved captions are used, with no transcript or word-highlight preparation.
This does not measure the cost of every review state or real media workload.

Open time runs from the project-card click to the second animation-frame callback
after the last row appears. Input time runs from the input event to its second
callback. These are rendering-opportunity proxies, not hardware presentation
latency or a React Profiler commit measurement. Scroll gaps include the driver
and headless scheduler. Long tasks cover the whole document through the end of
scrolling, including startup/focus/typing; they are not scroll-only. Quantiles use
nearest rank (upper middle for median). No CPU/network throttling is applied.

## Retained result

[Raw samples and identities](evidence/caption-list-20261022.json) were captured on
Windows 10.0.26300 x64, i5-12500, 12 logical CPUs, about 16 GB RAM, Node 24.21.0,
and headless Chromium 153.0.8010.12, at 1440 × 1000. The source baseline is
`264ed880437487ada49cd0874f027e18f2630491`. The checkout was dirty with the
benchmark tooling; production source was unchanged. The report pins the exact
benchmark source bytes, frontend source identity, and every production asset hash.

| Captions / rendered rows | Total DOM nodes | Open median / p95 ms | Input median / p95 ms | Scroll gap p95 ms | Gaps >33.4 ms / 600 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 3,327 | 69.9 / 82.4 | 30.1 / 31.7 | 16.7 | 0 |
| 500 | 15,727 | 232.0 / 313.6 | 34.6 / 56.3 | 16.7 | 0 |
| 1,500 | 46,727 | 552.5 / 692.3 | 89.5 / 143.9 | 16.7 | 0 |
| 5,000 | 155,229 | 2,085.8 / 2,607.2 | 296.5 / 463.8 | 66.7 | 348 |

The list currently mounts every caption row. The measured large-list input and
scroll costs justify investigating row rendering/virtualization in a future
change, preserving Khmer editing, focus, selection, row menus, review behavior,
and viewport stability. They do not establish that server lazy loading would fix
these client costs. Five opens are a small sample; p95 open equals the slowest
sample. This is one-machine synthetic evidence, not a customer performance SLA,
cross-device result, FPS promise, or claimed speedup.

The final four benchmark cases and 38 isolation guards passed. Explicit compiler
checks cover shared/server/web/test/benchmark TypeScript. Production build and
brand/public-manifest/service/history checks passed. Initial harness attempts
were rejected for config-relative startup, caret-position, API-response assertion,
and preview-POST assumptions; only the final successful run is published here.
No independent review was performed.

## Public impact: none

Compared with `.sthang/product-manifest.json`, README and its privacy/installation
evidence, this adds development measurement and bounded evidence only. Runtime
behavior, dependencies, data flows, release/download/access claims, and identity
are unchanged. No HQ/Distribution synchronization or release claim is proposed.
