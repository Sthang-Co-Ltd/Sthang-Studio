# Native preview bounds recovery

## Observed defect

In the same-index-seek browser case at commit 114f0a0ac7514886c8f1c53ec957b6ad36af3dae, FFmpeg exited successfully and the original PNG at 2900 ms contained caption pixels, but Studio returned null bounds. The bbox frame header and coordinates were separated by an interleaved non-monotonic-DTS warning. The old single-line regex omitted that record.

Evidence: [job](https://github.com/Sthang-Co-Ltd/Sthang-Studio/actions/runs/39899588090/job/120237819203), [retained artifact](https://github.com/Sthang-Co-Ltd/Sthang-Studio/actions/runs/39899588090/artifacts/12478927674). Use the same-index-seek case, batch 00-FF0000-024, frame index 3 / 04.png. Its SHA-256 is 1a0388727783119f855f40f79816c3707f3ab27511252c6918d6dcced46185e3. Independent decoding found 3,854 pixels with alpha greater than one and exclusive bounds [139, 301, 503, 319], matching the explicitly attributed FFmpeg coordinates.

## Bounded correction

The pure parser preserves normal inline records and recovers coordinate continuations only for the same explicit caption/focus kind and context token. Frame headers reset association. Anonymous, orphaned, conflicting, malformed and out-of-frame records fail closed. Linux and Windows pointer formats are covered. Rendering arguments, the filter graph, timestamps, PNG bytes, cancellation, and caller frame indexing are unchanged.

This is not a general reconstruction algorithm for arbitrary interleaving. It relies on per-context emission order and retains null when attribution cannot be established. Extra filter lookahead records do not change requested frame indexing. Earlier failures without retained bytes remain unresolved; this evidence does not assign them the same cause.

## Validation and qualification

The checked-in literal stderr regression demonstrates the old parser missing frame 3 and the corrected parser recovering it without changing neighboring bounds. The pure suites include normal output, caption/focus and context separation, empty frames, truncation, anonymous headers, conflicting tuples, unsafe values, Windows tokens, and CR/LF variants. All 39 isolated pure tests passed under Node 24.19.0 before publication. This is not native/browser qualification; the exact published candidate must pass its hosted checks.

The recovery browser test also installs its simulated clock before page navigation, rather than replacing application timer functions after startup. All recovery assertions and its existing fast-forward duration are preserved. [Playwright documents this ordering requirement](https://playwright.dev/docs/clock).

The outer native-caption CI job budget is 45 minutes on both operating systems because prerequisite downloads and Windows font provisioning exhausted earlier job budgets. Individual test timeouts, assertions, retries, workers and coverage are unchanged. Historical failures and cancellations remain evidence, not successful tests.

Public impact: required for the production preview-bounds correction. No new provider, cloud transfer, dependency, release availability or deployment is introduced. Any governed HQ/Distribution representation or release promotion remains a separate approved action.
