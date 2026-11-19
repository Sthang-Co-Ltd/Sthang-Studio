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

## Timing accuracy

Coverage measures whether a word lights. Accuracy measures whether it lights at
the right moment. The accuracy study ran after implementation, on scratch copies
of the two qualification projects. Two blind AI listeners labelled when each word
was heard, without seeing Studio's timing. A component counts as correct when
both its start and its end fall within 80 ms of the listener's edges. It counts
as wrong-word when it does not overlap the heard word at all. Owner listening is
still pending, so these figures are provisional.

The study used a random holdout of 80 captions. Eleven of those captions also
appeared in the tuning set, so they were excluded. The remaining 69 captions
contain 193 painted components.

| Within | 80 ms | 120 ms | 150 ms | 200 ms |
| --- | ---: | ---: | ---: | ---: |
| Components with both edges in range | 144 / 193 (74.6%) | 81.3% | 86.5% | 91.2% |

- The median edge error was 30 ms at the start and 20 ms at the end.
- In 39 of the 69 captions, every component was within 80 ms. At 150 ms, 50 of
  69 met that bar.
- 19 components were wrong-word. Of those, 11 lie entirely outside the saved
  caption cue, so no change inside the existing cue can fix them.
- On 165 holdout paints that the previous per-caption sync also produced, from
  60 captions, the two methods matched closely:

  | Measure | This branch | Previous sync |
  | --- | ---: | ---: |
  | Within 80 ms | 128 | 130 |
  | Within 150 ms | 145 | 145 |
  | Wrong-word | 12 | 15 |

- One-click Apply therefore raises coverage without a measurable change in
  timing accuracy.
- The two listeners agreed on whether a word was spoken for 117 of 118 words.
  For 90 of 113 components, they agreed on both edges within 80 ms. Their
  median disagreement was 30 ms and the 90th percentile was 130 ms. The 80 ms
  threshold is close to the floor of this measurement.

Caption cue edges come from the same local alignment as the word timing. Most
remaining errors are therefore errors in the cue as well. They cluster in two
places:

- speech the caption text leaves out, such as false starts, fillers, and
  repeated or extra words;
- short words at the end of a line spoken quickly.

None of the following improved accuracy without losing correct highlights, so
none ships:

- an alignment-score gate;
- energy-based or acoustic-posterior silence trimming;
- a wording-mismatch flag;
- fallback-recognizer word timing;
- perturbation stability gates;
- wildcard tokens for unwritten speech;
- unrestricted CTC alignment.

A control experiment ran the same local model against the exact spoken wording
of 41 disputed captions. Within-80 ms components rose from 66 to 74 of 118.
Wrong-word components fell from 20 to 10. Using exact wording in the product
would change the caption-generation request, so it is future work that needs a
separate product decision.

## Known limitations

Apply measures words inside each saved caption cue and does not move cues.
Where the caption text leaves out spoken words, or where a cue edge is itself
off, a highlight can light early, late or on a neighbouring word. See
[Timing accuracy](#timing-accuracy). Correct those captions in Fine Timing.

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
