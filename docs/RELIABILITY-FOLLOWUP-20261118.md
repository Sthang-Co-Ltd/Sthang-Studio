# Reliability follow-up after #118 (source only)

This report covers six items left open after #118. Each item was checked against
current `main` (`1ca9a5af09026612f3352adaa847cbd9f8b78ff9`) before any change.
Raw traces, logs, synthetic media records and diagnostic diffs were kept in a
local, git-ignored evidence folder. No private media, project, path or raw
network capture is included here.

| Item | Status |
| --- | --- |
| 1. Restore draft failure on `main` | **Fixed** (product geometry defect; regressions added; a related silent refusal and a narrow-toast reachability defect also fixed) |
| 2. Noto Sans Khmer Size 120 nonbreaking-space test | **Test contract corrected**; production unchanged; legacy-font false refusal documented |
| 3. Original-video `ERR_INVALID_HTTP_RESPONSE` | **Not reproduced**: neither synthetic media nor the owner-approved real footage reproduced it under the historical conditions; cause unknown |
| 4. 5,000-caption opening and scrolling | **Not shipped**; bottleneck attributed; corrected containment is correct for users but fails the traced CI gate, so eager rendering is retained |
| 5. Intermittent Windows renderer timeout and Vite `ECONNRESET` | Renderer **not reproduced** (5 local runs); Vite reset **cause not established** (trace analysis only); neither cause established |
| 6. Historical prepared-copy decode incident | **Blocked** on the exact artifact |

## 1. Restore draft failure

### Symptom

At the #118 merge, Ubuntu browser shard 4 failed
`tests/browser/stale-save-conflicts.spec.mts:451`. After a reload, the test
waited for an enabled **Restore draft**, clicked it once and expected the Khmer
draft within eight seconds. The original caption stayed visible.

### Evidence

- The retained CI trace shows one click on the Restore button with no
  interception retry. After it there was no network request, no "Checking
  draft…" state and no notice; the offer stayed enabled for eight seconds.
- The unchanged test failed once in 40 repetitions on Windows, with the same
  symptom.
- In both failures the clipped toast body had an internal scroll offset during
  the toast's entrance (0 → 55 px in CI, 0 → 99 px locally) that later returned
  to 0. The failure screenshot shows the button about 42 px below the point that
  was clicked.
- A held-entrance control isolated the mechanism. Playwright's scroll-into-view
  scrolled the still-clipped `.toast-slot-body` (an `overflow:hidden` scroll
  container) to reveal Restore. On press, focus applied
  `.toast-slot-body:focus-within{overflow:visible}`. That reset the offset and
  moved the button 137 px down before release, so the click landed on the
  surrounding section. The restore handler never ran, and the offered recovery
  copy was still present.
- 150 instrumented natural repetitions all passed and entered the canonical
  read. In the 110 runs under CPU contention, each listed the old page's final
  recovery copy and found it present at the click. Recovery-copy churn across
  the reload was not observed. The two uninstrumented failures are consistent
  with the geometry mechanism isolated by the held control, but cannot
  themselves exclude churn.

The defect is in the product. Any programmatic or focus-driven scroll of a
still-clipped toast could move its action between press and release. The test's
precondition was correct and the test is unchanged.

### Change

- `.toast-slot-body` now uses `overflow:clip` with `min-width:0` and
  `min-height:0`. It is no longer a scroll container, so focus cannot move an
  entering action. Every production build target (`apps/web/vite.config.ts`)
  supports `overflow:clip`. `min-width:0` keeps a long unbroken notice inside a
  narrow stack, because a non-scroll-container grid item otherwise takes a
  content-based minimum width. The focus-within overflow rule, entrance and exit
  transitions, inert exit and stack scrolling are unchanged.
- Investigation also exposed a separate, reachable defect in the same action. If
  the offered recovery copy was removed or rewritten before **Restore draft**, the
  action refreshed silently. It now announces "That recovery copy was removed or
  changed. Your current project is kept." This is the same message as the
  existing post-read refusal. It then refreshes the offer and requires a fresh
  choice. Focus follows the shared toast contract. If another copy remains, focus
  moves to its Restore action, unless the user has already moved focus. If the
  offer closes, focus returns to the control used before it, or to Project
  details when that control is unavailable. Exact-record authority, the
  canonical read, revision ownership and correction-evidence suppression are
  unchanged.
- Toast message text now wraps long unbroken runs (`min-width:0`,
  `overflow-wrap:anywhere` on toast message spans). Before this change, at
  390 px, a captioned-video completion toast with a long filename pushed its
  **Dismiss notice** button off the visible toast (x ≈ 944 px against a toast
  spanning 16–374 px), where it could not be clicked. This was already the case
  on `main`. With the change, the Dismiss button is inside the toast and was
  clicked successfully in the regression test.

### Verification

Retained local receipts from Windows Chromium, Node 24.22.1 x64, one worker and
zero retries, on the final branch:

- **Held-entrance controls on the previous CSS.** The pointer tests fail with
  internal offsets of 137 px (1440 px) and 152 px (390 px). First programmatic
  focus on Restore moves it 137 px. With the change, all pass, and one ordinary
  unforced click restores the draft with exactly one canonical read.
- **Refusal tests.**
  - A removed copy returns focus to the previously used caption field.
  - When that field becomes unavailable, focus goes to Project details. This
    case fails if the explicit fallback is removed.
  - A same-key rewritten copy needs a second deliberate activation to restore the
    replacement.
  - All refusals perform zero restore reads and zero project writes.
- **Narrow toast.** At 390 px, the long filename wraps to four lines (the whole
  message to five) and its Dismiss button can be clicked; on the previous CSS the
  button could not be clicked. Wrapping of long Khmer runs was not separately
  tested.
- **Recurrence.** The original `stale-save-conflicts.spec.mts:451` case passed
  40 of 40 repetitions on the final branch, against 39 of 40 on `main`. This
  supports the fix but does not prove it; the held controls establish the
  mechanism.
- **Suites and gates.** The recovery spec passed 21 cases. The recovery,
  stale-save, appearance-recovery and menu specs passed 52 cases. 13 further
  toast and recovery specs passed 92 cases. Edit-recovery unit tests passed 99.
  Typecheck, build and brand verification passed. The built CSS contains both
  toast rules.
- **Known limitation.** Safari mouse activation can leave focus on the page body.
  The shared focus hook then performs no handoff, as on the existing post-read
  path. This is untested and unchanged.

## 2. Noto Sans Khmer Size 120 with a nonbreaking space

The subcase `Noto Sans Khmer Size 120: hello\u00a0world` of
`tests/caption-overflow-native.test.mts` failed on a Windows host with Noto Sans
Khmer installed. Windows CI skips it because the font is absent. Ubuntu CI
installs `fonts-noto-core` and runs it: the Ubuntu caption-rendering job of
`main` run 44274847801 reports all three Size 120 subcases passing. That font's
U+00A0 mapping was not inspected.

Pinned runtime: Windows 11 build 26300, Node 24.13.0, FFmpeg 8.1.1 (libass
0.17.4, HarfBuzz 14.2.0, FriBidi 1.0.16, DirectWrite). The installed face is
Noto Sans Khmer Regular version 1.30 (2013), SHA-256
`b122766dedf4af57abc999c04c43eeaef48571c013ef1f388d9d7e6cffc6690a`. It maps
U+0020 but has no U+00A0 mapping.

The validator assigns a missing whitespace mapping the face's maximum advance
(2.0996 em). That keeps distant ink after blank runs inside the inspection
canvas. At Size 120 on 2160×3840 this widens the guard to 2,337 px. The padded
canvas then needs 36,630,240 pixels, above the 32,000,000-pixel safety cap. The
caption is refused as *unverifiable* before native measurement, with the message
"Caption bounds could not be safely checked. Reduce Size…". A separate padded
render showed the ink inside the allowed frame, on one line. The nonbreaking
space was drawn by a fallback face about 22 px wider than the primary face's
space.

**Classification:** the renderer's output is correct. The validator's refusal is
a conservative false refusal specific to this legacy face, and the test's fit
expectation was wrong for it. Raising the cap, substituting the primary space
advance, or calibrating a sentinel string were each rejected as unsound. The
fallback face's spacing is unknown in advance, and an underestimate accumulates
across long nonbreaking runs, which could let disconnected ink escape inspection.

**Change (tests only):** for that exact regular-face hash, the subcase now
requires `CaptionOverflowError` with kind `unverifiable`. Every other face must
still fit, which is verified by a mismatched-hash control. A new two-island case
(`hello` + 200 × U+00A0 + `hello`) must never fit. On this host the allocation
guard refuses it first, so it shows fail-closed behaviour rather than the
ink-boundary path, which the existing tests cover. The native file passed with
25 tests and the 2 existing Noto Serif skips.

**Known limitation:** with this 2013 Noto Sans Khmer face installed, large 4K
portrait captions containing a nonbreaking space may be refused as unverifiable.
On this face at 2160×3840, the same nonbreaking-space caption was measured as
fitting at Size 56 and Size 64. Ubuntu CI passes the Size 120 case with its
distribution font. Other sizes and font versions were not tested.

## 3. Original-video `ERR_INVALID_HTTP_RESPONSE`

Earlier isolated Windows/Chrome controls with private footage recorded invalid
responses while playback and seeking passed. Those controls issued 176–199
original range requests per run, almost all canceled. One qualifying capture
showed a fresh socket whose first 4,096-byte receive did not begin with an HTTP/1
status line and contained a NUL. The cause remains unknown. No serving change is
made.

New privacy-safe attempts used deterministic synthetic H.264/AAC media through
the production `/media` route in headed Chrome 157.0.8103.79, with a bare video
element and with the Studio editor. Each run needed 40 seconds of playback and
three paused seeks, including one near 35.03 seconds.

| Synthetic control | Runs | Original GETs | Invalid responses |
| --- | --- | --- | --- |
| 35 MB, 64 s, default cache headers | 7 | 41 | 0 |
| Same media, single variable `Cache-Control: private, no-store` (6) with interleaved default controls (2) | 8 | 48 | 0 |
| 607 MB, 5 min, ~16 Mbit/s, `no-store` (3) and default (2) | 5 | 25 | 0 |

The table counts the 20 completed runs: 114 original GETs, zero invalid
responses, every seek passed, zero preparation requests. Excluded as incomplete,
because they stopped before the media workload:
- six earlier headless attempts: five timed out waiting for the first frame and
  one timed out opening the editor;
- three editor starts interrupted by the first-run settings dialog.

Completed runs passed all 60 paused seeks. Synthetic media never produced the
historical many-range regime: 5–7 requests per run, against 176–199. Two hypotheses remain: the anomaly may depend
on properties of the original footage's container or interleaving, or on that
heavy request regime. Neither is established. The controls used the same Chrome version
as the qualifying historical capture, but a different harness and, for the
earlier headless controls, a different browser mode. File size, bitrate and
cache headers alone did not trigger it in these runs.

**Agreed diagnostic design for the next step** (not run):

1. Reproduce first with the exact original-only workload.
2. Join three observation points on one failing connection:
   - the server's accepted connection, recording bytes *submitted to the socket*
     with chunk, encoding and backpressure preserved, its four-tuple, lifetime,
     first request ordinal and range;
   - an independent loopback transport observation;
   - Chrome's request → stream → socket → parser graph from a late-started,
     bounded NetLog.
3. Compare equal-length ordered prefixes across chunk boundaries. Export only
   equality flags, structural classes, lengths, ordering and loss counters.
4. Treat as inconclusive any missing bytes, tuple-reuse ambiguity, truncated
   capture or unfinished NetLog finalization.
5. Require both a uniquely joined server-side fault and a single-variable causal
   control before any serving change.

**Owner-approved real-footage controls.** The local source videos were played,
unmodified, through the same harness and headed Chrome 157.0.8103.79 build. There
are three distinct files; a fourth is byte-identical to one of them. Each file was
served as a disposable, hash-verified copy that was deleted afterwards. Only
counts and container structure were recorded, with no capture.

| Condition | Runs | Original GETs per run | Invalid responses |
| --- | --- | --- | --- |
| `Cache-Control: private, no-store` | 6 | 183–201 | 0 |
| Default `public, max-age=0` | 3 | 164–188 | 0 |

- All nine runs completed 40 seconds of playback and all 27 paused seeks, with
  zero preparation requests.
- All of them reached the historical heavy-range regime, mostly canceled ranges.
- The source hashes were unchanged afterwards.
- A structure-matched synthetic replica was generated, but its run stopped at
  page navigation before playback. With no source failure left to match, it was
  not pursued.

**Status: not reproduced.** The warning no longer occurs under the historical
conditions on this machine: the same browser build, the same cache header and the
same request regime. It is not known whether the historical footage was one of
these files. The earlier cause, possibly an environmental condition at that time,
remains unknown. No serving change is made, because there is no reproducible
fault. The diagnostic design above stays ready if the warning recurs. A
kernel-level loopback capture would still need separate administrator
authorization.

## 4. Large-project responsiveness

All measurements below are synthetic. They use 5,000 Khmer/mixed captions and
four seconds of synthetic media, run against a production build on one Windows
x64 machine (i5-12500), in headless Chromium 153 with optional 4× CPU throttling.
They are timing proxies, not physical display latency. Every caption row stays
mounted: 5,000 text fields and 10,000 timestamp inputs.

**Current baseline at `1ca9a5a`.** Medians are shown with their range across
unprofiled runs.

| Metric | 1× CPU | 4× CPU |
| --- | --- | --- |
| Open to two frames | 1.72 s [1.62–1.87] | 9.32 s [8.76–9.61] |
| All rows ready | 1.39 s [1.36–1.47] | 8.19 s [7.88–9.05] |
| First usable edit (includes Playwright lookup and focus) | 3.13 s [2.97–3.24] | 16.9 s [16.1–18.7] |
| Steady-scroll p95 frame gap | 41.7 ms [33.3–50.0] | 191.7 ms [183.3–316.6] |
| Release to Saved | 131 ms [128–139] | 504 ms [449–541] |

An earlier three-run baseline in the same session gave 9.55 s [9.37–9.63] at 4×.
That is the same order as the roughly 10.9 s recorded in #117.

**Attribution (4×).** In the opening window, style recalculation took about
2.45 s, layout about 2.46 s and script about 3.28 s. In every opening profile, the
largest sampled leaf was the synchronous grid-width read in
`apps/web/src/components/EditorLayout.tsx:103`: 4.7–5.8 s of sampled self time
across six profiles in the first session, and 6.2 s in a later profiled sample.
That read forces style and layout for the whole mounted list. Steady-scroll
gaps of up to about 250 ms occurred with no recorded style or layout in their
windows. Their individual cause (paint, raster, compositor or scheduling) and
the separate React render and commit totals were **not distinguished**.

**Candidates measured as alternating matched pairs, then rejected:**

1. *Read the desktop grid width from the viewport instead of the element.*
   Opening stayed within baseline variability, with per-pair changes of +83,
   −121 and −14 ms at 4×. First usable edit was slower in every pair. Aggregate
   style and layout in the opening window were essentially unchanged, which
   suggests, but does not prove, that the layout work simply moved rather than
   disappeared.
2. *Row rendering containment* (`content-visibility:auto`,
   `contain-intrinsic-size:auto 132.6875px`, the measured median row
   height).
   - At 4×, opening fell to 3.87 s from 9.32 s, beyond baseline spread in all
     three pairs. Style and layout each fell by about 2.3 s.
   - First native focus rose from 4.6 s to 10.5 s, and first usable edit from
     16.9 s to 34.7 s.
   - Scroll gaps above 100 ms during pending and acknowledged saves rose from 7–8
     to 30 of 35 frames.
   - A middle row moved 420 px while the user typed, and scroll height drifted by
     104,538 px over a full scroll.
   - Five row-menu tests and two 5,000-caption continuation tests failed;
     baseline passed 29 of 29.
   - App Find and browser `window.find` behaved as on baseline.

   This breaks the caption-list viewport-stability invariant, so it cannot ship
   in this form.

**Owner-approved follow-up spike.** The C2b row jump had a simple cause. The
reserved size was the rows' border-box height (132.6875 px) used as their
*content* size, so each row grew by its 21 px of padding and border when it
rendered: 20 rows × 21 px = 420 px. A corrected prototype was measured but not
committed. It worked as follows:
- It reserves the measured content-box size of the common collapsed row, about
  111.7 px at 1440 px.
- It applies only to projects with at least 1,500 captions, and only to rows whose
  structure matches that measurement.
- A row stays rendered once it has come within two list heights of the viewport
  or has been interacted with.
- Rows with a menu open, focused, active or selected rows, and rows above the
  field being typed in are exempt.

Results:
- **Geometry.** Forcing 20 skipped rows to render during Khmer composition moved
  the edited row 0 px at 1440 and 390 px. The first-viewport screenshots were
  byte-identical, and all seven row-menu cases passed.
- **Correctness, tracing off.** The 5,000-caption recovery journey passed in
  24.6 s (eager: 28.0 s). Reopen, Restore and both reloads kept the exact values.
- **CI gate, tracing on.** With CI's `retain-on-failure` tracing, Playwright's DOM
  snapshot collection took 89.1 s on the candidate against 34.9 s on eager. The
  test ran out of its unchanged 120 s budget before the assertion; the page
  already showed the correct value. 28 of the 29 gate cases passed.
- **Not run:** the matched timing pairs, the size sweep and the full
  accessibility gates, because the spike stopped at the failed gate.

**Status: not shipped. Eager rendering is retained,** by the agreed rule that a
failed original gate keeps current behaviour. The containment approach looks
correct for users. Shipping it would need three things, which belong to a
separate, deliberate change rather than this reliability fix:
- a decision to reduce trace snapshot collection for the 5,000-row browser tests,
  which trades away failure-trace evidence;
- a per-structure height implementation;
- the full timing and accessibility gates.

Without them, the opening cost stays attributed but unchanged: about 1.7 s at 1×
and 9.3 s at 4×.

## 5. Intermittent test failures

**Windows persistent renderer.** The #118 PR-head failure began with
`persistent native preview preserves exact spoken-word paint states…`, which
failed `0 !== 8` after 5.6 s. Four persistent tests followed with errors
consistent with the 60-second fallback cooldown. The initiating exception was not
retained. Five local invocations of the CI commands passed with the opt-in
recorder: four concurrent renderer suites plus one isolated run, on Node 24.22.1
x64 and FFmpeg 8.1.1. Each time the spoken-word test made eight seed writes and
produced eight frames, with no fallback. **Not reproduced.** The watchdog,
fallback and tests are unchanged. The hosted recorder gate stays scoped to its
original approval.

**Vite `ECONNRESET`.** On Ubuntu shard 1, seven Playwright `route.fetch` forwards
to the owned Vite server failed with `read ECONNRESET` during a reload. Their
starts were within 3.8 ms of each other, while other module requests in the same
reload succeeded. All 403 successful forwarded responses advertised
`Keep-Alive: timeout=5`.
- In the trace's client-side timestamps, the latest preceding success ended about
  1 ms before the first reset completed.
- Earlier forwards ended about 4.7–4.8 s before the resets.
- The server's keep-alive timer starts at server-side response completion, which
  the trace does not record. The trace also lacks socket identity.

No local reproduction was attempted. Ubuntu browser shard 1 passed on the later
`main` run 44274847801 and on this PR's CI run 44301362166. A keep-alive expiry race (5 s server timeout
against client socket reuse) can therefore be **neither confirmed nor
excluded**. The cause is **not
established**. Neither keep-alive, timeout nor retry behaviour is changed. A
bounded socket-lifecycle recorder stays local until a controlled failure
demonstrates a unique client/server join, retained artifacts and acceptable
overhead.

**5,000-caption time budget (new occurrence during this PR).** On this PR's
docs-only head `588b4da`, Ubuntu shard 2 failed
`large-project-continuation.spec.mts:81` with "Test timeout of 120000ms
exceeded". The same code had passed on `84cec1a`. The retained trace shows the
workflow completing:
- **Restore draft** restored the draft on its first click.
- All restore assertions passed, Save reached "Saved", and after the final
  reload the first and middle captions matched.
- The test's total budget ran out during the last-caption assertion, so the
  reported empty value reflects teardown, not lost data.
- Individual Playwright actions took about 1 s each on that runner.

#118 recorded the same near-budget behaviour for this test. It is a test-budget
intermittent, not a product regression. The 120-second budget and the
eight-second assertion bounds are unchanged.

## 6. Historical prepared-copy decode incident

The incident needs the exact 3,789,112-byte prepared copy with SHA-256
`0fefbc12ef87ff92d67a8e6e16e41866569d8dd541c05fce947b13f13c1ab090`. A bounded
re-scan of 39 existing roots, the Studio checkout and its registered git
worktrees, found no file of that exact size. Dependency, `.git` and
virtual-environment folders were pruned. Six further registered worktree paths
no longer exist and could not be scanned. With the owner's authorization, two
more places were checked, read-only:
- the session's upload (attachments) folder: 21 files, no videos, no size match;
- Studio's installed data folder: 4 folders and 7 files, no size match. Studio's
  working data on this machine lives in the dev checkout, which was already
  scanned.

**Blocked.** The artifact is not present in any approved location on this
machine. Another file is not a valid substitute, and no fix is claimed.

## Out-of-scope observation

On this Windows host, a native portrait preview fixture used by a large-project
correctness case returned "Caption bounds could not be safely checked" on
unchanged `main`. The request and response were byte-identical with and without
the profiling prototype. It was not investigated further here.

## Public impact

- Item 1: **none.** The recovery workflow, its claims and data handling are
  unchanged. The refusal notice, focus behaviour and toast wrapping improve
  existing editor behaviour without changing advertised features. The source
  recovery guide documents the notice and focus.
- Item 2: **none.** No supported behaviour changes; the legacy-font limitation
  is documented here.
- Items 3, 4, 5, 6: **none.** These are local diagnostics, measurements and
  reporting only; no product code changed for them.
