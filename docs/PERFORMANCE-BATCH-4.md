# Performance Batch 4: bounded residual fixes

Base: `5f9670b98a7783962c0f9b693ae701b58b5f1864` (accepted Batches 1–3).
These are development-source changes, not a release announcement or a claim that
all operations became faster. No storage migration, matching-algorithm replacement,
new dependency, model/configuration change or new data transfer is included.

## Contracts

### Optional acoustic cache I/O

Cache-directory creation, cache-file probing and NPZ write/rename failures must
not select Whisper or discard usable KFA acoustic output. Directory I/O failure
continues without disk caching. Write I/O failure retains the computed in-memory
result and still attempts temporary-file cleanup. The previous complete disk file
survives a failed replacement. Cache reads remain optional, with corrupt/unreadable
entries recomputed. Existing count/byte retention and media identities are unchanged.

The new handlers are restricted to optional cache operations. Audio decoding,
model inference, phonemization/alignment, required CLI output and programming
errors are not silently treated as success. Actual engine failures retain the
existing Whisper/one-shot recovery and fallback-disabled behavior. Acoustic arrays,
alignment math, cache version and serialized NPZ format are unchanged.

### Reconciliation normalization

Each timing word is normalized once into a call-local array. The existing dynamic
program still evaluates the same one-to-three-token groups in the same order with
identical costs, tie-breaking, backtracking, spacing and diagnostic output. Later
calls rebuild normalization for changed words. This does not change KFA inference
or the separately deferred regeneration `buildDiff` matcher.

### Live quality checks

The fixed Khmer grapheme segmenter is initialized lazily and reused; no text or
warning result is retained between analyses. Issue sorting uses an index built in
the existing caption traversal, retaining the first occurrence of duplicate IDs.
Quality profiles, reasons, severities, vocabulary checks and ordering stay intact.
QA is still memoized by its existing App inputs, not run on every clock tick.

### Native preview look-ahead

`captionPreviewLookahead` accepts the caller's nonnegative integer state index and
collects at most eight nonempty states, stopping as soon as those eight are found.
It preserves ordering, repeated states and object identity, including scanning
across gaps. A tail with fewer than eight states is still scanned to its end.
Only collection changes: pending requests, retries, cancellation, cache eviction,
frame timing, Review Focus and native preview/export rendering are unchanged.

## Maintained regression checks

Run from the repository root, after the normal locked development dependency setup:

```text
npm run test:batch4
npm run typecheck
npm run build
npm run test:browser
```

`test:batch4` executes the TypeScript regression suite and the standard-library-only
Python cache suite. Both are also included in `test:performance`, which is called
by the existing local `npm run ci` aggregate. The root test typecheck includes the
new TypeScript suite. No GitHub workflow is changed or required by these commands.

The Python test launcher uses an existing local virtual environment when present,
then the Windows Python 3.12 launcher or an available Python command. It performs
no installation or model download. `STHANG_TEST_PYTHON` can explicitly select an
executable. The unit tests need Python 3.10+; this does not change Studio's supported
Windows/Python 3.12 timing-runtime requirements. No usable Python means a failed
check, not a silently skipped pass.

`tests/fixtures/performance-batch4.json` freezes synthetic full-output fixtures from
the base revision. Only volatile generated token IDs and undefined JSON properties
were removed. Do not regenerate expected results from the candidate merely to pass
an assertion. Review deliberate behavior changes against the original contract.

The tests protect full warning and alignment results, duplicate-ID ordering,
changed-word reuse boundaries, bounded preview work, disk-error handling and genuine
engine failures. Model/decoder/NumPy boundaries in the Python unit suite are fakes;
worker orchestration and temporary-file operations are real. Those passes are not
real KFA inference or a clean Windows installation test.

Before acceptance, run the locked application checks on Windows, exercise the
existing Review/preview browser cases and independently review the full diff. A
functional KFA check may use already approved local media/models in isolated state;
never download models or call paid APIs just to complete these unit tests. Record
any unavailable native/runtime check rather than labeling it passed. Keep raw
before/after samples separate from user-facing speedup claims.

## Public impact and integration boundary

Public impact: none for the intended contract-preserving changes. The cache fix
restores the existing fail-open invariant; providers, consent, retained data,
installation, supported fonts/exports, protected artwork and release availability
are unchanged. This development validation document is not an HQ intake proposal.
The product manifest and its release claim are not advanced. No release, deployment,
OTA promotion, governed-record synchronization, PR or main update is implied by
implementation or local tests. Integration requires separate owner approval.
