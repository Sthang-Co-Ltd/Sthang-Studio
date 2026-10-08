# Spoken-word highlighting — Khmer alignment Phase 2

Change ID: `studio-khmer-word-alignment-20261008`

Status: **unreleased source changes; public impact required before publication**.
This source follows the Phase 1 preparation work documented in
`WORD-HIGHLIGHT-BULK-PREPARATION.md`. No new Studio version, download, update
pointer, website claim or hosted data flow is authorized by this handoff.

## Problem and correction

KFA returns real Khmer CTC-derived acoustic word intervals. Earlier Node-side
normalization always asked the local ICU word segmenter to subdivide every KFA
orthographic span, using character weights to assign times to subdivisions. Such
fractions are estimates; they cannot establish where a separate spoken word
began. Phase 2 retains original direct KFA anchors during cleanup and performs
the mismatch check against the displayed wording. One matched displayed word
may use one complete acoustic interval. If the displayed wording requires
multiple words inside one measured interval, their internal timings remain
estimated and need review rather than becoming automatic highlights.
The sequence matcher also supports up to eight displayed units corresponding
to one KFA orthographic span when their combined normalized text agrees exactly
(including an explicit vocabulary alias). This avoids interpolating unmatched
prefixes outside that measured acoustic window; every internal boundary remains
estimated/review-required, not a newly observed acoustic event. Distinct
near-spelled KFA words are not deleted as fuzzy duplicates; normalized identical
overlaps may still be deduplicated. Whisper's existing duplicate cleanup is
unchanged.

KFA's forced-alignment path score is not a calibrated speech-recognition word
probability. Phase 2 keeps the measured interval and word-to-text correspondence
as separate evidence, so a low raw score alone does not mark direct-KFA wording
for review. Strong text resemblance or a local faster-whisper word probability
also cannot prove that an ASR fallback interval was forced-aligned to the final
text. Those fallback word intervals remain usable evidence for caption timing,
but their per-word highlights require exact KFA synchronization or user review.
Split/fallback words also count as low-confidence timing evidence for advisory
alternative-caption ranking even when ASR probabilities and lexical matches are
high; they do not alter Gemini wording, SRT cue timestamps, or acoustic math.
Ambiguous multi-anchor matches, mismatched text, interpolated words and Khmer
grapheme-unsafe boundaries still fail closed.

## Compatibility and cache behavior

This work uses the existing local KFA/ONNX and faster-whisper dependencies, with
the same one-shot fallback path, bounded project-local caches, and no new cloud
audio transfer. It changes interpretation of alignment metadata for newly
generated or resynchronized captions, without rewriting legacy project captions
or approved manual word edits. Normalized timing-result and outer generation
stage cache signatures are advanced to avoid replaying older derived token
splits. Transcript-independent KFA emissions may continue to be reused, because
the acoustic model math and inputs are unchanged.

The normal SRT cue text/timing contract and native ASS/MP4 rendering remain
unchanged. Exact glyph/word intervals are shared by preview and export; words
still needing review remain plain rather than showing invented precision.

## Qualification before public release

Automated synthetic fixtures can verify provenance flags, stable Khmer grapheme
offsets, confidence rules, partial-vs-ready states, and unchanged timing/text.
They cannot establish actual millisecond word-boundary accuracy on real Khmer
speech. For native acceptance, sample multiple speakers, speeds, noise levels,
long vowels, Khmer-English code-switching, punctuation, and alternative lexical
segmentation. Record correctly ready vs incorrectly ready counts, manually
verified median/p95 boundary errors, the proportion of captions requiring
review, and cancellation/cache effects. Do not claim a performance or accuracy
percentage until those measurements exist.

## Public handoff

Product-owned evidence: `PRODUCT.md`, `DESIGN.md`, `README.md`,
`docs/FINE-TIMING.md`, this handoff and relevant timing/word-highlight tests.
Future maintainers should evaluate the public description of Khmer timing and
the warning that fallback word timings need review, using a new authorized HQ
Phase 3 intake. Sthang Distribution `/studio/` docs/website synchronization
requires the HQ decision and its own Phase 2 approval. No direct edit or
deployment to those external portfolios is implied here.
