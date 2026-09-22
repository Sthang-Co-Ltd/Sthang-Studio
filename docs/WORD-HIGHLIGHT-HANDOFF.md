# Word timing and highlight public handoff

Change ID: `studio-word-timing-highlights-20260919`

Status: source-only proposal, unreleased. Public impact: required. This extends
the earlier `studio-fine-timing-generation-20260918` workflow with editable owned
word timing, local exact-word synchronization, optional spoken-word highlighting,
neighbor protection, and shared-edge editing.

## Product evidence

User guidance and contracts: `README.md` (Development changes), `CHANGELOG.md`
(Unreleased), `docs/FINE-TIMING.md`, `PRODUCT.md`, `DESIGN.md`, and `PRIVACY.md`.

Implementation evidence:

- `packages/shared/src/word-timing.ts`, `caption-layout.ts`, and
  `caption-settings.ts`: exact-snapshot tracks, correction/readiness rules,
  conservative legacy hydration, and native paint state/appearance contracts.
- `apps/web/src/components/WordTimingPanel.tsx`, `WaveformEditor.tsx`,
  `CaptionEditor.tsx`, and `CaptionAppearanceWorkspace.tsx`: editing, local-sync
  candidate review, correction/IME handling, and optional highlight controls.
- `apps/server/src/services/caption-word-timing.ts`, `caption-renderer.ts`,
  `caption-preview.ts`, and `video-export.ts`: local-only synchronization, native
  Khmer-safe paint, and authoritative render snapshots.

Acceptance evidence lives in word-timing/collision/service/API tests, browser
word-highlight scenarios, and native preview/MP4 tests. Do not turn fixture
success into a guarantee of perfect real-speech alignment, universal word
segmentation, zero preview preparation latency, or a generation-speed percentage.

### Local validation, 19 September 2026

The recovered implementation passed the complete 105-case browser suite. Final
review then found a nested-overlap merge that could shorten a caption. A new unit
regression reproduced that failure; the repaired helper preserves the union of
the two caption intervals. Both the existing split/merge browser case and the new
nested-merge case passed afterward (106 distinct browser cases covered overall).

The final source also passed:

| Check | Result |
| --- | --- |
| Word timing, corrections, structure, local service and API | 45 passed |
| Fine Timing, collision transactions, playback and waveform route | 26 passed |
| Native caption rendering, highlighted MP4 and persistent preview | 19 passed; 1 optional FFmpeg 7.1 fixture skipped because it is not installed |
| Video export, preview planning, fonts and persistence | 64 passed |
| Playback/grouping and stale project/media protection | 32 passed |
| Performance/cache contracts | 24 Node tests and 17 Python tests passed |
| Contributor, analytics and consent boundaries | 19 passed |
| Type checking and production build | Passed with approved brand verification |

Desktop and narrow-screen word-control captures were inspected. Native rendering
tests use real FFmpeg with synthetic media, including unspaced Khmer geometry,
word/gap paint changes, and an actual MP4 comparison. Local synchronization tests
exercise revision guards and exact text mapping with controlled timing evidence;
they do not establish alignment accuracy for every speaker or recording. These
results validate local source behavior, not a published release or installed update.

## Proposed public representation

The existing high-level Khmer caption editing/review/local-export description
still applies. Documentation should add:

1. Default collision protection and explicit shared boundaries without automatic
   downstream caption shifts.
2. Editable word timings and local **Sync words → preview → Use timing** for
   corrected wording; ambiguous/estimated words require review.
3. Optional current spoken-word color with a full static caption, native preview
   and MP4 output; pauses restore base color and unresolved captions stay plain.
4. SRT remains cue text/timing with no word-highlight metadata. Per-word tracks and
   preferences stay local and are excluded from existing cloud payloads.

Suggested HQ fields are Studio's approved feature/public-claim representation,
documentation-impact record, and local-data description (`staysLocal`) for
word-timing/highlight state. No new hosted provider, consent category, credential,
dependency, brand asset, installer, updater, release version, or download URL is
proposed by this source task.

## Downstream files and approval boundary

The authorized Distribution checkout was read only. Its README describes the
Phase 2 plan/apply protocol. Known affected surfaces are:

- `landing/studio/index.html` at `https://sthang.app/studio/`;
- `docs/studio/index.md` at `https://docs.sthang.app/studio/`;
- `governance/hq/portfolio.json` and `governance/hq/sync-lock.json` only through
  the governed synchronization, if the approved HQ representation changes.

No authorized HQ checkout/Phase 3 intake evidence or new plan digest was supplied
in this task. The product manifest and its verifier bind the accepted `0.85.4`
release proposal exactly. They are intentionally unchanged: rewriting that
identity or weakening its validator would not constitute approval of this feature.

Before public advertising, an authorized maintainer must run the HQ Phase 3 intake
for this new change ID, obtain its exact plan-digest/approval-class decision, then
the Distribution Phase 2 synchronization. Its currently read policy is tightly
pinned to its accepted transport identity; do not reuse a prior release exception
or change a blocked policy merely to pass this new proposal. Public release,
download publication, cross-repository writes, and deployment need their normal
separate authorization and verified release evidence.
