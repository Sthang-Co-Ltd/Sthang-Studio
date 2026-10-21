# PR 86 stale-save correction qualification

This receipt records the accepted product correction and its subsequent browser
teardown correction. The original product qualification below is historical;
the final section records the follow-up against `4014876ff370324303af23b20d329d4f40aa303a`.
These are source checks, not release or deployment evidence.

## Source and scope

- Repository: `Sthang-Co-Ltd/Sthang-Studio`
- Branch: `codex/reject-stale-saves`
- Starting PR head used for qualification: `0cdcd4b1f05a71990ea2cc38d7f8bcc934a6851c`
- Reviewed and checked main/merge-base: `f4091082fc8c00e0d1645e3927a3acc5bd3c48fd`
- Target worktree was clean before this correction. The unrelated primary
  checkout paths were preserved.
- Qualification was performed against an uncommitted working-tree correction.
  This receipt records pre-publication verification; GitHub holds the current
  PR commit and publication status. No package, release or deployment was
  qualified by these checks.

## Root cause and correction

The batch server already validates and changes only targeted word timing and
approval fields. The client retained a local caption draft and merged those
targeted fields, then treated the complete returned project as acknowledged
caption-save evidence. An unrelated row saved by another editor entered that
evidence without reaching the local draft. A later ordinary save obtained the
new revision and successfully replaced that row with the stale local value.

Apply and undo now derive the expected acknowledgement from the prior caption
basis plus only the declared target timing/approval changes. A retained draft
gains full-list authority only when that expected caption list matches the
response, including row identities, order and unowned fields. A mismatch keeps
the accepted timing, newer input, frozen comparison basis and recovery actions;
ordinary full-list writes stop. A clean editor can adopt the entire response,
and same-client batches with newer typing remain saveable. Accuracy continues
to use its separate authority.

A subsequent review reproduced an additional target-local race: editing the
batch's own caption while its accepted response was held could skip the timing
merge and authorize a later full-list Save. The real isolated API then created
an extra manual-save History checkpoint and overwrote the accepted target.
Now a target whose local revision changed during apply/undo is kept for manual
comparison and cannot erase the persisted batch. Unrelated-row edits retain
their normal queued-save behavior.

Shared-caller review also found that Khmer-spacing and safe-timing cleanup
could admit foreign rows through a complete response. They now compare fresh
captions with acknowledged captions under the Appearance save barrier and
submit the checked revision. Both API guards run inside the project write lock
before History or mutation. Missing guards receive 428, malformed guards 400,
and stale guards 409 with `CAPTION_REVISION_CHANGED`.

Explicit History/grouping/regeneration publication semantics, regeneration
rejection, project/media checks, navigation cancellation, recovery freezing and
learning exclusions remain in place.

## Deterministic before/after evidence

The new browser suite uses two independent browser contexts, three synthetic
captions and an owned API with isolated disk persistence. Gates hold the actual
batch response after persistence and History, and hold a later ordinary
preflight to exercise queued saves. Caption 3 is edited while the batch response
is held. No timing sleep is used to arrange the race; browser autosave time is
advanced with Playwright's clock.

| Scenario | Reviewed head before correction | Corrected source |
| --- | --- | --- |
| Apply; A changes caption 2, B edits caption 3 during the response | Two ordinary PUTs return 200; disk caption 2 becomes `ORIGINAL SECOND CAPTION` | Zero ordinary PUTs; A's exact caption 2 and accepted c1 timing remain on disk; B's exact newer editable draft remains available |
| Undo; same foreign change and held response | Two ordinary PUTs return 200; disk caption 2 becomes `ORIGINAL SECOND CAPTION` | Zero ordinary PUTs; A's caption 2 and accepted c1 undo remain on disk; B's newer draft remains available |
| Apply with no foreign change | Passes: autosave then queued text-edit save | Passes: two 200s, exact accepted timing and newest caption 3, sequential acknowledged revision tokens |
| Undo with no foreign change | Passes: explicit Save then queued text-edit save | Passes: two 200s, exact accepted undo and newest caption 3, sequential acknowledged revision tokens |
| Apply with local edit to batch target while response held | Additional manual save creates a History entry and overwrites the accepted timing | The persisted batch and History remain unchanged; no ordinary PUT; exact local target text remains downloadable |
| Stale spacing cleanup | Real disk/History changed; assertion failed | No cleanup POST or caption PUT; exact disk/History and newer draft preserved |
| Stale timing cleanup | Browser fixture stopped at a caption hidden by Review; no browser defect claim from that attempt | No cleanup POST or caption PUT; exact disk/History and newer draft preserved |

The apply/undo cases also assert exact batch checkpoint contents, no subsequent
History changes on conflict, stopped autosave/manual retries, download contents,
and comparison-only recovery after reload. The existing stale-save browser suite
covers writes already queued before an ordinary-save conflict; the new positive
controls prove two real queued writes with the accepted batch incorporated.

Before product edits, the cleanup API suite independently reported six contract
failures and two passing valid controls: missing revisions and stale/queued
revisions incorrectly returned 200. The corrected focused run passes all eight.

The first browser setup attempt was blocked by the real missing-credential
Settings dialog. The fixture now dismisses that dialog. A separate timing-cleanup
fixture adjustment closes Review while the request remains held so all three
captions can be inspected. No original assertion, timeout or retry policy was
weakened.

## Commands and outcomes

Qualification uses Windows, Node v24.21.0 and npm 11.19.0. The repository's owned
browser harness runs its 32 isolation adversarial checks before Playwright.
Heavy browser suites run serially with one worker. Synthetic timing candidates
and a timing-capability flag avoid model or cloud calls; project reads/writes,
batch operations and History in the new suite use the real isolated API.

The commands below were executed from the correction worktree on
2026-10-21 (Asia/Bangkok), with the supported Node directory prepended to PATH.
Log redirections use the worktree's ignored
`data/working/pr86-word-batch-20261021/` directory.

| Command | Result |
| --- | --- |
| Focused command below | 114 passed; zero failures/errors/skips |
| New browser command below | 7 passed in 53.5s; 32 isolation guards passed |
| Existing browser command below | 160 passed in 6.3 minutes; 32 isolation guards passed |
| `npm run test:edit-recovery` | 71 passed, zero failures/skips |
| `npm run test:word-timing` | 103 passed, zero failures/skips |
| `npm run test:playback-grouping` | 45 passed, zero failures/skips |
| `npm run test:media-replacement` | 118 passed, zero failures, 1 existing Windows skip |
| `npm run test:public` | 16 passed, zero failures/skips |
| `npm run verify:brand` | Exit 0 |
| `npm run typecheck` | Exit 0, including protected brand verification |
| `npm run build` | Exit 0, including protected brand verification |
| `npm run check:public` | Exit 0; manifest/services verified, 496 current files and locally available refs/history scanned |
| `git diff --check` | Exit 0; final diff has no whitespace errors |

The skipped test is `probe output and active decoder cancellation are bounded
and release admission` in `tests/media-compatibility.test.mts`; its existing
`skip: process.platform === 'win32'` condition was not changed. Build reported
a non-fatal 518.76 kB minified main-chunk warning and plugin callback timing
diagnostics. Neither caused a check failure.

Focused revision/recovery/batch command:

```text
node --import tsx --test --test-reporter junit --test-reporter-destination data/working/pr86-word-batch-20261021/focused-first.xml tests/save-revision.test.ts tests/word-highlight-batch.test.ts tests/caption-word-batch.test.ts tests/caption-word-batch-api.test.mts tests/stale-save-api.test.mts tests/unfinished-edit-recovery.test.ts tests/unfinished-edit-recovery-api.test.mts tests/accuracy-context-draft.test.ts tests/caption-appearance-save.test.ts tests/media-audio-override-timing.test.mts
```

Browser commands used
`STHANG_BROWSER_EVIDENCE_ROOT=E:/Desktop Code & Script/Sthang-Studio/data/working/pr86-word-batch-20261021`:

```text
node scripts/run-browser-tests.mjs tests/browser/word-batch-save-conflicts.spec.mts --output ../../data/working/pr86-word-batch-20261021/after
node scripts/run-browser-tests.mjs tests/browser/stale-save-conflicts.spec.mts tests/browser/unfinished-edit-recovery.spec.mts tests/browser/word-highlight-batch.spec.mts tests/browser/word-highlights.spec.mts tests/browser/playback-grouping.spec.mts tests/browser/playback-grouping-disk.spec.mts tests/browser/preserve-media.spec.mts tests/browser/appearance-export.spec.mts tests/browser/activity-review.spec.mts --output ../../data/working/pr86-word-batch-20261021/regressions
```

Before product edits, these commands established the failures:

```text
node --import tsx --test --test-name-pattern 'normalize-khmer-spacing|postprocess-timing' --test-reporter junit --test-reporter-destination data/working/pr86-word-batch-20261021/cleanup-before.xml tests/stale-save-api.test.mts
node scripts/run-browser-tests.mjs tests/browser/word-batch-save-conflicts.spec.mts --output ../../data/working/pr86-word-batch-20261021/baseline
```

The cleanup command exited 1 with six expected contract failures and two passing
controls. The browser baseline exited 1 with the two foreign batch overwrites,
the spacing-cleanup disk change, and the timing-cleanup fixture failure; both
same-client controls passed. Each browser run passed the 32 isolation guards.
No timeout was increased, retry added, or original regression assertion removed.

After the initial qualification, the target-edit case was added. Once its
seventh project was made discoverable in the six-project Home launcher fixture,
the unchanged client produced an extra manual-save History checkpoint while
the accepted word-timing batch was still authoritative. After adding the
target-revision conflict guard, the targeted browser test passed, followed by
all seven cases and all 32 isolation checks in a fresh run of that disk-backed
suite. That run was not the complete repository browser suite. The subsequent
CI teardown failure and complete-suite requalification are recorded below.

## Independent review and final scope

Root reviewed the combined actual product diff, added tests and updated
callers. Bounded read-only reviewers separately checked publication/recovery
ownership, atomic server guards and existing assertions, and browser gates,
exact-state evidence and teardown. No new material issue remains from those
reviews. Reviewers did not run competing browser suites.

Changed product files:
`apps/web/src/App.tsx`, `apps/web/src/api.ts`,
`apps/web/src/save-revision.ts`, `apps/web/src/word-highlight-batch.ts`,
`apps/server/src/routes/projects.ts` and
`apps/server/src/services/project-processing.ts`.

Changed tests:
`tests/word-highlight-batch.test.ts`,
`tests/stale-save-api.test.mts`,
`tests/playback-grouping-server.test.mts`,
`tests/media-audio-override-timing.test.mts` and new
`tests/browser/word-batch-save-conflicts.spec.mts`.

Documentation:
`CHANGELOG.md`, `docs/STALE-SAVE-PUBLIC-IMPACT.md` and this receipt.

At qualification time the remote still reported the starting branch head and
main base listed above. No dependencies, lockfile, approved artwork, release manifest or
runtime-state representation changed. README and PRIVACY already describe the
source-only conflict/recovery behavior and existing local copy contents; this
correction requires no new transfer or retention disclosure.

## Evidence locations

Ignored local evidence under the main checkout:
`data/working/pr86-word-batch-20261021/`.

- `baseline/apply-foreign-before-after.json` and
  `baseline/undo-foreign-before-after.json` were extracted from the original
  failed trace archives without rerunning the baseline.
- `baseline/` retains the failing trace, screenshot and error context.
- `after/` contains one `word-batch-before-after.json` or
  `cleanup-preflight-before-after.json` per passing scenario.
- `regressions/` is the existing-browser output folder.

The correction worktree's ignored
`data/working/pr86-word-batch-20261021/` holds XML results and the current task
receipt. The older `data/working/stale-save-20261020/task_plan.md` is historical
qualification and is not evidence for this correction.
`qualified-source.json` records SHA-256 hashes of the final changed product and
test files so the qualified uncommitted source can be identified precisely.

## Limits and follow-up

- This qualification does not run real Gemini/KFA inference. It tests the save
  contract with synthetic candidates and real disk-backed publication.
- Full CI, native release packaging and cross-platform installation qualification
  are not claimed.
- Review identified a pre-existing conservative recovery edge: an unsaved,
  restored Accuracy-only draft can keep an older recovery caption basis after a
  successful same-client caption mutation and cause a later caption save to
  conflict. This is source review evidence, not a new browser reproduction or
  an overwrite bypass. It remains a separate follow-up; recovery freezing has
  not been relaxed.
- Public impact is required for source-only save/conflict and cleanup behavior.
  See `docs/STALE-SAVE-PUBLIC-IMPACT.md`. Accepted v0.86.0 release evidence is
  unchanged. HQ input and exact HQ/Distribution approvals remain unavailable.

## Browser teardown follow-up: 2026-10-21

### Source and retained CI evidence

The target worktree was clean on `codex/reject-stale-saves` at
`4014876ff370324303af23b20d329d4f40aa303a` before this follow-up. The fetched PR
head matched that commit, and both fetched main and merge-base were
`f4091082fc8c00e0d1645e3927a3acc5bd3c48fd`. The original unrelated changes in the
primary checkout were preserved. Qualification below applies to the local
uncommitted harness correction on that head, identified by the new
`qualified-source.json` receipt. Product code, dependencies, lockfile, artwork,
and all existing test-body assertions are unchanged by this follow-up.

The failing [CI job](https://github.com/Sthang-Co-Ltd/Sthang-Studio/actions/runs/39523364614/job/118972234311)
reported 255 passing browser tests, 4 failures and 24 not run. Its original
[artifact](https://github.com/Sthang-Co-Ltd/Sthang-Studio/actions/runs/39523364614/artifacts/12312464709),
job log and metadata were downloaded before the artifact's
`2026-10-26T01:00:59Z` expiry. The ZIP is 13,004,774 bytes and its SHA-256 matches
GitHub's metadata:
`ab7656d582bbcaafece73020ad569a26440d8f3de1fc4ae8309320ad9d7b823a`.
The original archive and extracted traces remain in the ignored evidence folder.

The target-edit test passed every test-body assertion, including the final
downloaded-text assertion at original line 598. The earliest terminal error was
`route.fulfill: Route is already handled!` in `owned-browser-routes.mts:45`.
The video-export preview POST was still being forwarded while the second
editor's page routes were removed. Its response arrived after page unrouting
and failed at fulfillment. The afterEach trace spans **330.254 ms**
(`765430.149` to `765760.403`); the later 30000 ms timeout label does not establish
an elapsed timeout. afterAll then reported a closed API request context, and
the following spacing, word-highlight-batch and word-highlights suites failed
before their bodies with `EADDRINUSE` on `127.0.0.1:45085`.

The route/harness helpers were unchanged from the earlier reviewed head. This
failure was investigated as a new demonstrated defect, not dismissed as a
known flake.

### Deterministic reproduction and correction

Both negative probes ran on the untouched reviewed head before tracked edits:

| Probe | Before correction | Corrected regression |
| --- | --- | --- |
| Held preview POST through a page fallback and context network guard | Navigate away, remove the page interceptor, begin context drain, then release the held HTTP response: exact already-handled fulfillment error, exit 1 | Close both pages with guards installed, begin context drain, then release the response: exactly one namespaced POST, one forwarded response and one disposal before context closure |
| Real isolated API owner disconnect | READY identified child PID 68648 on port 51184; Windows TCP ownership showed the same PID still listening after IPC disconnect; the bounded exit assertion failed, exit 1 | The child exits after owner disconnect; readiness becomes invalid and the same port can be rebound, while a separately owned listener and state sentinel remain intact |
| Cleanup failure | Existing per-test cleanup could stop at its first exception | All cleanup callbacks are attempted; multiple original errors retain their order; the exact API child's exit and port release are confirmed before cleanup failure is returned |

The original owner probe stopped only its exact child handle in `finally`,
confirmed exit and successfully rebound the port. No unrelated process was
killed. The CI artifact does not contain an OS listener-PID snapshot, so it
cannot establish the historical PID on port 45085. The local probe establishes
the real owned-child leak mechanism and actual reproduced listener owner; the
CI cascade is consistent with that mechanism.

The installed Playwright implementation and deterministic probe establish the
route race: a page handler can delegate forwarding to a context handler.
Removing the page interceptor can continue a route that the context handler is
still fetching. Its later fulfillment has lost ownership. Closing a context
too soon can instead dispose the request context under that fetch.

`closeOwnedBrowserContext` now closes every captured page while both route
guards remain installed, drains context handlers while `context.request` is
alive, drains the closed pages' handler bookkeeping, then closes the context.
Only the known interception-metadata update cancellation on a confirmed closed
page is ignored. Forwarding errors, already-handled errors and context-drain
errors remain failures. A page that fails to close retains its guard until the
final context-close attempt. Every cleanup step is attempted and real errors
are preserved.

`cleanupOwnedApiClients` runs all per-editor cleanup callbacks. If one fails,
it calls the existing exact-handle shutdown and waits for child exit before
reporting the failure. Successful per-test cleanup retains the API for the
suite. The API child also exits on owner IPC disconnect, registered before any
awaited application imports, so an abruptly retired Playwright worker cannot
leave that listener alive. Existing readiness identity, namespace, state-root,
environment and network restrictions remain intact.

The correction changes only:

- `tests/browser/owned-browser-routes.mts`, `owned-api-harness.mts` and
  `owned-api-child.mts`;
- imports and afterEach hooks in `word-batch-save-conflicts.spec.mts`,
  `stale-save-conflicts.spec.mts` and `playback-grouping-disk.spec.mts`;
- new `tests/browser-lifecycle.test.mts`, plus its serial invocation alongside
  the existing isolation checks in `scripts/run-browser-tests.mjs`;
- this qualification and the public-impact assessment.

The six new lifecycle tests cover the real gated Chromium route, three distinct
cleanup failures, real API owner loss, and multiple cleanup errors with
confirmed shutdown. They assert exact request counts and namespace, response
disposal order, preserved error identity, port rebind, independent-listener
survival and retained state. Successful cleanup has a positive control that
keeps the suite API alive. No existing timeout, retry, skip or assertion was
changed. A bounded independent reviewer read the helpers and tests; its finding
about cleanup if browser launch fails was fixed before final qualification.
The final review found no remaining material issue. Reviewers did not run
competing browser suites.

### Follow-up commands and outcomes

Commands run from the correction worktree on Windows with Node v24.21.0,
npm 11.19.0 and the installed Playwright 1.63.0. Browser runs use one worker;
the 32 original isolation checks and 6 new lifecycle checks run serially before
Playwright. Evidence and logs are retained even for failed attempts.

| Command or check | Follow-up result |
| --- | --- |
| `node --import tsx data/working/pr86-browser-teardown-20261021/reproduce-route.mts` | Before fix: exit 1, exact already-handled route failure |
| `node --import tsx data/working/pr86-browser-teardown-20261021/reproduce-owner.mts` | Before fix: exit 1, real API listener survives owner IPC disconnect |
| `node --import tsx --test tests/browser-lifecycle.test.mts` | Initial corrected lifecycle check: 6 passed, 0 failed |
| Focused browser command below, with the original nested runtime evidence root | 31 passed, 1 failed in 2.4 minutes; 38 guards passed. All 7 disk-backed cases passed. The failed case was native word-preview rendering, investigated below |
| Native-preview control below, with the shorter runtime root | 1 passed in 7.3 seconds; 38 guards passed; runner receipt exit 0 |
| Complete browser command below, with the shorter runtime root | 283 passed in 13.6 minutes; 38 guards passed; 0 failed, skipped or not run; runner receipt exit 0 |
| `npm run verify:brand` | Exit 0 |
| `npm run typecheck` | Exit 0, including protected brand verification |
| `npm run build` | Exit 0, including protected brand verification; existing main-chunk size warning, 518.84 kB |
| `npm run check:public` | Exit 0; manifest/services verified, 497 current files and locally available refs/history scanned |
| `git diff --check` | Exit 0 |

```text
node scripts/run-browser-tests.mjs tests/browser/word-batch-save-conflicts.spec.mts tests/browser/word-highlight-batch.spec.mts tests/browser/word-highlights.spec.mts --output data/working/pr86-browser-teardown-20261021/focused-browser
node scripts/run-browser-tests.mjs tests/browser/word-highlights.spec.mts -g 'native preview changes paint' --output data/working/pr86-browser-teardown-20261021/native-short-root
npm run test:browser -- --output data/working/pr86-browser-teardown-20261021/complete-browser
```

The focused failure occurred at `word-highlights.spec.mts:327`: the native
caption surface did not appear, and the UI reported that caption bounds could
not be safely checked. A controlled same-font/same-caption diagnostic identified
`fs.mkdtemp` returning `ENOENT` for the nested Windows caption-bounds path
(estimated 277 characters), before FFmpeg ran. The shorter owned runtime path
(214 characters for that diagnostic) passed and FFmpeg exited 0. The original
failed trace and exact filesystem error are retained. The preview control was
run only after that diagnosis, with no product or assertion changes.

The final runs use
`STHANG_BROWSER_EVIDENCE_ROOT=E:/Desktop Code & Script/Sthang-Studio/data/working/pr86-teardown`.
The source worktree and Playwright output locations were unchanged. PowerShell
5.1 reported the standalone native-preview control wrapper as exit 1 when
redirecting stderr warnings, but the saved `run-result.json` in
`studio-browser-owned-ICBLuS` records the actual runner exit 0 and the test log
records the pass. The complete-suite command explicitly propagates
`$LASTEXITCODE`; the successful control was not replayed to recover the shell.

The complete suite passed all seven disk-backed word-batch cases, the neighboring
word-highlight suites, and existing stale-save, recovery, Accuracy, regeneration,
grouping and media coverage. The previously failing target-edit case completed
in 9.5 seconds, including successful teardown; the subsequent suites reused the
owned API port without `EADDRINUSE`. The native-preview case that failed under
the long runtime root also passed in the complete run. No additional browser
attempt or changed assertion was needed.

The final lifecycle outcomes identify owner-disconnect child PID 64800 on port
54396, exiting 0 before successful rebind, and cleanup-error child PID 4632 on
port 54407, with confirmed SIGTERM exit before rebind. These are actual local
process identities, not inferred historical CI PIDs. They are retained in
`browser-lifecycle-15xxvW/outcomes.json` under the shorter evidence root.

The terminal continuation for the complete run later refused access with
`EXEC_CALLER_UNIDENTIFIED`, including the single suggested identity-recovery
retry. The suite was not restarted. Its retained log records all 283 passes,
`studio-browser-owned-RKgQUj/run-result.json` records exit 0, and Playwright's
`complete-browser/.last-run.json` records `passed` with an empty failed-test
list. The reported result comes from those completed receipts, not an assumed
terminal exit.

### Follow-up evidence and limits

Under the correction worktree's ignored
`data/working/pr86-browser-teardown-20261021/`:

- `ci-39523364614/` retains the original artifact ZIP, job log, metadata and
  extracted traces; `ci-analysis.json` records the assertion and hook chronology.
- `route-before.json` / `.log` and `owner-before.json` / `.log` retain both
  failing pre-edit probes and exact process/listener evidence.
- `focused-browser.log` and `focused-browser/` retain the 31/32 attempt and its
  failing trace; `native-path-diagnostic-detail.json` retains the controlled
  Windows filesystem diagnosis.
- `native-short-root.log`, `complete-browser.log` and their output directories
  retain the subsequent runs. The shorter main-checkout evidence root retains
  `browser-lifecycle-*/outcomes.json` and `studio-browser-owned-*/run-result.json`.
- `brand.log`, `typecheck.log`, `build.log`, `public.log`, `public-final.log` and
  `qualified-source.json` record final gates and source identity.

The complete browser suite qualifies local Windows execution; no new Ubuntu CI
run, real Gemini/KFA inference, native release package, deployment or release is
claimed. At the time of local qualification, no PR update or push had occurred;
the repository and GitHub PR history govern subsequent publication status.
Earlier product-unit outcomes above are historical and are not reported as
freshly rerun checks here. The known conservative Accuracy-recovery limitation
remains a separate follow-up.

Public impact: none for this harness-only correction. The underlying source-only
stale-save product change still requires its existing public-impact intake;
accepted release claims and the manifest remain unchanged. See
`docs/STALE-SAVE-PUBLIC-IMPACT.md`.
