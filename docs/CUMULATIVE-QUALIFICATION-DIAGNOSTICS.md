# Cumulative qualification diagnostics

These tools collect local evidence from disposable synthetic fixtures. They do
not fix or explain a historical failure merely because a later run passes. Keep
the original raw reports separately and bind every new run to its source files,
executed artifacts, runtime and process identity.

## Native reference capture

The existing `native-preview-continuous` browser tests now retain their setup
references before renderer cleanup: complete synthetic input and paint order,
ASS, each PNG, parsed bbox associations, full FFmpeg stderr, arguments and process
outcome, source/build maps, executable identity and staged font hashes. Capture
is an explicit in-process diagnostic option; HTTP callers never enable it.
Capture failure is marked and cannot replace the renderer outcome. Normal
process cancellation, cleanup, filters, parser, assertions and deadlines remain.

On the supported Node runtime, after building, use the existing owned runner:

```text
node scripts/run-browser-tests.mjs tests/browser/native-preview-continuous.spec.mts --grep "held future native work yields to current paint after deadline" --workers=1 --retries=0 --reporter=list,json --output <fresh-output-directory>
python scripts/analyze-native-reference.py <output-directory> --output <new-report.json>
```

The offline analyzer requires Pillow and independently reads PNG alpha occupancy
and stderr fields. It does not run FFmpeg. Check capture completeness, file hashes
and frame counts before interpreting its classifications. A browser screenshot
is not a reference PNG. A null stderr-derived bbox alone does not establish
absent pixels. The added evidence is collected before playback experiments;
rendering/setup timings with retention are diagnostic observations.

Declare bounds before running. An isolated pass is inconclusive for a historical
failure. A single original-order file run can explore relevant ordering; never
rerun complete suites until one happens to pass.

## Project-loading phase profile

```text
node --import tsx scripts/diagnose-project-loading.mts --self-test
node --import tsx scripts/diagnose-project-loading.mts <fresh-evidence-directory>
```

The fixed diagnostic plan uses seven small controls followed by seven working
samples, each in a fresh process. It verifies byte equality with the unchanged
clean benchmark generator. Only synthetic JSON is created; normal owned-state
cleanup remains. All outcomes and partial failures are retained without retries.

An explicit observer records directory creation, marker metadata, directory
listing, file reads, parsing, shape validation, scan, publication and summaries.
There is no normalization step in the accepted per-project load path. No observer
is installed in normal operation or the clean benchmark; disabled hooks read no
clock and add no await. Mutation queues and recheck generation safeguards remain
unchanged. Observer exceptions cannot change loading/recovery behavior.

Process launch, import, forced GC, first list, warm list and detail are separate
windows. GC, event-loop, CPU/resource and filesystem wall-time signals are
supporting evidence. Read spans overlap: their sum is not elapsed I/O time;
scan spans contain subphases. Do not add nested/overlapping durations or infer
disk, antivirus or scheduling causes from an awaited filesystem span alone.
Windows resource counters can be unsupported/zero, and short stages can have no
event-loop-delay samples. Instrumentation also perturbs timings and retained
heap, so it cannot establish clean-budget compliance or a speedup.

Keep clean qualification separate:

```text
npm run benchmark:caption-list -- <fresh-caption-directory>
npm run benchmark:project-loading -- <fresh-loading-directory>
```

The clean loading benchmark retains seven samples in each of five scenarios,
nearest-rank p95 and the existing 1000ms/256MiB primary investigation gates. A
gate exceedance triggers investigation; it is not a customer SLA or automatic
justification for lazy loading. Non-primary stress results do not establish
budget compliance.

## Current bounded investigation

The original candidate `1fe427a` recorded a 1400ms null reference bbox and a
working first-list sample of 4639.2182ms. Its native artifacts were insufficient
to distinguish pixels from parser/output association; its phase timings were
not retained. The earlier `faa851b` small2428.8569ms sample remains separate.

On baseline source plus these diagnostic additions, the isolated case and one
original-order file passed. Independent inspection found pixels and bounds in
all64 isolated and260 ordered-file reference PNGs. Fourteen process-cold
diagnostic samples did not reproduce a 1000ms loading stall; the seven working
samples ranged43.2936-46.6977ms. Both historical causes remain unresolved. No
product-behavior correction or lazy-loading architecture is justified by these
observations. Subsequent full qualification and clean benchmark receipts must
remain separate from these instrumented samples.

Public impact: none for the synthetic-only diagnostic tooling. There is no new
data transfer, dependency, advertised feature or release-availability claim.
The underlying historical discrepancy has unresolved user-visible impact; any
future product correction requires a fresh assessment. Publication ownership is
a separate diagnostic follow-up, not an unrelated addition to PR94. No HQ or
Distribution update is proposed for these developer diagnostics.
