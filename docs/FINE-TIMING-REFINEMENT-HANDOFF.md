# Fine Timing refinement handoff

Change ID: `studio-fine-timing-refinement-20260922`

Status: released in `0.85.5`. Public impact: required for the Fine Timing guide's
recovery and accessibility instructions. This is a localized follow-up to
`studio-word-timing-highlights-20260919`.

## Changes and evidence

- Timestamp fields now belong to the selected caption or word. Switching between
  equal-time selections clears the old unfinished draft and validation error.
- Word chips expose their existing Needs review marker as an accessible
  description without changing their word names or selection behavior.
- An available word interval shorter than 10 ms explains recovery and disables
  impossible edits. Creators can make space by adjusting a neighboring word or
  caption, or review a local sync proposal. Other timings never move implicitly.
- Locked word timing and pending sync proposals explain why editing is disabled;
  playback and proposal inspection remain available.

Product evidence: `docs/FINE-TIMING.md`, `CHANGELOG.md`,
`apps/web/src/components/WaveformEditor.tsx`, and
`apps/web/src/components/WordTimingPanel.tsx`. Regression evidence is in
`tests/browser/fine-timing.spec.mts` and `tests/browser/word-highlights.spec.mts`.
The equal-time and no-room regressions reproduced on the pre-fix source. An
independent follow-up review found the same draft leak when an unchanged sync
proposal replaces current timing; its regression reproduced before the final
proposal/current identity fix.

### Local validation, 22 September 2026

- Baseline Fine Timing/word browser suite: 39 passed. Final verification covered
  43 distinct scenarios across full and targeted runs; the last eight affected
  word-edit/proposal/recovery scenarios all passed after the final change.
- One added equal-start word fixture initially hit the intentional no-room guard
  before reaching its draft test. Equal-end selections retain a repair interval
  and now verify the draft/accessibility behavior separately from no-room recovery.
- Source type checking, production build (including approved brand verification),
  manifest verification, and diff whitespace checks passed.
- Desktop and narrow-screen recovery captures were inspected. The narrow-screen
  test checks that the recovery message is below the sticky source player and
  that the document has no horizontal overflow.
- Independent final read-only UI/test review: PASS, no material finding remaining.

Browser scenarios use synthetic source media and controlled API responses;
captures use the native local caption renderer. They verify interaction and
layout, not local alignment accuracy on real speech or a published installation.

## Public representation and approval boundary

At implementation time this correction did not change provider, data transfer,
dependency, install requirement, artwork, package version, or download claims.
The correction is now bundled into the `0.85.5` product/release identity; the
release-level version/download updates are tracked by the `0.85.5` release change
rather than by this earlier interface-only change record.

The local HQ Phase 3 and Distribution Phase 2 README workflows were inspected
read-only. HQ intake consumes committed evidence reachable from `main` together
with the required release evidence. Merging source alone does not approve intake.
After source acceptance and the applicable release evidence, propose the new
change ID above for HQ's documentation-impact record. High-level public claims
and local-data fields need no expansion for this correction alone.

Known downstream surfaces are Distribution's `docs/studio/index.md`
(`/studio/` on the docs site) and `landing/studio/index.html` (`/studio/` on the
website). The detailed guide needs the recovery instructions when Fine Timing
is advertised; the existing broad landing-page copy needs no new claim solely
for these fixes. Governed `governance/hq/portfolio.json` and
`governance/hq/sync-lock.json` may change only through approved synchronization.

HQ intake and Distribution synchronization each require a fresh exact plan digest
and approval-class decision. Cross-repository writes, commit/push, publication,
and deployment remain separate actions. No plan digest or release availability
is claimed by this handoff.
