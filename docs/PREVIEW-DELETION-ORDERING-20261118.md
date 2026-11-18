# Preview reader drain before project deletion (source only)

The regression was reproduced against PR #118 at
`0a5d81cab6980903301c419b5786aca1fed9ec2b`. This follow-up corrects that deletion
ordering and preserves the earlier preview
reliability changes and their unresolved investigation results. This is development
source evidence, not a released-package or deployment claim.

## Reproduced failure

The project DELETE route cancelled an active preview preparation, removed the
saved project record and original source, then invalidated the project's caches.
Preview invalidation has a separate three-second reader drain. A cached status
GET retains a preview-file reader while validating metadata, and that metadata
operation has no HTTP-response abort callback.

A synthetic loopback API regression held the exact cached-file `lstat` beyond
the real drain deadline. Against unchanged product code, DELETE returned 500
after 3,085.827 ms. The project record and original source were gone, while the
preview, history and other cache remained. A second DELETE returned 404, leaving
those children outside the normal deletion path. The regression failed as expected.

The test uses a preview pointer whose signature matches the original file's
identity and matching synthetic bytes; metadata validation needs no decoder. It mocks only the
target filesystem operation, not deletion, invalidation, admission or the clock.
All state is disposable test-owned data.

## Correction and boundaries

Deletion now owns preview admission before cancelling/awaiting preparation and
draining readers. It enters durable project/source removal only after that drain
succeeds, and retains admission through all existing cleanup. Nested cache
invalidation owns a separate reference to the same fence, so its completion cannot
reopen the outer deletion's admission.

Status reads, preparation admission and file acquisition register ownership before
their first asynchronous source-identity or pointer read. The drain therefore
also counts accesses that have not yet pinned a preview filename, including an
already-running source inspection. An operation that cannot finish within the
existing drain deadline causes a 409 response before durable deletion. Ownership
is released when the pending access settles, and a failed deletion releases its
admission so the user can retry.

Published preview and project-cache invalidation remain after the project's existing persistence checks.
Moving destructive invalidation ahead of those checks would violate the existing
migration and store-failure safeguards. The immutable generation filenames,
publication commit, lease renewal, byte ranges and HTTP finish/close/error release
behavior remain unchanged. Active preparation is still aborted and awaited,
and may clean up its own unfinished staging files.
Media replacement retains its existing invalidate-before-publication ordering
and unpublished-failure cleanup.

This guarantee applies to preview-drain refusal. A later project-index,
source-unlink or other filesystem failure is not rolled back by this fence. Raw
original-file HTTP streams and normalization workers are not made part of a new
general storage transaction. The existing store can remove a record before an
index-publication failure; its separate tests require later media/history/cache
cleanup to stop. No crash/power-loss atomicity is claimed.

## Verification

| Check | Result |
| --- | --- |
| Original held cached-metadata reader against unchanged product code | 1 failed as expected; DELETE 500 after 3,085.827 ms, project/source absent, retry 404 |
| Same focused regression after repair | 1 passed; drain refusal preserves project/source and retry succeeds |
| Full deletion API file | 16 passed, zero failed/skipped; 24.704 s total command |
| Preview, playback client, project-store/storage/recheck and job-admission neighbors | 100 passed, zero failed/skipped; 33.354 s total command |
| Eight media replacement files, serial | 118 passed, zero failed, one existing Windows skip; 49.465 s total command |
| Brand verification, typecheck and build | Passed; existing bundle-size warning remains |
| Public-repository check after fetching refs | Passed: manifest/services and 786 current files plus locally available Git refs/history; complete clone |

CI results for the pushed head are recorded separately in PR #118. The local
checks above do not stand in for that run or establish a public release.

The deletion API file includes the real three-second deadline at cached-file
metadata, cached-pointer and source-identity boundaries. Each compares the exact
project, source, order index, preview pointer/bytes, history and cache before retry.
The held status request then returns the preserved ready copy, and the next
DELETE completes with 204 and removes its owned data.

Additional barriers pause record removal while the project is still discoverable.
New status/file GET/HEAD, preparation, duplicate deletion and media replacement
requests cannot enter the deletion. The rejected replacement removes only its
uploaded temporary file. Checks after nested preview invalidation prove the outer
fence still rejects stale captured project handles. Injected record-removal failure
preserves the original data and releases both admission gates for a successful
retry. Existing preparation cancellation/failure, missing/corrupt-source and
migration/store-failure cases also pass.

Neighboring tests retain native immutable-generation, old/new byte-range, lease,
eviction, in-flight Range-close and late-publication cancellation checks. Local
execution uses Node 24.21.0 on Windows; the preview/native-media neighbors use the
previously checksum-verified FFmpeg/FFprobe 9.0.1 runtime. These controlled fixtures
do not prove the behavior of every damaged filesystem or native file-sharing state.
The existing Windows skip covers bounded probe output and active decoder
cancellation in `media-compatibility.test.mts`. Independent lifecycle review and
a separate GPT-6.1 SOL/xhigh review found no material blocker in the repair.

## Public impact

**Public impact: required** for the source-owned deletion/retry description and
evidence. `README.md` and `PRIVACY.md` now state the narrow preservation behavior,
and the earlier investigation reports link here without overwriting their history.
No service, telemetry, cloud transfer, dependency, installation requirement or
identity asset changes. The accepted `.sthang/product-manifest.json` continues to
represent verified v0.90.0 release evidence.

**Public impact: uncertain** for the external HQ/Distribution handoff. Proposed
intake change ID: `studio-preview-deletion-ordering-20261118`. The affected
representation is Studio's local-processing/deletion and retry limitation in HQ
`proposal.publicClaims`, followed by Distribution's `/studio/` website/docs and
`docs/studio/index.md`. Current accepted HQ representation and the exact plan-digest
and approval-class decisions are unavailable. Those are required before the
separate HQ intake and Distribution synchronization; no cross-repository write,
release or deployment is part of this repair.
