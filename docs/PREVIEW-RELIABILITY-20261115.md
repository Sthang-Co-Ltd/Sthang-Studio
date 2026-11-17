# Preview reliability investigation (source only)

Local follow-up change ID: `studio-preview-reliability-local-20261115`.
Upstream cloud change: `studio-preview-reliability-20261115`.
Base: `06640a1ee9a083f0beff312390ea7be9a14f5827`.
These changes are an unmerged development branch, not a release or an established
diagnosis of the reported local playback incident. The original cloud investigation
used generated video only. The later Windows investigation keeps source footage
local and records only privacy-safe playback, timing and transport metadata.

The [November 18 follow-up](PREVIEW-RELIABILITY-FOLLOWUP-20261118.md) records later
save, browser-regression and transport checks. Historical failed checkpoints in
this report are preserved.

The original cloud patch is commit `433b5737d99095cb9b8eca87e64fa0d68bf37626`,
78,600 bytes, SHA-256 `b6a22a9a3557e174536f002121764e092c9868191f7ce5e6e1c6c01b972835a9`.
It was checked and applied to an isolated branch based on the same main commit.
The cloud results below are historical evidence; they are not the final Windows
validation results. Local publication and first-frame corrections are described
in the Windows follow-up section.

## Established problems and changes

- The client had no deadline for preview headers/body and retried status failures
  indefinitely. Requests now have a 25-second deadline; direct original playback
  becomes available after 1.5 seconds while a slower initial inspection continues
  within that same request bound. Three consecutive polling errors or a 16-minute polling window
  expose Check progress/Cancel. A fresh explicit check starts another bounded window.
- Retry recreates the decoder immediately, then checks the exact compatible URL.
  Only confirmed 404/410 absence starts latest-copy lookup or rebuilding; an
  unavailable optional check does not block player recovery. Position/settings
  and the editing session survive. Operation and terminal-response ownership
  reject late replies, including cancellation replies after a poll reaches ready.
- An open compatible copy could be evicted and Retry would request the missing URL
  again. Validated file use renews a two-minute lease; the open player sends HEAD
  to its exact URL every 30 seconds, including while paused or retaining a copy
  during rebuild. In-flight responses pin that file. New encoding refuses admission
  if protected files leave insufficient space within the 2 GiB/64-project bound,
  reserving another 512 MiB for staging. Sleeping/crashed tabs eventually expire.
- Force preparation removed the prior published copy before encoding. A rebuild
  now publishes a unique generation file and atomically switches the metadata
  pointer. Protected older URLs remain readable; failed or cancelled candidates
  leave the prior publication intact. Media replacement/deletion still invalidates
  the project cache. Deletion first aborts and awaits active preview preparation;
  its media-change gate prevents admitting another preparation in that interval.
- A first video frame is required before recovery completes on browsers with
  frame callbacks. The initial 20-second visible-page deadline also catches a
  paused player or an advancing audio clock with no picture. After a first frame,
  the progress watchdog permits sparse video with an advancing clock. Loaded data
  is the fallback for audio and browsers without video frame callbacks. Background
  pages reset the wait; recovery never automatically resumes playback.
- Installed Chrome on this PC presented the original HEVC video even though both
  HEVC capability hints were empty. An owned original frame now takes precedence
  over those advisory hints. When frame callbacks are available, a blank original
  gets five visible seconds before one automatic preparation request. Delayed
  inspection respects frames already presented, and hidden time cannot consume
  the trial. Actual decoder errors still trigger preparation immediately; the
  older-browser hint fallback is unchanged.
- Cached startup opened the original and then switched sources. A bounded lookup
  now chooses a promptly returned cached URL before opening either source. If the
  lookup is slower, original fallback is released without discarding a valid late
  inspection. Source/operation ownership rejects obsolete replies. Whole-file
  proxy encoding remains unchanged.
- A development StrictMode ref replay could cancel a new decoder's presentation
  watcher without recreating it. Watch lifetime now belongs to the layout effect,
  explicit replacement and media errors; the ref callback still binds the clock.
- A save warning could briefly behave as a fixed overlay before its footer class
  committed, prematurely closing a menu. Toast layout is now reported in a layout
  effect before resize observation, with the existing observer retained for child
  exit transitions and the existing caption-focus capture preserved.

## Original cloud native experiment

Cloud Linux, Node 24.22.1, FFmpeg 7.1.5. One generated 180-second 1280x720/25fps
moving HEVC video with AAC audio; compatible output 43,191,120 bytes.

| Measurement | Observed |
| --- | --- |
| Cold request to ready status | 18,482 ms |
| Five warm status reads | 2.00, 0.87, 0.86, 0.90, 1.59 ms |
| Complete compatible-file FFmpeg decode (`-xerror`) | Passed, 2,036 ms |
| Beginning/middle/end byte ranges | HTTP 206, exact 100 bytes each |
| Original file hash | Unchanged |
| Deliberately removed compatible file | HTTP 404; status returned original |
| Browser cold/warm first visible frame | **Not measured** |

Run `npm run benchmark:media-preview` for a fresh synthetic-only native benchmark.
It runs a real preview router/service in owned temporary state, writes measurements
to ignored `test-results/long-preview-native.json`, and removes its media afterward.
These numbers are API readiness/cache measurements, not browser or Windows/Mac
customer speedups. Full-file encoding still delays cold compatible playback.

## Original cloud verification and limitations

| Check | Result |
| --- | --- |
| `npm run test:media-preview` | 21 passed, 0 failed |
| `npm run test:media-clock` | 8 passed, 0 failed |
| `npm run test:media-replacement` | 118 passed, 1 failed |
| Same replacement failure on untouched main | Reproduced: expected 409, got 428 `APPEARANCE_BASIS_REQUIRED` at `tests/preserve-media-server.test.mts:809` |
| `npm run typecheck`, `npm run build` | Passed (existing large-bundle warning) |
| `npm run check:public` | Passed, including staged additions |
| Browser isolation prerequisites | 36 passed, 2 failed at Chromium launch |
| Browser scenario discovery | 19 scenarios load successfully; execution blocked |

At the cloud checkpoint, the unrelated replacement assertion was left unchanged.
No full CI, Windows, macOS, hardware-decoder or customer-footage validation had
been performed. The subsequent local task corrects that request fixture.

Native/API tests cover request headers and stalled bodies, cancellation,
source binding, complete timeline metadata, VFR timestamps, range transport,
cache pressure/lease expiry, response pinning, eviction overlap, stale-stage
cleanup, rebuild preservation, and deterministic watchdog behavior.
Browser regression cases cover direct warm startup, missing-copy recovery,
bounded polling, silent stalls and editing continuity; a separate three-minute
browser test uses the real conversion service and later seeks.

The cloud environment could not launch the installed Chromium: Unix socket creation returned
`EPERM` even with the permitted test command. The browser test runner's isolation
prechecks passed 36/38; both failures were browser launch. The provided cloud
browser also could not reach the workspace loopback listener. The browser tests
therefore **had not run at that checkpoint**, including first-visible-frame and full-app continuity
checks. Native decoding does not prove browser/GPU/driver decoding behavior.

Output publication retains the existing codec/audio/timeline/size validation.
There is no new full-file decode on every user preparation or cache hit. Same-size
external cache corruption remains possible and explicit Prepare playback can
rebuild a failed copy. After a first frame, a frozen picture with an otherwise
advancing clock is not automatically classified as a stall. The Windows follow-up
below adds local browser evidence; complete supported-platform validation remains
a release requirement. The historical incident cause is unknown.

## Windows follow-up

Local review identified that retaining a previous file only until a forced rebuild
finishes is insufficient: replacing bytes behind the same URL can mix generations
across later byte-range requests. Publication must keep immutable generation URLs
and switch only the current metadata pointer, retain protected previous generations,
and leave the previous pointer intact if a candidate fails before publication.

The browser evidence must distinguish the earliest visible frame from the first
compatible-copy frame. Forcing an application's codec heuristic does not disable
the browser's decoder. A loaded metadata event or an advancing audio clock does
not establish that a video frame was presented. The native browser regression
therefore checks source-owned frame callbacks, continuous playback through the
reported 35-second region, later seeks and an independently snapshotted pending
caption edit. The standalone API benchmark also bounds each request, verifies
Content-Range and exact byte slices, and reports FFmpeg decode separately.

### Retained main-browser failures

Run `43671306656`, head `06640a1`, Ubuntu shard 3/4, had 262 passing tests and the
two reported failures. The retained trace, screenshot and accessibility snapshot
showed the failed-save toast with `role="alert"`, no `aria-hidden`/`inert` ancestor,
and Retry/Download recovery actions. The failed PUT returned 503, and the alert
was present within the assertion's eight-second window. This is evidence for a
fixture/timing synchronization problem, not a missing accessible alert. The exact
CI timeout did not reproduce in the unchanged local test. A separate 5,000-row
Windows diagnostic did not establish a consistent global-versus-scoped role
lookup penalty, so no locator-performance cause or speedup is claimed.

The corrected save test registers and awaits the exact failed PUT before asserting
the semantic alert inside the toast stack. It keeps the eight-second assertion
limit and the recovery, pending-edit and workspace-continuation checks.

The menu trace showed a usable first action above the late warning/footer. Closing
is required when the trigger is clipped or there is insufficient room for an
enabled action; the original test assumed every warning necessarily caused that
geometry. The corrected test separately establishes usable space and insufficient
space, then verifies actual hit targets, keyboard traversal, scrolling, closure
and focus restoration. It preserves draft, playback and DOM-identity checks.
The unchanged Windows case closed while the retained Ubuntu case remained open.
The new safe-space regression then exposed an additional product timing defect:
the alert mounted while the workspace still lacked its footer classes. In that
intermediate layout it was a fixed overlay, so a resize observer could close the
menu even though the eventual footer left enough space. The final trace measured
a 58-pixel minimum whole action and 133 pixels available before the warning, with
more than one action's height remaining after the footer settled.

`ToastStack` now reports committed notice DOM in a layout effect using a shared
signature to suppress duplicate reports. App still captures the focused caption's
old visibility before changing layout, and the mutation observer still handles
child-only exit transitions. The existing safe-space assertion, insufficient-space
assertion, geometry and eight-second limits remain unchanged. Both cases passed
in the focused correction run.

### Browser-executed lifecycle findings

The first complete preview/broader Windows run passed 63 of 87 cases. Twenty-three
preview cases reached their compatible source, loaded metadata and restored paused
position, but retained `Restarting playback...`; the native case timed out in setup.
This result was retained and diagnosed before applying corrections.

Installed React 19.3.0's development implementation replays a newly placed host
element's ref after normal layout effects. Replacing the keyed video therefore
called `attach(null)`/`attach(video)` without replaying the unchanged parent
`SourceMedia` effect. Both ref calls cancelled its just-created presentation watch.
The clock survived because ref attachment recreated that separate binding. This
explains the real-frame and controlled-frame failures without treating metadata
or clock advancement as a picture. Actual watcher retirement remains in effect
cleanup, explicit replacement and error handling. A video/audio tag change also
reruns the effect. The paused replacement test now requires a pending frame
callback and every explicit frame presentation requires a delivered callback.

The native fixture's top-level test-body timeout did not extend its `beforeAll`
hook, which still had a 30-second budget. The hook now explicitly has 240 seconds
for fixture setup, including its existing separately bounded 180-second synthetic
encode. Playback, frame, seek and encode assertions were not relaxed.

A focused normal-runner check passed all 38 isolation prerequisites and six browser
cases in 25.8 seconds, with no retry: HEVC fallback, both delayed cancellation
outcomes, paused first-frame recovery and both menu-space outcomes. Independent
cross-review found no blocking issue in the actual lifecycle corrections. This
development replay defect does not diagnose the older prepared-copy incident.

The subsequent 121-case Windows run passed 119 cases and exposed two additional
failures, with no retries. The native three-minute fixture's initial status GET
returned HTTP 200 and HEVC metadata after 6.81 seconds. The client's 1.5-second
startup request deadline had already discarded it, leaving an original player
with no picture and no automatic preparation. Startup now separates the short
original-playback fallback timer from the normal 25-second status deadline.
Timer, response and failure handling share project/operation ownership, and
settlement/unmount clear the fallback timer. Delayed original/cached responses,
retained playback settings, navigation and an already ready cache are covered by
explicit regressions. A late compatible-copy selection intentionally pauses and
replaces the original while retaining position/settings; it is not uninterrupted
playing-state continuity.

The evicted-copy scenario timed out before eviction or Retry: it waited for a
save while the caption textarea remained focused. Studio deliberately defers
text autosave during editing. The fixture now focuses Caption 2 to commit through
the normal blur path, then asserts that its request is held. It retains the
one-HEAD/one-rebuild, unsaved draft, persisted-caption and restored-position
assertions. This failure required no product save behavior change.

### Media-replacement contract

The unchanged-main 428 response was reproduced. The appearance-write contract
requires an `expectedAppearance` basis before checking stale media; the real
client already supplied it, but the older test fixture did not. The fixture now
supplies that basis and still requires 409 plus the media-specific conflict.
Unbound appearance writes still require 428. The export-admission spy follows the
actual `createWithDisposition` call, and the assertions still require no enqueue
and no mutation of the replacement project.

### Local footage and first-frame measurements

Windows 11 Pro build 26300, Intel i5-12500 (12 logical CPUs), 15.7 GiB RAM;
Node 24.21.0, Playwright 1.63.0 bundled Chromium 153.0.8010.12, FFmpeg/ffprobe
8.1.1. Browser/encoding workloads ran serially. User applications were left
running; this is a working PC, not an otherwise idle benchmark machine.

The local sample was 179.676 seconds, 159,594,010 bytes, HEVC `hvc1`,
1080x1920/30 fps, 8-bit SDR BT.709, with stereo 44.1 kHz AAC and zero time origin.
Its existing 10,920,413-byte compatible copy contained H.264 at coded 406x720
with AAC and matching stream origins/durations. Browser natural dimensions may
reflect sample aspect ratio and are not the coded dimensions.

The first-frame harness used a standalone video element and direct loopback HTTP
byte ranges. It blocked external browser requests and recorded only aliases and
playback/transport metadata. Cold here means the first opening in a fresh browser
context of an already existing file, **not** an empty preview cache or disk cache.
Warm means reopening in that context; HTTP caching was disabled and the OS cache
was not reset. Hashing the inputs beforehand may warm that cache. A visible frame
means a `requestVideoFrameCallback` compositor submission, not a measured physical
display event. These measurements exclude Studio UI and preparation time.

| Existing compatible-copy opening | First-frame samples | Median |
| --- | --- | --- |
| Fresh context, three samples | 56.8, 50.7, 55.8 ms | 55.8 ms |
| Same-context reopen, three samples | 63.9, 46.7, 58.5 ms | 58.5 ms |

All six copy trials presented 1,200 frames during approximately 40 seconds at 1x,
with no media error. All 24 paused seeks (start, 35.033491 seconds, midpoint and
near end) presented an appropriate frame. The range server recorded no short read
or file-read failure. Source and copy size, modification time, file identity and
SHA-256 were unchanged after measurement.

All six original-file trials instead had zero video frames and zero natural video
dimensions while `readyState` was 4, the clock advanced and `MediaError` was null.
No seek presented a frame. Range requests aborted by the browser were recorded
separately from server read failures; none established a short-read/content-length
failure. This reproduces an audio-clock/no-picture failure and supports the new
first-frame watchdog. It does not reproduce the historical compatible-copy error.

A local stream-copy fast-start remux took 21,879 ms and produced 159,671,966 bytes.
Encoded video/audio payload hashes and stream duration/origin metadata matched;
the whole interleaved packet-sequence comparison did not match, so complete
per-stream timing equivalence was not established by that comparison. Neither
fresh nor warm remux opening produced a picture. The AAC audio already played,
so an audio-only conversion would not address this observed video failure.
No new remux/audio-only product shortcut or encoding-speedup claim is introduced.

An installed-Chrome comparison used version 157.0.8103.78 in an isolated headless
profile with the same direct-range harness, one fresh-context/reopen pair per
source, disabled HTTP caching and unreset OS caches. The original presented its
first frame after 1,908.2 ms fresh and 77.8 ms warm; the existing compatible copy
took 213.0 and 54.7 ms. Both sources played for 40 seconds on each opening and
presented all eight paused seeks per source, including the reported failure
position. Neither produced a media error, short read or server file-read failure.
Source/copy hash, size, modification time and file identity were unchanged.

Every Chrome trial reported empty `canPlayType` results for both `hvc1` and `hev1`
while actually presenting original video. That is direct evidence that the
previous automatic-conversion decision could reject working playback on this PC.
The new five-second trial gives actual owned frames precedence without changing
encoding, audio, timing or export behavior. It adds a bounded wait for originals
that stay blank; it is not a general five-second stall deadline. Component-level
measurements and their transport limitation follow below.

The production-mode `SourceMedia` component was then bundled with the current
helpers in memory and mounted in a minimal local wrapper, with the production
preview-status router and an empty compatible-copy cache. The same installed
Chrome used direct range streaming, disabled HTTP caching and unreset OS caches;
the source was hashed and copied first. The wrapper's original-file route used
Express `sendFile`, rather than the complete Studio application's middleware.
These timings include component inspection/selection but exclude browser launch,
source copying, bundling and full Studio application startup.

| Actual SourceMedia original opening | Mount to first frame | Selection to first frame | Paused visible observation |
| --- | --- | --- | --- |
| Fresh context | 798.4 ms | 553.9 ms | 6,569.8 ms |
| Same-context reopen 1 | 167.4 ms | 134.3 ms | 6,556.4 ms |
| Same-context reopen 2 | 194.7 ms | 165.4 ms | 6,554.1 ms |

All first frames were paused at media time zero. All three HEVC inspections
completed with HTTP 200 despite empty `hvc1`/`hev1` hints, and the component made
zero preparation requests. The fresh opening presented 1,168 frame callbacks
over 40.037 seconds at 1x, with frames in every second and 58 within 34–36 seconds.
The largest recorded presentation gap was 119.4 ms; this is not a drop-free
presentation claim. Paused seeks near 35.033491 seconds, midpoint and near end
presented matching frames in 21.2, 142.2 and 87.5 ms. Both reopenings also played
briefly. All samples retained one video element with no media error or Retry.

The synthetic wrapper draft and its focus survived the paused observation with
rate 0.75, volume 0.35 and mute enabled. The fresh trial deliberately changed rate
to 1 for continuous playback; focus moved on the explicit Play action. This is
component-state evidence, not a substitute for full App caption-persistence tests
or a listening-based audio-quality assessment. Original/copied-source identity
and the persisted alias project were unchanged, and owned cleanup completed.

Transport was not clean: the wrapper recorded 184 original GETs, four completed
206 responses and 180 aborted responses. Browser events included 156 `ERR_ABORTED`
and **22 `ERR_INVALID_HTTP_RESPONSE`**, all of the latter in the fresh sample.
The server's source callbacks were all `ECONNABORTED`, with no separate recorded
non-abort file-read error or response-error event. These categories must not be
collapsed into a claim that every cancellation was harmless. The report did not
correlate browser failures with individual ranges/timestamps, so it cannot locate
or explain those 22 invalid responses.

The standalone Chrome original trials also made many incomplete ranges (204 of
206 fresh, 200 of 202 warm), but recorded no invalid-response events. Their custom
range server and player differ from this component wrapper.

A bounded follow-up used the same original-file middleware as Studio,
`express.static(config.uploadDir)`, and correlated server/browser/CDP metadata.
Its one fresh-context opening presented the original at 3,196.0 ms from mount,
286.3 ms from source selection, and made zero preparation requests after 6,558 ms
of visible paused observation. It then presented 1,176 callbacks over 40.030 s
at 1x, including 59 within 34–36 s. All three paused seeks presented matching
frames in 15.4, 151.5 and 90.8 ms. The same element, wrapper draft, source identity
and alias project were preserved, and all owned cleanup completed.

That run deliberately **failed its transport verdict**: 24 original-file
`ERR_INVALID_HTTP_RESPONSE` events were seen independently by Playwright and CDP,
in addition to 159/160 respective `ERR_ABORTED` observations. The summary's 48
transport-issue observations are not 48 distinct failed requests. The server
recorded 185 original GETs, two completed 206 responses and 183 aborted responses.
Its declared range lengths were consistent and completed responses' submitted
write/end byte counts matched Content-Length. There was no middleware error or
media error. Submitted bytes are not proof of delivery, and the invalid responses
had no browser-accepted headers or response ID, so server header consistency
does not prove those transfers were valid.

The invalid events occurred during continuous original playback, with a ready
player and continuing frame callbacks, and were followed by repeated range
requests. This reproduces the original-file transport anomaly under an
instrumented local wrapper, not the historical prepared-copy decode failure.
The wrapper still used Playwright request interception in that run.

One further comparison removed all Playwright route/Fetch interception, retained
CDP network observation, explicitly disabled HTTP caching and restricted document
resources to the owned local origin with CSP. The bundle had no external imports.
This run also failed its transport verdict: **28 invalid-response events** appeared
in each browser/CDP event stream, with 146 abort observations in each. Of 176
original GETs, two completed and 174 aborted. Declared range lengths and completed
submitted-byte counts remained consistent; no middleware or media error occurred.
The first original frame arrived at 1,423.6 ms from mount, 964.9 ms from selection.
It retained the source after 6,573.7 ms paused, made no preparation request,
presented 1,168 callbacks over 40.067 seconds, and presented all three seeks in
12.0, 120.4 and 445.9 ms. The largest presentation gap was 289.4 ms, so this is
not a drop-free presentation result. Source/project identity and cleanup passed.

The anomaly therefore does not require Playwright Fetch interception. A final
bounded Default-mode Chrome NetLog capture used the same no-interception wrapper
with the original footage remaining local. Its transport verdict also failed:
16 original-file invalid-response events and 139 abort observations appeared in
each browser/CDP stream. Playback still presented its first original frame in
2,294.4 ms, continued for 40 seconds, presented all three paused seeks, and made
zero preparation requests, with no media error. Source/project identity and owned
cleanup passed. This logging run is diagnostic evidence, not another startup
performance benchmark.

The locally sanitized NetLog summary contains 125,381 captured events and 158
request sources for the exact local media alias. The 16 invalid request sources
generated 64 propagated error events; those are 16 requests, not 64 incidents.

| NetLog evidence for the 16 invalid request sources | Captured result |
| --- | --- |
| First direct error stage | All 16 at `HTTP_STREAM_PARSER_READ_HEADERS` |
| Accepted response-header events | Zero for these 16; 141 across all alias request sources |
| Related fresh TCP connection evidence before the error | All 16 had a socket connect begin and successful end |
| Explicit socket-reuse evidence | None captured; absence is not proof of every connection property |
| Recognized socket destination matches the owned loopback origin | All 16 |
| Dependency traversal truncated | None; optional displayed history was trimmed |

This places the observed failure at HTTP header parsing on related fresh local
TCP connections. It does not support attributing these failures simply to reuse
of an old pooled connection. The failed requests have no accepted response headers
or captured rejected wire prefix, so the summary cannot establish the malformed
or interrupted bytes, or assign the cause to the server or browser/network stack.
Server-declared range lengths and submitted write counts are not wire-validity
proof. The internal `HTTP_CACHE_DOOM_ENTRY` error events are also not counted as
additional media transport failures. No original-file serving change was made on
this evidence, and no fix of this anomaly is claimed. The historical failing
prepared copy remains unavailable.

The raw NetLog stays in ignored local working data. The bounded local parser
omitted 56 TLS-handshake byte fields in memory, rejected other forbidden payload
fields, and emitted only allowlisted counts, event names, numeric IDs/ranges and
checks. It did not change the raw file or emit raw headers, payloads, addresses or
URLs. The retained sanitized evidence is
`data/working/preview-reliability-20261115/source-media-direct-2026-11-15T09-08-19-987Z-145bfe-netlog-summary.json`.

The empty-cache follow-up used the production preview service/router with that
same local sample and a minimal video page. It cancelled scheduled project
prewarming, used direct loopback HTTP without response buffering, disabled HTTP
caching, and ran one browser/encoder workload at a time. The source was hashed
and copied first; OS caches were not reset. This measures preparation plus
compositor submission, not Studio project-open/overlay rendering or physical
display latency.

| Local-footage production preview | Measured result |
| --- | --- |
| Empty-cache request to ready status | 34,489.8 ms |
| Empty-cache request to first presented frame | 34,599.4 ms |
| Selection of prepared URL to that first frame | 109.6 ms |
| Three warm reopenings, request to first frame | 44.2, 43.7, 49.5 ms; median 44.2 ms |
| Continuous playback | 39.960 s at 1x, no media error; 61 frame callbacks within 34–36 s |
| Paused seeks | All 12 presented frames near 35.033491 s, midpoint and near end |
| Beginning/middle/end ranges | Three HTTP 206 responses, exact 100 bytes and matching Content-Range |
| Full compatible-file FFmpeg decode | Passed, 1,057.6 ms |
| Source/copy timing and audio metadata | Matching video/audio start times and durations; stereo 44.1 kHz AAC |
| Original and copied-source hashes | Unchanged |
| Owned browser/server/cache/temp cleanup | All completed |

The prepared output was 10,920,413 bytes. The HTTP monitor recorded 13 range
responses: 10 completed, three closed before completion, and no response error.
The browser recorded six `ERR_ABORTED` request failures during the run; no
`ERR_CONTENT_LENGTH_MISMATCH` or media error was recorded. Aborted requests are
kept distinct from failed reads and are not described as successful full transfers.

The final synthetic Studio UI conversion case also passed on Windows: a generated
180-second 1280x720/25 fps HEVC/AAC input reached its first compatible frame in
21,765.7 ms from project opening, or 20,974.6 ms from the preparation fetch invocation.
The fixture explicitly requests Prepare playback unless a real decoder error or
the bounded no-picture trial has already started its single preparation request.
Three prepared-cache project reopenings took 899.3, 1,037.0 and 1,791.1 ms
(median 1,037.0 ms), with zero original-media requests. It preserved a held caption
edit, played for 40.353 seconds at 1x through the 35-second region, and
presented/played after seeks to 30, 90 and 165 seconds. The full output decoded
in 2,130.6 ms. These fixture media routes use Playwright `route.fetch/fulfill`,
which buffers responses and disables HTTP caching; OS caches were not reset.
These UI timings must not be presented as direct production-streaming timings
or as a comparative speedup over earlier runs.

The earlier reported incident was `MediaError` 3 / `PIPELINE_ERROR_DECODE` near
35.033491 seconds, with an earlier content-length mismatch, in a different
3,789,112-byte prepared copy. That exact copy was not found in the approved local
locations. It differs from the available copy and the browser/build conditions.
**The actual historical prepared-copy error has not been reproduced.** Immutable
publication removes a demonstrable range-generation race, but that race is not
established as the cause of this particular incident. No source footage or private
filename/path is included in this report or committed evidence.

The Windows synthetic API benchmark also completed independently with the final
server code. A generated 180-second 1280x720/25 fps HEVC input reached ready in
17,955 ms. Five warm status reads took 2.38, 1.04, 0.92, 1.05 and 1.27 ms;
these are status timings, not video-frame timings. The 43,807,901-byte H.264/AAC
copy passed a full FFmpeg decode in 1,791 ms and three exact 100-byte HTTP 206
range checks. The source hash was unchanged. Removing the copy produced HTTP 404
and an original status as required. Video duration remained 180 seconds at a zero
origin; the converted stereo AAC stream was 180.000998 seconds versus the
synthetic source's 180-second mono AAC stream. `firstVisibleFrameMs` is explicitly
null in this API-only benchmark.

### Windows validation

The following completed checks used the final server implementation on Windows:

| Check | Result |
| --- | --- |
| Final 14-file browser selection, no retries | 133 passed, 1 failed, 0 skipped/flaky; 1,009.916 s; exit 1 |
| Final broader-run isolation prerequisites | 38 passed, 0 failed; 19.796 s |
| Focused direct-frame trial browser file, no retries | 39 passed, 0 failed; 131.044 s; 38/38 prerequisites |
| Instrumented 5,000-caption save diagnostic, once, no retries | 1 passed, 0 failed; 155.881 s; 38/38 prerequisites in 13.022 s |
| Earlier 14-file browser checkpoint, no retries | 117 passed, 1 setup failure, 6 did not run; 872.121 s |
| Measured manual-playback follow-up, once, no retries | 7 passed, 0 failed; 40.9 s |
| Isolation prerequisites for those two runs | 38/38 each; 27.869 s and 34.917 s |
| Focused startup/cache/native browser run, no retries | 6 passed, 0 failed; 145.307 s; 38/38 prerequisites |
| Three preview unit/API files, serial, including the direct-frame trial | 40 passed, 0 failed, 23.362 s |
| Media-clock unit tests | 8 passed, 0 failed, 0.445 s |
| Project deletion API | 11 passed, 0 failed, 18.113 s |
| Eight media-replacement files, serial | 118 passed, 1 existing Windows skip, 0 failed, 81.101 s |
| Appearance-save recovery API | 7 passed, 0 failed, 1.154 s |
| Final typecheck, build and explicit brand verification | All passed; existing large-bundle warning remains |
| Final staged public check | Passed: manifest, public services and 784 current files plus locally available refs/history; complete clone |

The existing skip is `probe output and active decoder cancellation are bounded and
release admission` in `tests/media-compatibility.test.mts`, explicitly excluded on
Windows. The new deletion barrier test controls an admitted preview worker before
encoding; it does not reproduce a native Windows file-sharing failure.

One earlier browser prerequisite run failed before Playwright: the native-download
guard exceeded 60 seconds and a separate API-health probe timed out. Temporary
phase instrumentation, subsequently removed byte-for-byte, measured a passing
single guard at 46.24 seconds, including 27.77 seconds to launch Chromium and
9.77 seconds awaiting the native download path. That establishes latency, not the
cause of the earlier timeout. A subsequent normal runner passed all 38 prerequisites
and both diagnostic cases with unchanged assertions/timeouts. The diagnostic spec
was removed after its metadata was captured; it is not part of the delivered suite.

The earlier broader run's sole failure was the manual-playback fixture's
`beforeAll`: 13,313.128 ms elapsed, with only `TimeoutError: The operation was
aborted due to timeout` retained. No page action or playback test body ran.
The trace cannot identify which of its three readiness endpoints timed out or
establish the underlying cause. Endpoint/phase diagnostics now retain timings,
HTTP status and identity-match booleans without URLs, paths, markers or bodies.
The one-second deadline, single request per endpoint, redirect rejection and all
ownership/schema checks are unchanged; the original error is still thrown.

One measured follow-up ran the seven affected cases successfully. Setup before
the probes took 1,571 ms; direct API, proxy API and frontend identity probes took
16, 13 and 4 ms, all with matching ownership, HTTP 200 and un-aborted signals.
That establishes subsequent successful validation, not a diagnosis or fix of
the earlier setup timeout. All 124 distinct browser cases passed at that product
checkpoint across the broader run and this follow-up; the broader command
still exited 1 and is not reported as an entirely green run.

The subsequent direct-frame trial passed the complete 39-case preview browser
file with no retries and all 38 isolation prerequisites. A request-registration
barrier was then added to its frozen-clock setup before the final broader run.
That 134-case selection passed all preview, conversion, reported CI, menu,
replacement and review-ownership cases, with one separate 5,000-caption save
observation failure described below. The command exited 1; it was not an entirely
green run. The transport comparisons above also retain their failed transport
verdicts separately from their successful playback assertions.
The first final typecheck found two overloaded `fs.lstat` test wrappers whose
inferred result widened to `Stats | BigIntStats`. Transparent Proxy wrappers now
preserve the target signature and forward all arguments/receiver; barriers and
assertions are unchanged. The 40-case suite and typecheck were rerun successfully.
No local build is release evidence.

The final broader run also exposed a separate 5,000-caption recovery/save timing
failure at `large-project-continuation.spec.mts:162`. Its retained synthetic trace
shows the explicit manual save submitted all restored values with matching
comparison bases and received HTTP 200. The roughly 992 KB response finished
6.66 seconds before the unchanged eight-second Saved assertion expired; a later
snapshot shows Saved, All changes saved, a disabled save action and a saved header.
That snapshot establishes Saved by its capture time; it does not timestamp the
first transition or rule out an earlier transition missed by the assertion.
There is no subsequent caption PUT. This is evidence of eventual successful
persistence, not a lost draft or an ignored click. The originally reported
failed-save alert case passed in this same run.

One bounded diagnostic then passed the full recovery/save/reload case with its
existing eight-second assertion, 120-second test budget and all data assertions
unchanged. Save click to actual PUT JSON completion took 1,394.5 ms; JSON completion
to the first observed Saved DOM state took 291.7 ms; click to Saved took 1,686.2 ms.
The Saved assertion completed in 1,510.6 ms. The two acknowledgement recovery
storage writes took 7.5 and 6.0 ms; those native-write timings exclude constructing
and validating the recovery payload.

The bounded 6.262-second CPU profile included 3.024 seconds in Playwright's
`captureSnapshot`/`visitNode` traversal subtree, verified against the installed
snapshotter source, 158.6 ms inclusive recovery work,
369.1 ms inclusive React work, 232.7 ms garbage collection and 1.945 seconds of
unattributed program time. Inclusive categories overlap and do not sum to the
total, and the profile includes work both before and after Saved. This passing
execution shows substantial snapshot work and much shorter
acknowledgement settlement, but does not prove what caused the earlier deadline
miss. The earlier failure remains unresolved as a timing observation; no save
semantics or assertion deadline was changed to hide it. Temporary instrumentation
was removed and the test restored byte-for-byte to the broader-run version.

The first diagnostic command completed all 38 prerequisites in 27.811 seconds but
matched no test with its initial title filter. The corrected filter selected the
single case above for its first actual instrumented execution; it was not a retry
of an executed failing diagnostic case.

Independent review covered immutable cache publication/read protection,
cancellation/deletion, client request/frame/operation ownership, the direct-frame
trial, the CI and replacement fixtures, and documentation/public-impact claims.
Additional independent analysis checked the failed save trace, measured save/CPU
metadata, original-file transport evidence and bounded NetLog interpretation.
These reviews do not turn the
failed broader run or unresolved transport cause into a passing release gate.

## Public impact

**Public impact: uncertain** for the external handoff because current HQ and
accepted public-representation evidence are unavailable. Source-owned impact is
known and required: source-only recovery workflow documentation in README,
PRODUCT and DESIGN, plus the local lease description in PRIVACY, are updated.
No new service, telemetry, dependency or cloud transfer. The accepted `.sthang/product-manifest.json` still
represents released 0.90.0; its release claim and approved artwork are unchanged.

Proposed separate maintainer follow-up: HQ Phase 3 intake with the new local
change ID and this source evidence, then Distribution Phase 2 synchronization.
Review HQ's Studio public representation corresponding to `proposal.publicClaims`
and the local-processing claim; retain current release/download fields until an
approved release exists. The known routes are website `/studio/` and docs
`/studio/`, including Distribution `docs/studio/index.md` playback troubleshooting.
The inspected Distribution checkout still pins older 0.86.0 evidence; that is not
evidence of the live website's state. No HQ checkout/current accepted export and
no exact plan-digest approvals were available, so cross-repository writes and
publication are not prepared or authorized. Product source documentation is
updated here without advertising this unmerged work as a released capability.
