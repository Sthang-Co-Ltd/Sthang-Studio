# PR 86 stale-save correction qualification

This receipt qualifies the local correction to PR #86. It is source evidence,
not release or deployment evidence.

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
all seven cases and all 32 isolation checks in a fresh complete browser run.

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
