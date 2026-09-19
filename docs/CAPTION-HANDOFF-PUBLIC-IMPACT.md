# Editable caption handoff — public-impact record

Change ID: `studio-caption-handoff-20260919`

Status: unreleased source. **Public impact: required.** This adds local editable
caption-file handoff, destination guidance, and a captions-only backup/restore
workflow. It does not publish a new release or modify installed applications.

## Product evidence

The README Development changes, Unreleased changelog, PRODUCT, DESIGN, PRIVACY,
SECURITY and `docs/CAPTION-HANDOFF.md` describe the scope. Implementation evidence:

- `packages/shared/src/caption-interchange.ts`: serializers, projected JSON schema,
  exact-text word coverage, Unicode and input bounds.
- `apps/server/src/services/caption-handoff.ts` and its router: saved-snapshot
  exports, styled ASS, fixed-name ZIP, revision/digest/lock guards and History-first
  restore without correction-memory or Contributor capture.
- `apps/web/src/components/CaptionHandoffPanel.tsx`, `CaptionRestoreReview.tsx`,
  `caption-handoff-client.ts`, App and ExportWorkspace: progressive destination
  guidance, explicit download and review/replace actions, save/navigation guards.
- Shared/service/API/browser tests document accepted behavior and failures.

Proposed public copy should say: editable SRT for the documented major-editor
paths; WebVTT/TTML and styled ASS for compatible workflows; word-by-word files
require ready timing; Studio caption data preserves a projected caption backup;
CapCut mobile requires its supported Desktop/Web plus manual project-sync route.
Never claim that VTT, SRT, ASS, or this JSON automatically preserves native editable
word highlighting in every video editor. Do not claim native CapCut project export.

The feature creates local files and accepts local caption data. It adds no hosted
service, automatic editor/cloud upload, dependency, telemetry event, font/media
redistribution, installer/updater behavior or brand changes. CapCut Web/cloud sync
is a separate action taken by the creator through CapCut's service. The projected
caption-data file intentionally contains caption text/word timings and appearance
reference but excludes source identity, paths, account data and private project
context. Existing local source files are not overwritten by handoff downloads.

## Downstream proposal and approval boundary

The available Distribution checkout was read only. Known affected surfaces are
`landing/studio/index.html` and `docs/studio/index.md`, served under `/studio/` on
the website and docs site. Its Phase 2 transport uses `governance/hq/portfolio.json`
and `governance/hq/sync-lock.json` only after governed approval. Suggested HQ fields
are Studio's feature/export-format representation, documentation-impact record,
supported-workflow limitations, and local-data/export description.

No authorized HQ checkout or new exact plan-digest approval was supplied. The
existing product manifest describes the separately governed 0.85.4 release and
its verification script binds that identity. Both remain unchanged. The older
Distribution release identity must not be edited opportunistically in this task.
Before these features are advertised as released, run the HQ Phase 3 intake for
this change, approve the exact eligible plan, then the Distribution Phase 2 sync
and separately authorized website/docs publication. No old release exception or
validator weakening substitutes for that approval.

## Validation boundary

Automated checks exercise synthetic caption data, real local parsing/delivery,
browser interactions, Unicode, stale edits, backup validation, and ZIP structure.
The current handoff has not been imported and edited in every third-party editor.
Keep documented compatibility distinct from locally executed test evidence.

### Recorded local checks

- Shared format/data and saved-snapshot service/API tests: **26 passed**.
- Independent format consumers: **3 passed** using actual FFmpeg/ffprobe,
  Python ElementTree and zipfile/CRC validation, including Khmer/emoji, durations
  beyond one hour, fractional timestamps, word gaps and exact archive payloads.
- Browser suite: **117 of 118 passed in the full run**; one existing waveform
  recovery scenario timed out locating its synthetic project before entering the
  editor, then passed unchanged in isolation. All 12 new handoff cases passed.
  The final compact desktop/mobile layout case passed after the last guide-copy
  change and its captures were visually inspected.
- Existing export/preview/persistence suite: **64 passed**; playback/grouping and
  stale-media suite: **32 passed**. Type checking and the production build passed
  with approved brand verification.
- CapCut Desktop **9.4.0.4015**: a generated synthetic SRT produced two editable
  Khmer/Latin caption blocks, and a text edit in CapCut was visible in its preview.
  Styled ASS was accepted as four repeated text events but its word-highlight
  colors did not survive the sampled import. No cloud sync or user footage was
  used. The detailed scope is recorded in `CAPTION-HANDOFF.md`.

Native CapCut mobile/cloud sync and other commercial editors were not run. These
checks do not certify universal editing/highlight compatibility or a new release.
