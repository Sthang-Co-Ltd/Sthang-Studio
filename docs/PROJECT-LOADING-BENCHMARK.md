# Server project-loading decision

Tracker #11: consideration complete; lazy loading is deferred. This change adds a
reproducible benchmark and decision evidence, with no store implementation change.

Before measurement, the plan declared investigation budgets of **1,000 ms p95**
for the first summary list and **256 MiB p95** incremental retained heap for
libraries through 100 projects × 1,000 captions, including word timings. A
300-project word-timed library is a separate scaling stress case. These are
engineering budgets for this investigation, not demonstrated customer workloads
or release guarantees. The immutable run plan is embedded in the retained report.

## Reproduce

```text
npm ci --include=dev
npm run benchmark:project-loading -- data/working/project-loading-new-run
```

Choose a new evidence directory with an existing parent. Existing output is
refused. The command builds shared code, creates synthetic JSON in an owned
temporary root, and calls the actual server store in a fresh isolated Node process
for each of seven samples per scenario. No server is launched. Network requests
are disabled; environment/vault paths are isolated and cloud credentials cleared.
The benchmark never reads user projects, media, credentials or the installed app.
Temporary cleanup verifies the exact real path, parent and owner marker first.
The macOS Keychain isolation path is not qualified, so this harness refuses macOS.

Each process imports the store before measurement, forces GC for a heap baseline,
then times `store.listSummaries()` and measures retained heap after dropping the
returned summaries and forcing GC again. It also measures a warm summary list and
one detached detail clone. Assertions check caption counts, summary-only shape,
ordering, detail contents, mutation detachment, unchanged project bytes, and no
added project-directory entries. Source hashes must remain unchanged during the
run. Import timing and RSS are retained separately as diagnostics.

This is **process-cold, filesystem-cache-uncontrolled** measurement. It does not
measure whole server startup, HTTP latency, browser loading, disk-cache-cold I/O,
real media processing, or customer hardware. Do not clear OS caches or change
machine settings to reproduce it. All corpora include Khmer captions and transcript
segments/full text. Rich corpora also have three timed words per caption and
transcript tokens. Other project shapes and richer histories remain unmeasured.

## Retained evidence

[Raw report, plan, samples and source hashes](evidence/project-loading-20261022.json).
Windows 10.0.26300 x64, i5-12500, 12 logical CPUs, about 16 GB RAM, Node 24.21.0.
The exact store baseline is `264ed880437487ada49cd0874f027e18f2630491`.
The checkout was dirty with benchmark tooling; product source was unchanged.
Seven-sample nearest-rank p95 is the slowest observed sample, not a stable estimate
of a population tail. Heap is the incremental forced-GC estimate, not whole-app
memory or a strict memory ceiling.

| Corpus | First list median / p95 ms | Retained heap p95 MiB |
| --- | ---: | ---: |
| 10 × 300, plain | 5.05 / 8.17 | 1.43 |
| 50 × 600, plain | 39.79 / 44.44 | 13.82 |
| 100 × 1,000, plain | 131.31 / 144.93 | 45.89 |
| 100 × 1,000, word-timed | 635.89 / 684.42 | 153.46 |
| 300 × 1,000, word-timed stress | 1,854.56 / 2,614.15 | 460.25 |

## Decision and revisit criteria

All declared primary workloads met both investigation budgets on this machine.
The larger stress case exceeded both. Lazy loading could reduce retained caption
bodies at that scale, but it would need safe on-demand reads, bounded cache and
invalidation, correct summary metadata, serialized saves, appearance preservation,
missing/unreadable-file notices, and non-destructive migration. A metadata cache
must never become a second project authority. No new cache, storage schema or
loader behavior is introduced merely to finish a conditional tracker item.

Revisit if actual supported libraries approach the stress case, if these primary
scenarios exceed budget on representative supported Windows machines, or if a
measured candidate proves worthwhile benefit without weakening preservation and
concurrent-write guarantees. Qualify that candidate against real store/API
recovery tests and compare exact baseline/candidate artifacts. Client row-rendering
cost is a separate question from server loading; neither benchmark establishes
the other's bottleneck.

The branch follows updated `main` at `7d2b4aba3f77d27a65555443ce4141a51c1c29c2`.
That intervening commit changes fine-timing frontend files only; the measured
store/config/shared/lockfile source hashes are unchanged. These measurements are
independent of the other overnight PRs. Tracker #9 changes load validation/readability reporting;
repeat this benchmark after integrating it before extending the conclusion to
that combined source. No combined-source or public-release performance claim is
made. All 35 process samples and their correctness/preservation assertions passed.
No independent review was performed.

## Public impact: none

Compared with `.sthang/product-manifest.json` and its README/privacy/installation
evidence, the diff contains development tooling, evidence and this conditional
decision only. Product behavior, data flows, dependencies, protected identity and
release/download/access claims remain unchanged. No HQ/Distribution write,
publication or manifest rewrite is required for this evidence-only decision.
