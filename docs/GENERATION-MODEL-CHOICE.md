# Project caption model choice

Change ID: `studio-gemini-hydrogen-options-20261113`

Status: development source adds optional Gemini 4 Hydrogen and an explicit low
thinking policy. This change is not evidence of a new public package or update offer.
The original Automatic/Flash choices, tracked as
`studio-generation-model-choice-20261025`, were published in the verified 0.89.0
recovery packages and signed update offers. See [release evidence](V0.89-RELEASE.md).
The approved publication of those original choices and Resume behavior in the
[public guide](https://docs.sthang.app/studio/) remains separate from this addition.

## Behavior

Generate captions → AI options in current source offers Automatic, Gemini 3.8 Flash,
Gemini 4 Hydrogen, and Gemini 3.6 Flash. The same disclosure appears in Accuracy for full regeneration after
captions exist. The choice is saved in the local project, independent of global
AI connection settings. Missing choices in older projects mean Automatic.

Automatic follows the configured global primary/fallback policy, including its
existing retry and terminal-error rules. Its shipped defaults remain 3.8 Flash
primary and 3.6 Flash fallback. An explicit choice uses only that model;
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

## Request policy and cache compatibility

Supported context-aware caption models, including `gemini-4-hydrogen`, send
`generation_config.thinking_level: low`. The former
`GEMINI_TRANSCRIPTION_THINKING_LEVEL` environment setting is ignored, including
in existing installations. No user environment file is rewritten. Unsupported
custom model IDs keep their existing request behavior, and the dedicated
Transcribe compatibility path keeps its transcription-only request shape.

The request and both transcript cache signatures use one effective model policy.
The same-job checkpoint and initial text-stage signature versions change so a
result produced with an older or implicit thinking policy is not reused under
the low policy. Existing job snapshots retain their model IDs. Local audio,
KFA acoustic-emission, and timing caches keep their existing behavior. A new
Alternative take or fresh Deep Verify remains a new model request.

## Verification

Focused checks live in the Gemini model-policy, interaction, SDK-transport, and
generation-model tests (included in `npm run test:gemini`) and
`tests/browser/generation-model.spec.mts`. They cover
allowlisting, persistence, global isolation, immutable job pairs, checkpoint
signatures, explicit low request settings, explicit-model failure behavior,
guarded saves, and responsive UI.
Provider responses in these tests are synthetic; they do not establish live
Google availability or caption accuracy.

## Public impact and proposed handoff

Public impact: required for caption-generation configuration and troubleshooting
guidance. Product-owned evidence is `PRODUCT.md`, `DESIGN.md`, `README.md`, this
document, `.env.example`, the Generate/AI connection options, generation settings
resolver, request policy, cache signatures, and job snapshot behavior.
`.sthang/product-manifest.json` was compared: its provider,
privacy, installation, identity, download, and current release claims need no
change for this local implementation. Preserve its accepted release evidence.

Prepare a new HQ Phase 3 intake using `studio-gemini-hydrogen-options-20261113`.
Review the Studio
workflow/model-configuration representation and `proposal.publicClaims`; retain
`proposal.release.publicVersion` and distribution availability until release
evidence exists. After separately approved intake, Distribution Phase 2 should
review `/studio/` and its guide (`docs/studio/index.md`) for the optional Hydrogen
choice, unchanged defaults, explicit-model behavior, low thinking, and Resume guidance. Mention the feature on
`landing/studio/index.html` only if approved public wording calls for it.

The available Distribution checkout's README Phase 2 workflow was reviewed.
An HQ checkout is not available in the approved workspace roots, so its Phase 3
intake and the exact plan digests/approval-class decisions cannot be prepared here.
Verify the current HQ and Distribution baselines before planning synchronization;
no existing publication approval is reused for this source change. Final website
wording remains pending. This prepared handoff does not authorize cross-repository writes,
commit/push, publishing, deployment, or release promotion.
