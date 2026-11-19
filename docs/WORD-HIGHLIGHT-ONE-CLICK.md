# One-click word highlights

Change ID `studio-word-highlight-one-click-20261119` · unreleased source work

Apply checks saved captions locally and publishes eligible timing together. An
explicit Apply enables the project to check affected captions after later saves.
Review remaining opens the highest-priority exception in Fine Timing. Supported
words light individually, measured groups light together, and unsupported words
keep their normal color. A word-by-word export requires a usable interval for each
individual word. See the [Fine Timing guide](FINE-TIMING.md#one-click-apply-unreleased-source).

## Qualification

Task 2 engine qualification covered 369 captions. The engine produced 350 full
captions against the 351-caption target and painted 368 against the 366-caption
target. The lead accepted the one-caption full-coverage shortfall for
implementation on the per-caption evidence. The residual-loss rows cover
occurrence suppression, a discontinuous component, and two no-fit spans under
the signed silence rule. The [engine regression fixtures](../tests/word-highlight-engine.test.mts)
exercise the nested-cue guard, discontinuities and silence. The matched
natural-tokenization context-WAV control paired 1,003 of 1,008 eligible fresh
individual spans. The fresh engine cohort contained 16 painted groups, 14 of
two units and two of three units.

The isolated Windows product run used the built editor and real server with
local KFA and Whisper disabled. Each project copy completed a single Apply
with one durable pre-Apply checkpoint. The stored cohort retained the original
track inputs and normal hydration.

| Cohort | Captions | Full individual | Full with groups | Partial | Plain | Painted | Unattempted | Apply checkpoints | Click to save |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh, project 1 | 240 | 215 | 8 | 17 | 0 | 240 | 0 | 1 | 27.46 s |
| Fresh, project 2 | 129 | 121 | 6 | 1 | 1 | 128 | 0 | 1 | 6.60 s |
| Stored, project 1 | 240 | 215 | 8 | 17 | 0 | 240 | 0 | 1 | 27.46 s |
| Stored, project 2 | 129 | 122 | 6 | 1 | 0 | 129 | 0 | 1 | 7.07 s |

In the first three rows, every caption matched its corresponding engine
coverage and display-unit counts. Stored project 2 reused 14 ready legacy
tracks and prepared 115 candidates. One preserved legacy track counted two
supported units where the engine counted one. Another preserved a ready
interval where the engine’s fresh evidence reported no fit. No estimated or
ambiguous span painted. Project JSON, media, cached normalized audio and
metadata matched the owner originals’ starting hashes.

Repeat Apply created no additional publication or checkpoint. The sampled exact
native paint matched after reload. A saved edit triggered Follow on two affected
tracks per run. Stored project 2’s durable checkpoints show that its normal
save persisted 14 legacy tracks that were already hydrated in the editor.
Follow preserved all 127 unaffected canonical captions. Click to save records a
single observation per row.

Owner listening is pending. The 40-caption scratch checklist includes all 16
painted groups, the plain caption, fast speech, repeated words, overlaps, cue
edges, and a sample of partial captions. Reviewers should record onset and end
independently and mark every caption they would change before export.

## Known limitations

Word-by-word exports require an individual supported interval for every word.
For large Apply operations, inline Undo is bounded by the existing 8 MiB API
request limit. The pre-Apply snapshot remains available in History.

An earlier Windows qualification run missed the paused native overlay at
755 ms inside two nested cues. A later run that overlapped the broader browser
suite also missed a single-cue frame after Apply. The shared legacy-ready
fixture presented the exact overlap frame in 36 of 36 seeks on this branch
and on `main` at `8b70a47`. The cause of the observed misses remains open.
The branch passed 36 more seeks in the broader browser suite. The isolated
product run passed the exact browser check for all four journeys. Run the shared
fixture with `npm run test:browser -- native-preview-overlap-probe.spec.mts --retries=0`.

## Public impact

Propose the workflow and local processing changes in HQ Phase 3 using the change
ID above. The evidence files are README, the Fine Timing guide, PRIVACY, PRODUCT,
DESIGN and the Unreleased changelog. In HQ’s `products/studio.json`, propose
updating `publicSummary`, the workflow and export entries in `publicClaims`,
and the local processing disclosure in `dataProcessing`. Current version and
availability come from the reviewed release manifest. Phase 3 requires a new
exact plan digest and its listed approval classes.

After a qualified release and approved HQ intake, propose matched copy for
Distribution’s `/studio/` feature presentation (`landing/studio/index.html`)
and the Studio guide (`docs/studio/index.md`). Describe Apply, saved-edit follow,
exception review, the word-by-word file limit, and local processing there.
Distribution transport and site publication require their own approved
synchronization plan and deployment decision.
