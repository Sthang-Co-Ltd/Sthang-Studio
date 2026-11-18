# Preview reliability follow-up (source only)

This follow-up checks the remaining findings from
[the November 15 investigation](PREVIEW-RELIABILITY-20261115.md) at local commit
`71ca031e2112ba6d35a86b24c9bcd22e7ace627e`. It does not replace that report's
failed checkpoints or establish a public release. The original checkout and the
separate UX worktree are outside the write scope.

Follow-up status: the current browser regression gate passes. The original-file
HTTP anomaly remains reproducible, and the historical prepared-copy incident
cannot be retested without its exact artifact. That HTTP/save investigation did
not justify an additional product-code change; its earlier fixes remain at the
commit above. The later [deletion ordering follow-up](PREVIEW-DELETION-ORDERING-20261118.md)
records a separately reproduced product defect and its correction. Historical
verification and public-impact statements below describe this HTTP/save investigation.

## Large-project save observation

The previous 134-case browser run had one failure: the first 5,000-caption recovery
case did not observe Saved within eight seconds. Its HTTP 200 response and later
Saved snapshot prove eventual persistence, but do not timestamp the first Saved
transition. The original failed checkpoint remains valid historical evidence.

Three focused checks and the full browser selection now pass without changing
the test's eight-second Saved
assertion, 120-second case budget, 5,000 mounted native rows, caret/Khmer composition
checks, restored values, approval states or post-save reload checks:

| Check | Result |
| --- | --- |
| Original case, without diagnostic hooks | 1 passed; 38 isolation guards passed; 110.305 s total command |
| Instrumented copy, default DOM/network tracing retained | 1 passed; 38 guards passed; 111.890 s total command |
| Same 12-case prelude as the historical failure, then the instrumented case | 13 passed; 38 guards passed; 145.662 s total command |
| Original 14-file selection, without diagnostic hooks | 134 passed; 38 guards passed; 770.617 s total command |

All used one worker and zero retries. The prelude comprises seven caption-menu
viewport cases followed by five save-acknowledgement cases. Neither file creates
an unmanaged browser context or page; their owned-context cleanup and fixture
cleanup were inspected, with no demonstrated ownership leak.

The bounded diagnostic observes the application's actual `Response.json()`
consumption, the first Saved DOM mutation, the original assertion and a short CPU
profile. It does not clone/read the body independently or change returned promises.
Both runs completed their data and reload assertions.

| Phase | Standalone diagnostic | With original prelude |
| --- | --- | --- |
| Save click to caption PUT JSON completion | 1,036.5 ms | 1,012.2 ms |
| JSON completion to first observed Saved DOM | 192.9 ms | 196.0 ms |
| Save click to first observed Saved DOM | 1,229.4 ms | 1,208.2 ms |
| Original Saved assertion | 1,060.4 ms | 1,050.2 ms |

No scheduler gap overlapped either measured save window. These are synthetic
diagnostics on this Windows PC, not general performance or improvement claims.
The historical timeout has not reproduced in these conditions; no lost-save,
stale-label or deterministic acknowledgement bug was demonstrated.

The earlier CPU profile's snapshot cost was also checked against its event
timeline: approximately 2,204 ms of 2,815 ms of named snapshot self time occurred
after Saved. The larger aggregate snapshot figure cannot establish that tracing
caused the historical timeout. Default tracing remains intact. In installed
Playwright 1.63, disabling DOM snapshots also disables HAR/network capture;
per-action screen snapshots are separate from the default screencast and add
their own work. An evidence-equivalent trace optimization was not established,
so the proposed reduced-snapshot comparison was not run.

The diagnostic used an ignored copy and, for the prelude, a uniquely owned
temporary test file removed after the run. The original test remained byte-for-byte
unchanged, SHA-256
`1923ce095d43e4e7f2bdb3929e2b6c62fda6ae3ad87b6f4c5486437ca27de873`.
The initial spaced title filter selected no tests; its corrected invocation was
the first executed baseline case. The initial temporary ESM diagnostic config
failed to import the CommonJS-classified repository config; the corrected config
then ran the case once. Both setup-only failures and their passing guard results
are retained, not counted as executed product-test failures or retried cases.

## Original-video HTTP investigation

The installed Chrome 157 wrapper still reports `ERR_INVALID_HTTP_RESPONSE` while
the video plays. Playback success alone does not clear the transport verdict.
The two relay measurements use the production `SourceMedia` component, an immutable aliased
copy of local source media, and the exact `express.static(config.uploadDir)` route
inside an isolated wrapper. Both have no Playwright request interception, no compatible
preparation POST, no cloud client, and no external bundle imports. Wrapper CSP,
cache settings, shell and error handling differ from full Studio startup.

A local TCP relay observes bounded HTTP header structure in memory and forwards
the original buffers with normal backpressure. It persists counts, timing and
boolean/enum classifications. It does not persist raw wire/header/media bytes.
Before real footage, four synthetic checks passed: buffered normal-FIN draining,
HEAD/chunked message boundaries, malformed headers and an empty upstream reply.
The normal-FIN check verifies complete delivery of a 1 MiB synthetic body.

| Measurement | Instrumented server observer | Passive server observer |
| --- | --- | --- |
| Browser/CDP invalid responses (same failures, not added together) | 20 / 20 | 24 / 24 |
| Continuous video frames | 1,166 | 1,168 |
| First original frame | 2,686.3 ms | 537.4 ms |
| Forty-second playback and three paused seeks | Passed | Passed |
| Compatible-preparation POSTs | 0 | 0 |
| Source/copy/project preservation and cleanup | Passed | Passed |
| Strict transport verdict | Failed | Failed |
| Command duration | 59.923 s | 57.037 s |

The timing difference is not a speedup claim: these are individual runs with
different instrumentation and warm OS caches.

In the first relay run, all 182 original GETs matched exactly to their Express
request through private in-memory socket identity and request sequence. All 182
responses had valid HTTP/1 heads, valid 206 range framing, matching requested
start, consistent length/range, positive body bytes and headers queued to the
browser-facing socket. Two bodies completed; 180 were canceled/incomplete, with
180 server abort observations. There was no zero-reply or malformed upstream-head
case and no dropped per-request record. The saved connection-detail rows were
bounded to 96 of 182; the report explicitly records that truncation.

For each of the 20 failed CDP requests, restricting its range/time candidates to
requests that had started before the observed failure leaves one candidate.
Each had a valid head and 327,680–786,432 upstream body bytes; the server response
closed within roughly half a millisecond of the CDP failure. This is strong
temporal association, not authenticated CDP-to-socket identity. The original
wider time window included later same-range retries and correctly marked those
matches ambiguous. Node's socket byte count means queued bytes, not proof that
Chrome received or accepted them.

The passive comparison removes the response-method overrides and the extra
measurement response-ID header. It observes only request abort and response
finish/close, with status/header introspection. Unknown submitted-byte counts,
emission time and response errors are null. The same error persists, so those
overrides and that extra header are not necessary conditions for this failure.
No production serving change is justified by these observations alone.

A separate direct-Express Chrome receive capture was **inconclusive**. Its
analyzer first passed 21 synthetic cases covering valid and malformed prefixes,
missing payloads, ambiguous/shared socket ownership, incomplete connection/send
ordering, skipped events and capture-size uncertainty. Independent review checked
the direct route, bounded local capture and cleanup. Chrome's child-only temp
directory was confined to the owned capture tree because its network service can
create scratch chunks separately from the final log file.

The command exited 1 after 265.969 seconds at `sample-0-first-paused-frame`:
The `SourceMedia` wrapper started one automatic compatible-preparation request before the original
frame was observed. That violated this original-only experiment's zero-POST
precondition. It did not complete the paused observation, 40-second playback or
three seeks. Three original GETs were observed, one completed and two aborted;
no invalid-response event was observed before termination. The report's
`transportPassed: true` denotes that empty error count, not a passing transport
experiment, because the required workload did not complete.

The rolling NetLog retained 15,787,239 bytes and 429 events, near its requested
16 MiB limit. It contained no exact-alias request roots or dependency edges, so
there was no failed-request receive prefix to attribute. The analyzer correctly
reported capture coverage as insufficient. The largest observed capture-tree
size was 17,185,303 bytes, below the separate 64 MiB abort threshold. Raw capture
and its owned scratch tree were deleted before the structural report; source,
aliased copy and project preservation checks passed, with no external bundle
imports. This failed measurement provides no basis for changing production
serving behavior or disabling the bounded no-picture fallback.

The subsequent direct passive control removed the relay and byte capture while
retaining the original observer, component, static middleware and workload.
It presented its first original frame in 1,133.1 ms, then passed 40.036 seconds
of playback (1,116 frames, including 61 near 35 seconds) and all three paused
seeks. It used one media element, no Retry and zero preparation POSTs; source,
copy, project and cleanup checks passed. It still reported 20 invalid responses
among 176 original GETs, so the strict command exited 1 after 62.349 seconds.
The relay, response-method overrides and byte capture are therefore not necessary
conditions for the anomaly in this wrapper.

All those wrapper controls explicitly disabled Chrome HTTP caching and applied
`Cache-Control: private, no-store` to original media. Production
`apps/server/src/index.ts` serves `/media` with the default `express.static`
cache policy. A subsequent control removed both diagnostic overrides while
preserving the component, observer and workload. All 381 observed server response
heads and all 198 browser/CDP-observed heads had the default
`Cache-Control: public, max-age=0`. These observed-header counts do not establish
header acceptance on the failed request.

That control still recorded one invalid response among 199 CDP original GETs.
It passed 40.011 seconds of playback with 1,163 frames and all three paused seeks,
with zero preparation POSTs and all preservation/cleanup checks passing. Its first
original frame took 607.9 ms; the command exited 1 after 54.500 seconds. Forced
cache overrides are therefore not necessary for the anomaly in this wrapper.
Both cache conditions changed together, and each cohort is one run; the different
error counts do not establish a cause, a rate improvement or a production fix.
The wrapper remains narrower than full Studio startup.

Another single-variable comparison added `Connection: close` only to media
responses while retaining normal cache behavior. The header was observed on all
380 server responses, five regular browser/CDP response-header observations and
all 196 CDP ExtraInfo header observations. Those observations do not prove which
socket served the failed request or establish that Chrome accepted its headers.
The comparison still recorded one invalid response among 197 CDP original GETs.
It passed 40.011 seconds of playback with 1,176 frames and all three paused seeks,
with zero preparation POSTs and preservation/cleanup checks passing. The strict
command exited 1 after 50.416 seconds. Setting `Connection: close` did not eliminate
the anomaly in this wrapper, so no production connection-policy change was made.

### Component, server and observer controls

The next controls retain the aliased original file, passive response observation,
one fresh Chrome context, 40-second playback, three paused seeks, zero preparation
POSTs and source/copy/project preservation. Each ran once, serially. All completed
the playback, seeking, preservation and cleanup checks; transport remains a
separate strict verdict.

| Control | Invalid responses | Playback frames | Command duration | Strict transport |
| --- | --- | --- | --- | --- |
| Native video; default Express cache headers and browser cache | 0 | 1,179 | 50.088 s | Passed |
| Native video; private/no-store and explicit browser-cache disable | 23 | 1,179 | 50.166 s | Failed |
| SourceMedia; custom single-range server, private/no-store and browser-cache disable | 23 | 1,174 | 49.765 s | Failed |
| Native video; private/no-store and default browser cache | 24 | 1,179 | 50.986 s | Failed |
| Native video; private/no-store, default browser cache, no extra CDP session | 23 | 1,178 | 50.280 s | Failed |

Invalid-response counts are browser request failures; where a separate CDP
observer was present it reported the same failures, not additional failures.
The native controls bundle React and a plain video element, excluding SourceMedia
and its preview API inspection/recovery logic. They make no inspection GET.
The custom server handles only the owned alias and bounded single byte ranges
using a file stream; it differs from Express static handling in conditional-cache
metadata as well as implementation. The last control removes the independent
`Network.enable` session entirely, retaining Playwright's normal page network
events and passive server observation. It still requires observed original GETs
and a completed original 206 response, so absent observations cannot pass it.

These controls establish that SourceMedia, its startup inspection, Express's
static implementation, explicit browser-cache disabling and the extra CDP
observer are each unnecessary for this anomaly under the measured conditions.
They do not establish the underlying cause. The one clean native/default-cache
sample does not explain the earlier one-error SourceMedia/default-cache sample
or establish a production fix. The no-store override is diagnostic; production
original-file serving continues to use the default Express cache policy.

The control reports retain Chrome major version 157 only. A subsequent
synthetic-only NetExport UI preflight reported full version `157.0.8103.79`, while
the earlier November 15 capture reported `157.0.8103.78`. These records do not
establish an identical full browser binary across all cohorts.

A further control changed only the custom range server's emission timing: after
finalizing the GET status and range/content headers, it called `flushHeaders()`
before piping the file stream. This still recorded 12 invalid responses. It
completed 40.052 seconds of playback with 1,161 frames and all three paused seeks,
made zero preparation requests, and passed source, copy, project and cleanup
checks. The command exited 1 after 51.540 seconds because its strict transport
check failed. Explicit header flushing therefore did not eliminate the anomaly
in this control. The difference from the earlier control's count does not
establish a reliable improvement or justify a production serving change.

### Captured receive sequence

A bounded local reanalysis of the retained Default-mode NetLog found 16 failed
exact-alias request roots with a qualifying request/socket sequence. Each has one
captured fresh socket birth, successful connection to the owned loopback listener,
one request send and one positive 4,096-byte socket receive during the response
header-parser window. The receive is logged 2–14 ms after the parser begins and
in the same logged millisecond as its invalid-response failure. No accepted
response headers, earlier receives, reuse, EOF, read errors, shared request owner
or truncated dependency search were observed in those qualifying sequences.

Seventeen synthetic qualification checks passed before the raw local reanalysis;
only structural values were emitted. The reanalysis processed 125,381 events and
158 exact-alias request sources in 0.705 seconds. It establishes positive receipt
for these captured sequences, but Default mode does not provide the received
prefix. The byte count does not establish a header length, packet size or body
length, and overall capture completeness is not proven. Neither the server nor
the browser can be assigned fault from these counts alone.

The Everything-mode analyzer was then strengthened before a later capture. It
orders events by recorded time and file position, excludes bytes recorded after
the parser failure even within the same millisecond, requires a completed parser
failure and an explicit captured socket birth, and preserves illegal edge control
characters when checking header values. Both syntax checks and all 32 synthetic
cases passed, including the original 21 cases and 11 additional ordering,
socket-birth, phase and whitespace cases. Independent source review confirmed the
changes; the separate Default-mode reanalysis above was not modified. These
checks describe recorded order and local HTTP header rules, not exact physical
I/O order, proof of absent capture loss or Chromium's full parser semantics.

### Late receive-prefix capture

A subsequent supervised diagnostic started Chrome's official NetExport only
after the native video had presented its first original frame, remained paused
for 6.575 seconds and played for 20.086 seconds with 555 observed frames. It used
headed Chrome `157.0.8103.79`, private/no-store response headers, default browser
caching and no extra CDP session. Its first original frame took 15,008.6 ms. These
conditions differ from the earlier headless controls and do not support a speed
comparison.

The short capture stopped on the first new invalid-response observation after a
seek near 35 seconds. Eight warnings occurred before capture, one in the observed
capture window and none after stop. The trigger lasted 124.7 ms; the observed
active-UI-to-stop-click window was 212.7 ms. Those are observation boundaries,
not exact producer start/stop times. This is a prefix diagnostic, not another
40-second/three-seek regression pass.

The finalized local log was 8,377,862 bytes, below the analyzer's 15 MiB
near-limit threshold. It retained 440 events, two exact-alias request roots and
one qualifying parser failure. That failure has one captured fresh socket birth,
one successful connection to the owned listener, one request send and one
4,096-byte receive, with no accepted response headers, observed reuse, shared
request ownership, missing byte payload or truncated dependency traversal.

The received prefix does not start with `HTTP/1.`, has no valid status line or
complete CRLF header block, and contains a NUL byte. The analyzer therefore
classifies it as **incomplete or nonstandard header data received**. It does not
classify it as a complete malformed header block or identify those bytes as video
content. The captured sequence is attributable within the NetLog graph; it is not
an authenticated identity join to the first Playwright failure, and overall log
completeness is still not proven.

The command exited 0 after 143.227 seconds because usable diagnostic evidence was
obtained. Its clean-transport verdict is explicitly null. All POST and inspection
counts were zero; source, aliased copy and project preservation passed. The
browser was verified closed before local analysis, and the entire owned raw-log,
profile/temp and application-state trees were removed before structural output.
No raw headers, received bytes or source filenames were retained in that output.

### Source-byte and connection association attempt

The local analyzer gained an optional source comparison and exact connection
association. It verifies the aliased source's identity and SHA before comparing
at most 4,096 received bytes with the requested offset and a bounded nearby
window. A server association requires matching captured IPv4 endpoints, a unique
connection and first request, and the same single byte range. Constructed response
headers are reported separately from evidence of bytes sent on the connection.
All 48 synthetic cases passed, including the earlier 32 cases. No source bytes,
endpoints, raw headers or filenames appear in the structural output.

The subsequent body-comparison capture exited 2 after 67.920 seconds because its
conservative private-tree growth guard stopped it before a new warning was
recorded. The native video had passed its pre-capture checks with 20.124 seconds
of playback and 586 frames; four invalid responses occurred before capture and
none during it. The trigger lasted 389.3 ms. The owned private tree grew by
16,525,630 bytes, exceeding the 12 MiB proactive threshold; that tree includes
Chrome profile and temporary data as well as the log. Its recorded growth does
not identify which files grew or establish log rotation. The final observed log
was only 437 bytes, and the analyzer and source comparison did not run.

Source, copy and project preservation and complete cleanup passed, with zero
preparation or inspection requests. This attempt is **inconclusive**, with neither
a transport pass nor a body-match result. Review also found that the helper waited
for the Stop button click without explicitly waiting for Chrome's completed-log
UI state before closing the browser. That lifecycle gap prevents a conclusion
about why this attempt left a small log; it does not invalidate the earlier
successfully parsed receive-prefix capture.

### Finalized bounded capture

A separate helper corrected the lifecycle gap: it records the Stop click, waits
for Chrome's completed-log UI, validates the owned JSON while Chrome is still
open, then closes the browser before detailed analysis. Raw-file and whole-tree
limits remain active during the bounded completion wait. The analyzer gained an
explicit 64 MiB capture preset with a 60 MiB near-limit rejection; its existing
16 MiB preset and 15 MiB rejection remain the default. Neither preset changes
the 64 MiB absolute file bound, graph qualifications or source comparison limits.

The connection join was also corrected to reject reuse of the target endpoint
tuple without rejecting a unique target merely because another valid, unrelated
tuple was reused. Target ambiguity, malformed endpoints, duplicate record IDs
and truncated evidence still refuse qualification. All 57 synthetic cases passed,
including the earlier 48 cases and additional preset, boundary and endpoint cases.
Root and an independent GPT-6.1 SOL reviewer checked the final helper before its
single supervised execution.

That command exited 2 after 54.418 seconds. Pre-capture playback passed with
20.047 seconds and 578 frames. Five invalid responses occurred before capture;
none occurred during the observed capture window or after stop. The trigger ran
for 791.4 ms before the private-tree growth guard requested stop, within its
two-second maximum. Chrome's completed-log state was observed 163.5 ms after the
Stop click, and valid Everything-mode JSON was confirmed on the first attempt in
263.5 ms before browser closure. This verifies the corrected finalization path.

The resulting raw file was 66,473,197 bytes: below the 64 MiB absolute maximum,
but above the 60 MiB near-limit guard. The owned tree's observed growth was
65,803,933 bytes, above its 48 MiB proactive threshold; its 82,244,245-byte peak
stayed below the 128 MiB whole-tree hard limit. These are observed bounds, not
proof of a hard real-time ceiling or complete log retention. The detailed analyzer
and source-body comparison correctly did not run. The result remains
**inconclusive**, with no body-match, endpoint-join or clean-transport verdict.
All POST and inspection counts were zero. Source, copy and project preservation
passed, and the complete owned raw/profile/temp and application-state trees were
removed before structural output.

The transport cause remains unresolved. The received prefix is known to lack the
expected header structure in one qualifying failure. The remaining gap is to
identify those bytes and associate that browser socket with the server's specific
request and response evidence. The diagnostic strict failures remain recorded;
passing playback does not clear them.

## Historical prepared-copy incident

The earlier project inventory contained four available source projects and one
10,920,413-byte compatible copy. An expanded read-only inventory then searched
the Studio checkout, its worktrees and the approved uploaded folder, including
ignored working data and preview-cache directories. The first scan checked MP4
files; a subsequent extension-independent scan checked all regular files. That
second scan visited 16,406 directories, examined 38,524 regular-file entries and
found 28 MP4 files. No file had the exact historical 3,789,112-byte length, so no
candidate required a hash comparison with
SHA-256
`0fefbc12ef87ff92d67a8e6e16e41866569d8dd541c05fce947b13f13c1ab090`.
The scan skipped 352 dependency/model/cache forests and did not follow links;
it reported no read errors or exhausted budgets. The extension-independent command
completed in 174.402 seconds. It did not unpack archives or search locations outside
those approved roots. This is a scoped unsuccessful recovery search, not proof of
whole-computer absence.

The earlier decode failure at 35.033491 seconds remains unreproduced against that
exact artifact. Success of an original file or a different compatible copy does
not repair or disprove that historical failure.

## Open items and required evidence

| Item | Current finding | Evidence needed to close it |
| --- | --- | --- |
| Original-video HTTP warning | Reproduces in isolated controls; one qualifying browser receive lacks an HTTP/1 header prefix. Playback passes, but the cause and received-byte identity remain unresolved. | A failed connection's first received bytes associated with a unique server connection/request, retained below the capture limit, followed by a causal control supporting any proposed serving change. |
| Historical prepared-copy decode failure | The exact 3,789,112-byte artifact was not recovered in the bounded approved-folder search. | Restore the artifact with the recorded SHA and retest decoding near 35.033491 seconds. |

## Verification and public impact

The original 14-file, 134-case browser selection passed in one run without diagnostic
hooks: 134 passed, zero failed, skipped or flaky, one worker and zero retries.
All 38 isolation prerequisites passed in 12.649 seconds. Playwright's selection
took 746.076 seconds; the complete command, including prerequisites and the shared
build, took 770.617 seconds. The first 5,000-row case passed in 85.405 seconds.
Every case executed exactly once. This is a current passing regression gate;
it does not establish the cause of the earlier timing failure.

Current `npm run typecheck`, `npm run build` and explicit `npm run verify:brand`
all passed. The production build retains its existing bundle-size warning.
These checks validate the source branch; they are not public-release evidence.

`npm run check:public` also passed in 17.629 seconds: manifest and product-service
verification passed, and the public-readiness guard scanned 785 current files
plus locally available Git refs/history. This is the guard's local scope, not a
remote-service or public-release verification.

After the additional diagnostic documentation, the same public-readiness command
passed again in 12.315 seconds with 785 current files and available local history
in scope. Product source, configuration, dependencies and protected brand assets
have not changed since the passing typecheck, build and browser regression gates.

Independent GPT-6.1 SOL review of the documentation at commit `91a8ca9` found no
factual corrections needed. It checked the measured outcomes, unchanged assertions,
transport limitations and public-impact assessment. No production serving change
has been justified by the completed observations.

An independent GPT-6.1 SOL review of the final follow-up diff and safe structural
evidence also found no material factual corrections. It checked the new controls,
all three late captures, diagnostic qualifications, recovery-search scope and
open-items table, and confirmed the public-impact assessment below. The two
technical findings remain open; the review clears the documentation for a local
commit.

**Public impact: none** for this documentation-only follow-up. It adds no product
behavior, service, telemetry, dependency, cloud transfer or release claim. The
accepted `.sthang/product-manifest.json` remains the 0.90.0 release evidence.

**Public impact: uncertain** for the earlier preview branch's external handoff.
Its source-owned workflow/privacy changes are documented in `README.md`,
`PRODUCT.md`, `DESIGN.md` and `PRIVACY.md`, but current HQ accepted representation
is unavailable. The proposed separate maintainer follow-up remains HQ Phase 3
intake for `proposal.publicClaims` and the local-processing claim, followed by
Distribution Phase 2 review of website/docs `/studio/`, including
`docs/studio/index.md`. Current accepted HQ evidence and exact plan-digest approvals
are still missing. The previously inspected Distribution checkout's older 0.86.0
evidence does not establish the live website's state. This local verification and
documentation commit do not establish a release, deployment or publication.
