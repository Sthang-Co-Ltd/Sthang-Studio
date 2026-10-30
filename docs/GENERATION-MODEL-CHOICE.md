# Project caption model choice

Change ID: `studio-generation-model-choice-20261025`

Status: published in the verified 0.89.0 recovery packages and both signed update
offers. See [release evidence](V0.89-RELEASE.md). Website synchronization remains
subject to its separate HQ and Distribution approvals.

## Behavior

Generate captions → AI options offers Automatic, Gemini 3.8 Flash, and Gemini
3.6 Flash. The same disclosure appears in Accuracy for full regeneration after
captions exist. The choice is saved in the local project, independent of global
AI connection settings. Missing choices in older projects mean Automatic.

Automatic follows the configured global primary/fallback policy, including its
existing retry and terminal-error rules. Explicit 3.8 or 3.6 uses only that model;
there is no alternate-model fallback or experimental transcription rescue for an
explicit choice. Existing safety filters are unchanged. New generation, range
regeneration, Alternative take, and Deep Verify use the project/request choice.
Exact-word realignment remains local.

New persisted jobs snapshot only the effective primary/fallback model IDs at
admission, never credentials. Queuing, restart, and Resume retain the snapshot.
Changing choices affects new jobs. Legacy jobs without a snapshot acquire the
Automatic pair once on their first execution after upgrade. Direct compatibility
HTTP processing endpoints still resolve Automatic at execution; they are not
persisted jobs. Details reports actual transcript model provenance.

Choice saves compare the prior model and media under the project write lock.
They preserve captions, context, appearance, and caption content revision, so
existing proposals remain reviewable. Other project writes preserve the current
choice. Generation waits for a settled choice, and late same-media project reads
cannot overwrite this editor's acknowledged choice. Another editor's conflicting
choice save requires reopening to see its saved choice.

The provider, data categories, credential ownership/storage, Files API retention,
and Interactions `store: false` policy are unchanged. No new service, telemetry,
dependency, or cloud transfer category was introduced.

## Verification

Focused checks live in `tests/generation-model.test.mts` (included in
`npm run test:gemini`) and `tests/browser/generation-model.spec.mts`. They cover
allowlisting, persistence, global isolation, immutable job pairs, checkpoint
signatures, explicit-model failure behavior, guarded saves, and responsive UI.
Provider responses in these tests are synthetic; they do not establish live
Google availability or caption accuracy.

## Public impact and proposed handoff

The feature intake below is historical preparation. Release intake
`studio-v0-89-0-release-20261030` now consolidates it with editor layout and the
actual publication evidence. The exact HQ reconciliation and Distribution
transport approvals are still required; neither website deployment nor HQ intake
is established by this product release.

Public impact: required for caption-generation configuration and troubleshooting
guidance. Product-owned evidence is `PRODUCT.md`, `DESIGN.md`, `README.md`, this
document, the Generate options component, generation settings resolver, and job
snapshot behavior. `.sthang/product-manifest.json` was compared: its provider,
privacy, installation, identity, download, and current release claims need no
change for this local implementation. Preserve its accepted release evidence.

Prepare a new HQ Phase 3 intake using the change ID above. Review the Studio
workflow/model-configuration representation and `proposal.publicClaims`; retain
`proposal.release.publicVersion` and distribution availability until release
evidence exists. After separately approved intake, Distribution Phase 2 should
review `/studio/` and its guide (`docs/studio/index.md`) for project AI options,
explicit-model behavior, and Resume guidance. Mention the feature on
`landing/studio/index.html` only if approved public wording calls for it.

No authorized HQ/Distribution checkout was available in this task's workspace.
Their exact plan digests, approval-class decisions, and final website wording
remain pending. This prepared handoff does not authorize cross-repository writes,
commit/push, publishing, deployment, or release promotion.
