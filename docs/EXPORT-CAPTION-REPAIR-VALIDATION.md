# Export caption repair: validation

## PR #88 review corrections — 2026-10-21

The follow-up started from a clean `codex/export-caption-repair` worktree at
`111c8382a08942a4fd5bc86624320bf671b6b6ac`. The fetched PR head matched that commit;
its `main` base was `ff996a9216a717ef24c7ed22afe84b82c2d79cf4`. The unrelated
untracked files in the main checkout were preserved. The corrections affect ten
tracked files within the task worktree at
`/sthang-studio/.sthang-worktrees/export-caption-repair-20261021`; commands below
run there unless the unchanged-main comparison says otherwise. The final review
confirmed the original PR head/base and open PR before the follow-up publication.

### Defects and regression-first evidence

- **Bundle validation:** the kit adds both word-SRT and word-VTT when every caption
  is ready, but preflight previously checked only whole-caption cues. The supplied
  `Hello\nworld` fixture is ready and has valid ordinary SRT; its first word cue
  ends in a newline that the existing word serializers reject. The new checker
  uses the same readiness condition, word-piece extraction, rounding and blank-line
  validation for those included files. The blocker identifies the exact caption.
  Missing readiness still omits both files; no text, timing or word evidence changes.
- **ASS prerequisite errors:** appearance load/save failures disabled ASS and
  layout checking while their explanation was rendered only for video. The shared
  checks now expose the reason, a keyboard-accessible load retry or the existing
  Appearance save-retry path, and a pending status. ASS stays blocked until a
  matching project/media appearance is verified. Plain SRT remains independent.

Before the fixes, with Node 24.21.0:

```text
node --import tsx --test tests/export-checks.test.ts tests/caption-handoff.test.mts
node scripts/run-browser-tests.mjs tests/browser/export-caption-repair.spec.mts --grep "ASS explains"
```

The unit/service pair had **19 passes and 2 expected failures** at the new bundle
preflight assertions. Both new browser cases failed because the appearance alert
was absent in ASS mode; all **38 isolation/lifecycle guards passed**.

### Combined-source qualification

The qualified source uses Windows and Node **24.21.0**. The original PR head's passing
CI and the earlier results below are historical evidence; qualification of these
review corrections is recorded separately here. All new browser cases use synthetic projects and the
owned-run isolation wrapper; no live project or normal application service is used.

| Command | Follow-up result |
| --- | --- |
| `npm run test:export-checks` | 16 passed |
| `npm run test:caption-handoff` | 33 passed |
| `npm run typecheck` | Passed after the last product/test refinement |
| `npm run build` | Passed after the last product/test refinement; existing large-chunk warning remains non-fatal |
| `npm run verify:brand` | Passed; protected artwork unchanged |
| `npm run check:public` | Passed; manifest, services and 516 current files plus fetched locally available history |
| Focused browser command below | 43 passed, no retries or skips; all 38 isolation/lifecycle guards passed |
| Complete browser command below | **307 passed, 1 failed** in 14.9 minutes; exit 1, no retries or skips, all 38 isolation/lifecycle guards passed; teardown failure detailed below |

The final focused and complete runs use the same source, one browser worker, the
existing timeouts and zero configured retries. Their commands are:

```powershell
$env:PATH = (Resolve-Path '../../.codex-tmp/word-highlight-phase1-validate/node-v24.21.0-win-x64').Path + ';' + $env:PATH
$env:STHANG_BROWSER_EVIDENCE_ROOT = (Resolve-Path '../../data/working/exp88-browser').Path
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = 'data/working/export-caption-repair-20261021/review-fixes-focused-final.json'
npm run test:browser -- tests/browser/export-caption-repair.spec.mts tests/browser/appearance-export.spec.mts tests/browser/caption-handoff.spec.mts --reporter=list,json
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = 'data/working/export-caption-repair-20261021/review-fixes-full-browser.json'
npm run test:browser -- --reporter=list,json
```

Five added browser cases verify appearance-load failure and keyboard/mobile retry,
failed-save recovery with the exact edited 90px appearance, delayed failure and
success from another project, and a response for changed media. Both styled
controls stay disabled while a matching read/save is pending; SRT stays enabled.
Every held appearance GET has its own completion and is drained before teardown.
Desktop and 390px mobile error/recovery captures were inspected; the explanation
and labeled recovery control remain readable, with no horizontal overflow and a
44px mobile target.

The first combined focused browser attempt had **40 passes and 3 failures**.
The new save-retry test intercepted the wrong route and timed out; its interceptor
was corrected to the existing `/api/video-export/:id/appearance` endpoint, retaining
all assertions. Two existing native preview cases reported unmeasurable bounds
before Export opened. The retained run used a deeply nested evidence root. A
controlled native comparison confirmed an environment path-length failure:
identical synthetic ASS bytes, deep staged Khmer font directory, 640x360 geometry
and FFmpeg 8.1.1 succeeded at ASS paths of 248 and 259 characters but failed at
260 and 264 with `ass_read_file: fopen failed` and exit -22. Node verified that
every input file existed. The original browser scratch path would reach about
280 characters. Actual bounds checks likewise failed at a 296-character ASS path
and passed at 177. Both previously failing browser cases passed after selecting
the short, still isolated evidence root above. Native code and safety guards were
not changed, and no symlink/junction or preview fallback was used.

The first failed focused report and traces are retained under ignored
`data/working/export-caption-repair-20261021/review-fixes-focused-first*`.
The path diagnosis is retained under
`data/working/export-caption-repair-20261021/native-env/`:

```text
node --import tsx data/working/export-caption-repair-20261021/native-env/diagnose-native-path.mts data/working/export-caption-repair-20261021/native-env/deep/studio-browser-owned-ABCDEF/mock-state-ABCDEF data/working/export-caption-repair-20261021/native-env/reports/deep.json
node --import tsx data/working/export-caption-repair-20261021/native-env/diagnose-native-path.mts ../../data/working/native-env-short/state data/working/export-caption-repair-20261021/native-env/reports/short.json
node --import tsx data/working/export-caption-repair-20261021/native-env/check-ass-length.mts
```

No test was skipped, assertion removed, timeout increased or retry added.

### Complete browser run: remaining qualification failure

The complete run executed all **308** cases once. Its JSON report records 307
expected passes, one unexpected failure, zero skipped/flaky tests, zero retry
attempts and no global runner errors. The suite is **not green**.

The failure is the existing `native-preview-continuous.spec.mts:326` dense-word
case. Its trace shows all test-body assertions completing successfully, including
native paint correspondence, paused/backward-seek images, bounded batches,
unchanged captions and no caption writes. During After Hooks it reports
`apiResponse.dispose: Target page, context or browser has been closed` from
`tests/browser/owned-browser-routes.mts:46`; subsequent context-closure errors
belong to the same failed case.

The trace records page-route removal while the page is still active, a late
preview callback, context forwarding, and attempts to fulfill/abort an already
handled route. The final snapshot also contains a preview 404. A route-lifecycle
race is supported by this ordering, but the 404's exact cause is not proven.
The native preview test, fixtures, route helper, preview component and scheduler
match the reviewed main base. No guard or routing error has been suppressed.

The full JSON and copied failure traces are retained under ignored
`data/working/export-caption-repair-20261021/review-fixes-full-browser.json` and
`review-fixes-full-artifacts/`. An independent read-only diagnostic confirmed the
trace findings. Its compact extraction is
`data/working/export-caption-repair-20261021/native-preview-test130-trace-evidence.md`,
produced by:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File data\working\export-caption-repair-20261021\native-preview-test130-extract.ps1
```

After the full run ended, the same two existing tests (the preceding continuous
playback case at line 279 and dense-word case at line 326) ran in their original
order on main at `ff996a9216a717ef24c7ed22afe84b82c2d79cf4`, with no tracked changes.
Both passed, all 38 isolation/lifecycle guards passed, and the command exited 0.
The JSON confirms exactly two cases, zero skips, zero retries and no global
errors. This bounded comparison **did not reproduce** the full-suite teardown
failure. It neither establishes a pre-existing failure nor attributes the failure
to these fixes. The complete-suite qualification remains non-green.

The first comparison invocation used `npm run test:browser` with a separate
`--grep` argument. Windows/npm altered the regex quoting and selected **zero**
tests (`No tests found`, exit 1). Its JSON is retained separately; this is a command
setup failure, not a product-test result. The corrected invocation used the same
owned-run wrapper directly and passed the filter as one argument. From the main
checkout `/sthang-studio`:

```powershell
$env:PATH = (Resolve-Path '.codex-tmp/word-highlight-phase1-validate/node-v24.21.0-win-x64').Path + ';' + $env:PATH
$env:STHANG_BROWSER_EVIDENCE_ROOT = Join-Path (Get-Location).Path 'data\working\exp88-baseline-native'
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = Join-Path $env:STHANG_BROWSER_EVIDENCE_ROOT 'native-preview-baseline-first-two.json'
npm run test:browser -- tests/browser/native-preview-continuous.spec.mts --grep 'continuous native playback after opening preparation|dense words with slower native responses recover' --workers=1 --retries=0 --reporter=list,json
$env:PLAYWRIGHT_JSON_OUTPUT_NAME = Join-Path $env:STHANG_BROWSER_EVIDENCE_ROOT 'native-preview-baseline-first-two-corrected.json'
node scripts/run-browser-tests.mjs tests/browser/native-preview-continuous.spec.mts '--grep=continuous native playback after opening preparation|dense words with slower native responses recover' --workers=1 --retries=0 --reporter=list,json
```

The first invocation completed the shared-package build and all 38 guards before
test selection failed. Neither invocation changed assertions, timeouts, native
implementation or tracked baseline files. No second complete suite was run.

### Source identity and independent review

The seven changed product/test files below identify the qualified
source on top of `111c8382a08942a4fd5bc86624320bf671b6b6ac`. SHA-256 values use
exact local file bytes. The aggregate hashes UTF-8 lines of
`<file SHA-256><two spaces><relative path><LF>` in the listed lexical order:
`879c41490ecfa13a6458f5f3340885d824044903717c07d54266692c5adfcd2f`.

| File | SHA-256 |
| --- | --- |
| `apps/web/src/components/ExportChecksPanel.tsx` | `94d71d8487de4bf03776c3e0ad81d1746d73c892ab13148effc431882d1731a1` |
| `apps/web/src/components/ExportWorkspace.tsx` | `907b02f8f028aee2aa8847a53016e8861da0f1e937924dbc392f6d83320d6c4f` |
| `apps/web/src/components/export-checks.css` | `b4d15bf8003fe42ba8a1e8129f532bd6cacd19fb926b3791b37bd39a74dc4517` |
| `packages/shared/src/caption-interchange.ts` | `ef5c83d8f87c593a24de77ad9a59c7e583db2d4d5bb56ca6f49c9f753be767cf` |
| `tests/browser/export-caption-repair.spec.mts` | `3617dcaab0fac5168668e21e0c7e2fb969a7f58dc8a99beb41d197fa0a826531` |
| `tests/caption-handoff.test.mts` | `f6cf48940abccae8d3b4cdfdc37e52d9125e5ec07307780d4992ec0cbc747170` |
| `tests/export-checks.test.ts` | `c4f34609d165f809b40376914b60d61e7b3c9b9915516b9b6f368d73e8cd1ffd` |

An independent read-only reviewer inspected the combined fixes and callers after
the last source/test change. Its deferred-GET teardown finding was corrected and
re-reviewed; the final source review found no definite blockers in these fixes.
Independent evidence review also recomputed the source hashes and inspected the
retained focused/full JSON reports. The reviewer did not run tests; the commands
above supply the execution evidence. The full-suite failure remains a documented
qualification limitation.

Native render math and serializers are unchanged. The previously documented 4K
font allocation limitation below remains historical evidence; this follow-up did
not rerun that native suite or claim to fix it. Final ZIP limits, disk/encoder
conditions, and separately approved public-release/HQ/Distribution work retain
their existing boundaries. Public impact remains **required** within the current
source-only export workflow proposal; workflow and public-impact docs are updated.

## Original implementation qualification (historical)

Source qualification on Windows with Node 24.21.0, based on
`ff996a9216a717ef24c7ed22afe84b82c2d79cf4` (main after PR #87).
All media used for these checks was synthetic and isolated from user projects.
This evidence qualifies the source change, not a public installer or release.

## Passing checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, including the added test sources and brand verification |
| `npm run build` | Passed with brand verification |
| `npm run verify:brand` | Passed; approved source artwork is unchanged |
| `npm run test:public` | 16 passed |
| `npm run check:public` | Manifest, service declarations, current tree and locally available refs/history passed after fetching origin |
| `npm run test:export-checks` | 15 passed: output gates, exact keys, malformed data/size limits, HTTP read-only behavior, cancellation and invalidation |
| `npm run test:caption-handoff` | 32 passed, including real handoff-summary agreement with corrupt saved word-data blockers |
| `npm run test:video-export` | 70 passed |
| Focused browser suite | 40 passed across appearance/export, caption handoff, native overflow warning and the first nine new repair scenarios |
| Final repair browser suite | 10 passed after review refinements, including persisted handoff-duration authority |
| Browser isolation/lifecycle guards | 38 passed on each owned browser run |
| Native renderer, persistent preview, scheduler and handoff files | 46 passed; one FFmpeg 7.1 compatibility case skipped because that optional runtime is absent |

Native file command:

```text
node --import tsx --test tests/caption-renderer-native.test.mts tests/persistent-caption-preview.test.mts tests/persistent-caption-preview-phase3.test.mts tests/native-preview-scheduler.test.ts tests/caption-handoff-native.test.mts
```

Focused browser command:

```text
npm run test:browser -- tests/browser/export-caption-repair.spec.mts tests/browser/caption-handoff.spec.mts tests/browser/appearance-export.spec.mts tests/browser/caption-overflow-warning.spec.mts
```

The final repair-only run used the same wrapper with
`tests/browser/export-caption-repair.spec.mts`. It exercised exact caption
selection/seek/focus, Word timing navigation, return with output choices, SRT
independence from native layout failures, invalidation after draft/resolution
edits, late/cancelled replies, project-visit reset, changed settings during save,
format-specific text restrictions, keyboard pagination and mobile controls.

Desktop and 390 px mobile captures were inspected. Pagination brings the focused
checks heading into view; issue text wraps without horizontal overflow and mobile
repair actions have at least 44 px height. The test creates
`test-results/export-caption-repair-desktop.png` and
`test-results/export-caption-repair-mobile.png` from synthetic footage.

## Existing native font failure

`tests/caption-overflow-native.test.mts` produced 20 passes, two skips for absent
Noto Serif Khmer faces, and one failing scenario (reported as two failures because
the parent test also fails). The failure is **Noto Sans Khmer, Size 120, 4K
portrait, “hello world” with a nonbreaking space**. The existing guarded-canvas
allocation check rejects it before native measurement.

The same scenario fails on unchanged main at the base commit above:

```text
node --import tsx --test --test-name-pattern="ordinary 4K portrait" tests/caption-overflow-native.test.mts
```

The new duplicate-paint attribution, overlap-group attribution and diagnostic
opacity/unverifiable tests pass. Attribution leaves the ASS document bytes
unchanged. No font substitution or weakening of the native safety limit was used
to bypass the baseline failure.

## Review and limits

Independent read-only review covered the final changed source and relevant
callers. Its findings were corrected: serializer-specific rejection rules,
corrupt saved word evidence, portable JSON size, source-duration authority and
export-choice ownership after asynchronous saves. The final review reported no
remaining definite blockers.

Final ZIP entry/total limits and execution-time disk/encoder conditions remain
the export path's authority. Actual native rendering still validates its own
snapshot. This work did not benchmark speed or qualify a release package.

See [public impact](EXPORT-CAPTION-REPAIR-PUBLIC-IMPACT.md) for the source-only
documentation and downstream approval boundary.
