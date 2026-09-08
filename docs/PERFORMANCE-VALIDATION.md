# Performance batches 2 and 3: source contracts and validation

These are development-source changes, not a public release announcement or a
whole-app speedup claim. The accepted starting point was `c846091a4a92aebfb3d360130ce1857ffebab745`.
No Gemini, KFA alignment, segmentation, regeneration matching, SRT or appearance
rasterization math is replaced by these batches.

## Batch 2

`GET /api/projects?summary=1` returns only id, title, created/updated timestamps
and caption count. The original `GET /api/projects` full-project contract is
retained. The home launcher uses summaries and fetches the current complete
project on selection. Superseded project-open requests are aborted and ignored;
a failed read leaves the launcher available. Uploading cancels an outstanding
project-open request. The server still retains full projects in its store; this
is not a claim of lazy disk storage or reduced server-resident project memory.
Startup disk reads use batches of four and retain the original read order.

Startup requests publish independently. Project opening/upload waits for
preferences, not unrelated health/AI-status requests. Successful startup state
is not refetched by Retry startup, avoiding replacement of settings already
edited after startup. A failed independent endpoint is reported and can retry.

Explicit selection uses a first-occurrence id map and memoizes the final range
by caption array and indices. Playback does not rebuild that range when it has
not changed. The fallback remains a first-in-array linear search, including for
overlapping/out-of-order captions. No binary-search ordering assumption is added.

Waveform, export, appearance and regeneration workspaces are loaded on demand.
Their loading/error boundary is local to the tool, leaving the media/editor
available. Stateful settings/privacy/Find and Replace panels retain their existing
mounting behavior. A broken tool can be retried; permanent module failures can
still require an app restart, so no reload that could discard edits is automatic.

## Batch 3

Waveform peaks are exact multiresolution min/max blocks derived from the existing
PCM. Preparation yields between bounded chunks and is cancelled when its source
changes. Unaligned query edges use the original samples, never extrema from
outside a pixel's sample range. Original PCM remains available for silence snapping
and fallback drawing. Peak bytes count against the existing four-entry/128 MiB
browser memory cache; source PCM is referenced, not copied into a second cache.
The playhead has a separate transparent canvas. Following/zooming, caption edits,
selection and word-anchor changes still invalidate their affected drawing.

Native preview may reuse font-only staging under `exports/.working/preview-fonts-*`.
The cache is bounded to four font sets and 16 MiB. Keys hash current font bytes,
not just names/mtime. Active renders hold a lease until their subprocess finishes;
eviction never removes a leased directory. Changed/unavailable fonts are checked
again, and a full/failed cache falls back to the original private per-render font
copy path. PNG and ASS files remain per-render scratch and are removed on completion,
failure or cancellation. Font staging is not media/caption data, is not served or
redistributed, and is eligible for eviction/startup scratch cleanup. FFmpeg startup,
font-byte reads/hashes and native layout work still occur; a speedup is not assumed.
Video exports retain their original isolated font setup.

Job writes share one serialized queue and replace JSON through a temporary file
and rename. Repeated progress within a stage schedules one non-resetting two-second
flush, with one dirty bit while a progress write is in flight. UI notifications
remain immediate. Create, stage change, resume, cancel, failure, completion and
project removal await persistence; failed/interrupted export snapshots are retained.
Progress-only disk failures are reported and later updates/lifecycle barriers can
retry. A crash can lose the most recent sampled progress indication. This is not
a power-loss/fsync guarantee or a change to processing checkpoint semantics.

## Local checks (no hosted workflow required)

Read current repository instructions and command implementations first. Use isolated
state and synthetic media, no live install or cloud credentials. Run locked development
dependencies with `npm ci --include=dev --no-audit --no-fund`, then:

```text
npm run test:performance
npm run ci
npm run test:browser
npm run test:caption-renderer
npm run test:update-powershell
py -3.12 -m py_compile local-timing/worker.py
git diff --check
```

The local aggregate includes the focused performance suite; the strict root test
configuration checks its unit tests. The browser/native commands remain separate.
Do not run `package:windows`, `package:ota`, deployment or signing commands for
this validation. No workflow definition is changed. These commands do not authorize
pushing main, opening a PR, dispatching jobs or changing repository settings.

`npm run benchmark:performance -- <new-output.json>` records seeded synthetic
helper measurements, all timing samples, fixture/script hashes, UTF-8 bytes and
actual atomic job-write counts. The job-event clock is controlled at a 500 ms
cadence and file writes are real; it is not an actual encoder workload. Selection
reuse is not a React benchmark. Peak preparation time is recorded separately from
repeated exact queries. Library payload bytes are not network/startup latency.
Store output outside Git. The command refuses to overwrite an existing file.

Before acceptance, run actual Windows baseline/candidate browser startup and
project-opening comparisons, selection/Review tests, long-media Fine timing tests,
and native preview/export/caption-job contention tests. Reuse identical fixtures,
compare warm and cold conditions separately, preserve raw samples and report the
exact Node/Python/FFmpeg/browser/font versions. Check default production build
chunks and absence of development test hooks. Mutation checks must run the same
tests unchanged with only the target production behavior altered, then restore it.
Do not label missing native/Windows/full-history evidence as passed.

## Scope and public evidence

New dependencies, cloud transfers, licenses, branded artwork, installer changes,
release/version changes and external service provisioning are out of scope. The
product manifest's approved release/data-flow proposal is not advanced by these
source changes. Privacy notes describe the derived local peaks and font-only cache.
Do not promote an unreleased speedup on the website/docs or claim that the broader
startup, KFA, memory-lifecycle and contention audit is complete from these tests.
