# Word-highlight preparation — Phase 1 source handoff

Change ID: `studio-word-highlights-bulk-preparation-20261008`

Status: **source-only** on the Phase 1 development branch. **Public impact: required**
before a future release. The public `0.85.6` identity/download representation is
unchanged, and this document is not evidence of a published feature.

## User workflow

Appearance → Spoken word highlight → **Prepare word highlights** checks every
nonempty unresolved caption using the existing local exact-word KFA path. The
captions are checked sequentially; already-ready tracks are reused, while locked,
failed, partial, ambiguous and estimated tracks remain for individual review.
Progress and Cancel are visible without covering source playback. Cancel stops
further requests and preserves completed proposals; it cannot forcibly stop an
in-flight local aligner's server-side cleanup.

The user can choose **Use ready timings**, **Keep current**, or **Review remaining**.
After an apply, **Prepare remaining** can retry unresolved captions; that new
preparation retires the earlier quick Undo offer while retaining the saved History
checkpoint.
Preparing does not rewrite caption text or source media, promote guessed boundaries
to ready, or call Gemini. Applying ready proposals updates only their owned word
timing and approval state after a server-side exact revision/media/lock check.
Every selected target is committed together with one project History checkpoint;
any stale target rejects that transaction. **Undo batch** checks the applied
revisions again and restores the earlier states through the same guarded route.
The existing per-caption Word timing editor remains the recovery path.

## Code and boundaries

- `apps/web/src/word-highlight-batch.ts` selects unresolved captions, sequences
  local requests, rejects partial/estimated candidate tracks and prepares guarded
  apply and undo pairs.
- `apps/web/src/App.tsx` owns project/media lifetime, cancellation and progress,
  then applies the prepared changes with an atomic server request.
- `apps/web/src/components/WordHighlightPreparation.tsx` and
  `CaptionAppearanceWorkspace.tsx` expose progress, results, review and undo.
- `apps/server/src/services/caption-word-batch.ts` and
  `apps/server/src/routes/projects.ts` validate current persisted revisions inside
  a serialized project write and retain unrelated caption/media state.

The local timing stack, provider/consent boundaries, Khmer grapheme validation,
render states, FFmpeg/libass rendering and SRT/export contracts stay the same.
Ready timing still means structurally usable alignment, not guaranteed word-level
accuracy in every recording. Performance and alignment accuracy require real
Khmer-media measurements before any claims about improvement.

## Public representation pending release approval

Product-owned evidence: `PRODUCT.md`, `DESIGN.md`, `README.md`,
`docs/FINE-TIMING.md`, and this handoff. A later authorized HQ Phase 3 intake
should use the new change ID above to evaluate the user workflow, feature claim,
supported platform/runtime readiness and local-only data processing. Distribution
Phase 2 must then synchronize the `/studio/` web route and documentation against
the approved HQ representation, subject to its separate approval gates. Do not
mark the feature available in `.sthang/product-manifest.json`, publish a Release,
or deploy the website before those approvals and native release acceptance.
