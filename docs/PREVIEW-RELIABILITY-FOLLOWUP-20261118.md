# Preview reliability follow-up (source only)

This follow-up checks the remaining findings from
[the November 15 investigation](PREVIEW-RELIABILITY-20261115.md) at local commit
`71ca031e2112ba6d35a86b24c9bcd22e7ace627e`. It does not replace that report's
failed checkpoints or establish a public release. The original checkout and the
separate UX worktree are outside the write scope.

Follow-up status: the current browser regression gate passes. The original-file
HTTP anomaly remains reproducible, and the historical prepared-copy incident
cannot be retested without its exact artifact. No additional product-code change
was justified by this follow-up; the earlier fixes remain at the commit above.

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

A final single-variable comparison added `Connection: close` only to media
responses while retaining normal cache behavior. The header was observed on all
380 server responses, five regular browser/CDP response-header observations and
all 196 CDP ExtraInfo header observations. Those observations do not prove which
socket served the failed request or establish that Chrome accepted its headers.
The comparison still recorded one invalid response among 197 CDP original GETs.
It passed 40.011 seconds of playback with 1,176 frames and all three paused seeks,
with zero preparation POSTs and preservation/cleanup checks passing. The strict
command exited 1 after 50.416 seconds. Setting `Connection: close` did not eliminate
the anomaly in this wrapper, so no production connection-policy change was made.

The transport cause remains unresolved. The useful next evidence would tie a
failed browser request to its received HTTP prefix and complete request/socket
lifetime; the inconclusive capture above did not provide that. A passing playback
check, a valid upstream response or another isolated clean sample would not supply
that missing attribution. The diagnostic strict failures remain recorded.

## Historical prepared-copy incident

The local inventory still contains four available source projects and one
10,920,413-byte compatible copy. It does not contain the exact historical
3,789,112-byte copy with SHA-256
`0fefbc12ef87ff92d67a8e6e16e41866569d8dd541c05fce947b13f13c1ab090`.
The earlier decode failure at 35.033491 seconds remains unreproduced against that
exact artifact. Success of an original file or a different compatible copy does
not repair or disprove that historical failure.

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

Independent GPT-6.1 SOL review found no factual corrections needed in the two
documentation changes. It checked the measured outcomes, unchanged assertions,
transport limitations and public-impact assessment. No production serving change
has been justified by the completed observations.

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
