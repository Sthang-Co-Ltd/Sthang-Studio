# Media replacement validation — 2026-10-15

Source-only implementation based on `3c432f4`. No commit, push, release, deployment,
or installation was performed. All media tests used generated fixtures.

## Passed on Linux with Node 24.21.0

- `npm run test:media-replacement`: 46 tests, 46 passed. Includes 13 full-band native
  FFmpeg compatibility tests, 26 transactional server tests, and seven React-markup
  tests. Markup tests are not browser interaction tests.
- `npm run typecheck` and `npm run build`, including approved-brand verification.
- Final affected regression reruns: contribution 19; fine timing 28; word timing
  97; caption handoff 31; video export/store/appearance 68; playback/grouping 32;
  performance 24 (plus timing-cache checks); media preview 12; updater 91 passed,
  one existing skip. No failures in those final reruns.
- Additional aggregate tasks passed: macOS compatibility unit fixtures, public
  guard fixtures, Gemini mocks, media clock, caption effects, web optimizations,
  timing dependency fixtures, and dependency-runtime policy checks.
- New browser test source passes standalone type-checking; `git diff --check` passes.
- Independent final read-only source review found no remaining high-confidence
  blocker after fixes for stale jobs, strict history backup reads, pending Accuracy
  state, and publication durability ordering.

The fine-timing rerun was serialized after a parallel production build briefly
removed generated shared output. Its final standalone rerun passed all 28 tests.

## Not a full CI or browser acceptance pass

- `npm run ci` stops at an unchanged source-watcher test because the sandbox denies
  the Unix socket used by `tsx watch` (`listen EPERM`). The remaining CI commands
  were run individually to avoid hiding other failures.
- `npm run check:public` passes manifest/service checks but rejects the shallow
  clone for its full Git-history scan. No public-release readiness claim is made.
- Chromium fails before opening the application because socket creation is denied.
  A sanctioned escalation failed before launch. No browser-security workaround,
  user-computer route, or access to private projects was used. The eight new browser
  interaction tests and existing regression flows require an authorized browser
  environment before merge; see `MEDIA-REPLACEMENT.md`.
- In the initial Linux implementation pass, native Windows/macOS behavior and
  real user-clip acceptance were not exercised.
  Compatibility is conservative signal evidence, not semantic identity proof.

## Recovery boundaries

Windows lacks the directory-flush confirmation used on Linux. The implementation
retains the older source and History when durability cannot be confirmed and shows
a warning rather than deleting them. Restore requires readable regular active media of the recorded size and a
consistent backup copy; it does not prove decodability or detect all same-size
corruption. An active source that cannot be backed up requires separately
reviewed manual recovery. Explicit recovery deletion can leave retired History
entries until project deletion. No power-loss testing was performed.

Public impact: required. Workflow, local recovery retention and limitations are
covered by the source-only README/PRODUCT/PRIVACY/changelog updates and the separate
`studio-preserve-reviewed-media-20261015` intake record. The accepted v0.86.0 public
release manifest and its strict verifier are unchanged.

## Windows qualification and corrective candidate — 2026-10-15

The first Windows qualification of candidate tree `5514aee257347e9ad95568051672e2bb23f78040`
failed: 12 native audio checks and seven markup checks passed, 25 server tests
stopped during store initialization, and two platform-specific tests skipped.
The file-flush helper opened files read-only; Windows rejected `fsync` with EPERM.
This also affected ordinary project/History writes. A synthetic Windows probe
confirmed read-only failure and writable (`r+`) success. The corrective source
uses non-truncating writable handles for all three file-flush sites, preserving
strict sync-before-publication and cleanup semantics. Directory durability limits
and retained-source/History warnings are unchanged.

Actual Windows Chrome execution passed 30 route-mocked UI cases and failed two
assertions: clicking behind the pending modal, and expecting raw transport text
instead of the save-blocking message. Those tests are corrected without dropping
late-edit recovery or unsaved-draft/no-replacement assertions. Mocked UI success
is not disk/server acceptance. The original failure evidence is retained unchanged.

The corrective candidate must be qualified again on Windows with the exact new
patch/source identity, including ordinary project/History persistence, actual disk
replacement/reopen/restore, stale jobs, failure cleanup and Windows retention
warnings. Linux reruns cannot establish Windows acceptance. Do not merge, install
or describe this candidate as Windows-qualified on the basis of the first run.

Corrective Linux validation: 51 feature tests passed (including four nested
prepublication failure cases), video-export/store/appearance 68 passed,
playback/grouping 32 passed, updater 91 passed with one existing skip. Final
typecheck, production build and diff whitespace checks passed. Authored browser
tests typecheck and are discovered, but corrected browser interaction and native
Windows execution still await the supplemental qualification run.

## Second Windows qualification — original corrective candidate

Candidate `b25b682c937df1cde5d82720199a2f5dafe3a5a0` ran on native Windows:
50 feature checks passed, one POSIX-only decoder/probe fixture skipped; typecheck
and build passed. Browser regression execution passed 36 cases and failed one
menu interaction before its intended recovery assertions. Supplemental actual
server/disk UI runs verified replacement, geometry, reopen, undo/redo, reset,
incompatible-audio rejection, stale jobs, preview/export identity, and Windows
retention/failure cleanup. These results belong to that exact candidate only.

The run also demonstrated a real data-loss race: a caption-save response arriving
after newer Accuracy description/vocabulary input reset those drafts. No context
PUT preceded replacement, and both published project and recovery contained older
context. That candidate is not accepted. The subsequent correction must be checked
with held caption/context responses, newer Accuracy edits, project/media/session
changes and exact persisted backup values. The separate menu-click failure has no
proven root cause yet; its recovery assertions must be isolated from menu behavior
without silently dropping the original interaction reproduction. The original
Windows evidence is preserved, not replaced by later passing cases.

The Accuracy correction separates raw editor fields from their saved baseline,
orders context-owning writes, scopes acknowledgements to editor sessions, and
retains accepted post-submission Accuracy input in old-source copied recovery.
Media preparation now supplies an optional context revision checked inside the
server's write lock; concurrent preflight writes cannot both accept one revision.
This does not change ordinary context-save last-writer semantics. Deterministic
unit and route tests cover the corrected orderings, but browser and actual disk
acceptance of this new source still require fresh Windows qualification. Separate
menu pointer/keyboard diagnostics retain the unresolved original interaction.

Final Linux checks for the Accuracy correction: 72 feature tests passed (including
20 draft-ordering tests and the atomic context-preflight route regression),
68 export/store/appearance, 32 playback/grouping and 97 word-timing checks passed.
Final typecheck, build, authored browser-spec typecheck and whitespace checks
passed. Browser discovery finds 45 cases across the preserve/grouping specs;
none of those new interactions were executed in the cloud. Native Windows/disk
requalification and the unresolved menu pointer reproduction remain required.

## Third Windows qualification — Accuracy correction

Candidate `82e81a4c7662e0302b44622687cc133f80d4366b` passed 71 native
feature tests with one POSIX-only fixture skipped, typecheck and build. Ten
supplemental actual disk/browser Accuracy races passed, including delayed replies,
raw draft retention, project/source/session isolation, revision conflicts,
pre-replacement context persistence and old-source late-input recovery. Seven
other disk/browser scenarios and three native preview/export scenarios passed.
These are historical results for that exact source, not acceptance of later edits.

The authored browser run passed 38 of 50 cases. Ten Accuracy cases stopped at an
exact accessible-label lookup: wrapping labels included textarea content and the
vocabulary count. Two ordinary pointer menu cases failed. Primary event evidence
shows that focus selected the second caption and collapsed the first caption's
expanded risk details between pointerdown and pointerup, moving the action button
23.6875 pixels. The click landed on the row, so the menu never opened. The held
response case failed before its save response was released; keyboard interaction
passed. These failures and original evidence remain preserved.

The next correction gives Accuracy fields stable native label associations and
keeps row-action targets stable through pointer activation while retaining native
blur/save and keyboard selection. It does not change the accepted Accuracy draft
or media-transaction logic. Fresh exact-source Windows/browser qualification must
rerun the original pointer paths, canceled gestures, keyboard interaction, all
Accuracy assertions and actual disk replacement/recovery. No cloud typecheck,
source review or browser test discovery substitutes for that execution.

Cloud checks for this narrow pointer/label correction passed: 72 media-replacement,
32 playback/grouping, 97 word-timing and 68 export/store tests, final typecheck,
build (including brand verification), strict browser-spec typecheck and whitespace
checks. Browser discovery lists 56 cases across the three qualification specs;
these were not executed here. One intermediate pointer-event TypeScript type
error was corrected before the final checks. Independent source review found no
remaining blocker, with actual mouse/touch event ordering still unqualified.

## Fourth Windows qualification — pointer and label correction

Candidate `1e426c0502b38a3d8512bc22aa332be80277a2fe` passed 71 native
feature checks with one POSIX-only fixture skipped, typecheck and build. The full
56-case browser run passed 55 cases and failed the emulated-touch selection
assertion. All exact Accuracy label cases reached their assertions and passed;
10 fresh actual disk Accuracy cases, seven broader replacement/recovery groups
and three native preview/export checks also passed. These results belong only
to that candidate. Original evidence and failed attempts remain preserved.

The original three pointer/keyboard menu paths now open successfully, with stable
button geometry through click targeting. However, primary held-pointer and
held-keyboard event traces also show selection reverting from caption 2 to caption
1 after the older caption-save acknowledgement. Those tests passed because they
checked menu persistence and actions rather than selection. The emulated-touch
case exposed the same regression by asserting selected-range; its later lock/save
assertions were not reached. This is not a touch-only defect.

The source-backed cause is a captured applyProject closure reading an older
selection anchor, then resetting both endpoints during a clean save acknowledgement.
The next correction must reconcile current same-source selection at acknowledgement
time, preserve valid forward/reversed ranges, retain source/session guards and
handle removed IDs/empty captions. Keep the original failed touch assertion and
add explicit post-acknowledgement selection checks to the ordinary input paths.
Actual browser/Windows requalification is required; physical touchscreen scroll
cancellation and destructive power-loss recovery remain untested.

The subsequent correction opts only guarded caption-save acknowledgements into
selection preservation, and only while the media is unchanged. It leaves current
selection state untouched rather than reading a captured anchor. Navigation,
History and other explicit project publications retain their prior behavior.
The existing active/next/last fallback for invalid endpoints is extracted without
changing behavior; valid forward/reversed endpoints and empty drafts have direct
unit coverage. The original touch test is unchanged, all three original menu
paths now assert post-acknowledgement selected IDs, and seven new browser cases
cover held replies, anchor direction, invalid/empty responses and touch selection.

Linux checks passed: 72 media-replacement, 44 playback/grouping (including 12 new
selection tests), 97 word-timing, 68 export/store and two existing selection
performance tests. Final typecheck/build/brand, browser-spec typecheck and
whitespace checks passed; discovery lists 63 cases in the three qualification
specs. Browser execution and native Windows acceptance remain pending. An
intermediate helper patch temporarily replaced existing selection utilities; it
was caught and restored byte-identically before final tests and review.

## Fifth Windows qualification and V6 correction

V5 tree `b1f5f2b091b4fe9dec97dab72006c6f54a9ec719` recorded 62/63
authored browser passes. The original native emulated-touch case failed before
opening the menu; its later assertions were not reached. Focused selection,
actual disk/recovery/range and highlight export checks passed. The media suite
recorded 71 passes and one POSIX-only skip. The separate grouping suite recorded
34 passes, nine failures and one timeout. These historical results were relayed
from the local read-only diagnosis; the original evidence must remain preserved.

The touch trace places compatibility mousedown on the intended button, then
focus and selection/layout change moving its y coordinate from 304.375 to
280.6875 before mouseup/click hit the row DIV. The caption reply arrived later.
This is distinct from V4's acknowledgement selection reversal. Timer state was
not observed, so timer expiry remains an inference. V6 re-arms the existing
focus marker on primary mousedown before native focus and clears unused markers
after mouseup. Native blur/save and click-only activation are retained. Three
synthetic delayed-compatibility tests supplement, without changing, the original
immediate native tap, cancellation, keyboard and post-acknowledgement assertions.

The grouping failures expected deletion/cleanup on Windows despite documented
unconfirmed directory durability retaining old source and History. V6 leaves
production retention unchanged. Ordinary race tests check actual durability,
exact warnings and retained bytes/History. Project-scoped, finally-restored test
overrides separately exercise confirmed-durable cleanup/failure hooks; a forced
nondurable test checks retention and zero cleanup calls. Those overrides are
branch coverage, never evidence that Windows directory durability is confirmed.

Fresh V6 Windows/browser acceptance is still required. Cloud browser execution
was not attempted; compilation/discovery does not qualify real gesture behavior.
Physical touchscreen scrolling, destructive power-loss testing and exhaustive
platform durability remain outside acceptance.
