# PR 82: bounded Windows persistent-preview investigation

## Preregistered purpose

The prior Windows native job (39038904647 / 117414262588) failed the spoken-word
persistent case after about 5774 ms: persistent frames were 0 rather than 8.
The existing 5000 ms transport deadline and subsequent 60000 ms fallback period
could explain the downstream failures, but the discarded production exception
is not observable from those assertions. No root cause is established.

This experiment compares the original concurrent native-suite execution with
one isolated execution of the persistent test file in a fresh Node process on
the same Windows runner. The isolated process resets fallback state naturally;
it does not clear or modify state inside the original execution.

Discriminating observations: did a persistent child start, how many complete
32768-byte seed writes occurred, did stdout or bbox progress arrive, did the
child emit an error/exit before disposal, and how long before kill/close? A kill
near 5000 ms is consistent with a timeout, not direct evidence of the discarded
exception. A difference between concurrent and isolated results is evidence
for further investigation, not proof of resource contention or flakiness.

## Exact commands and stopping condition

The workflow enables this temporary investigation only on Windows, for PR 82,
run attempt 1, when the checked-out candidate has exactly one parent and that
parent is 7652c24966690da60004750acb5ae40846316ee6. Windows checkout fetches two
commits for this read-only check. An absent/mismatched gate leaves the original
command uninstrumented and skips the comparison/artifact steps. Subsequent
commits, main pushes and reruns do not repeat it. Do not publish another direct
child of that same parent as a second experiment without fresh authorization.

With Windows-only STUDIO_NATIVE_PREVIEW_DIAGNOSTICS pointing at
RUNNER_TEMP/native-preview-diagnostics and
STUDIO_NATIVE_PREVIEW_DIAGNOSTIC_PHASE=concurrent:

    npm run test:caption-renderer

The existing script still builds shared code and invokes Node's default test
concurrency with the original five test files. No argv, assertions or native
renderer timeouts change.

Then, once, in a fresh process on that runner, with the same evidence directory
and STUDIO_NATIVE_PREVIEW_DIAGNOSTIC_PHASE=isolated:

    node --import tsx --test tests/persistent-caption-preview.test.mts

Stop after these two executions and evidence review, whether green or red.
Do not manually dispatch or rerun until green. The original command remains a
normal failing workflow step if it fails; the comparison cannot repair its
outcome. A complete pass means only “not reproduced in this investigation.”
The existing 20-minute job ceiling is unchanged; cancellation or that ceiling
can prevent the comparison or exit-only evidence flush. Missing evidence must
be reported as missing, never as a pass.

## Test-only observation contract

The two synthetic persistent test files explicitly install the helper before
production modules are dynamically imported. The helper is inactive without
the exact opt-in phase and output directory. No NODE_OPTIONS or preload affects
other Node programs. Only spawn calls with the persistent transport's
-reinit_filter flag are observed. No product source is edited. The existing deliberate crash fixture substitutes
a Node child before invoking the saved spawn, so it is intentionally outside the
FFmpeg flag filter; test boundary counters still capture that fallback case.

Wrappers forward the identical receiver and argument objects to original
spawn/emit/write/destroy/kill methods and return or throw exactly as they do.
No callbacks are replaced or called by instrumentation. There are no added
stream listeners, reads, resumes, pipes, timers, sleeps, retries, transforms,
EOF writes, buffer mutations or timeout changes. Stream observations happen
only on emissions the original program already produces. A small synchronous
observation cost remains unavoidable; this is diagnostic evidence, not an
uninstrumented performance benchmark.

Per process, keep at most 64 child summaries and the latest 1024 metadata events.
Stderr inspection is limited to 8192 bytes per emitted chunk with a 2048-character
partial line. Only recognized error categories and bbox counts are retained;
raw stderr, error messages/stacks, executable arguments, paths, ASS content and
PNG contents are never serialized. Truncation and omission counters distinguish
missing evidence from zero progress. A seed count means complete-sized write
attempts, not FFmpeg consumption. Bbox counts indicate emitted native progress,
not successful request completion. Existing diagnostic snapshots report the
actual production frame/fallback counts at beforeEach/afterEach boundaries,
including failed tests. stdin destruction/kill and test identities locate
cancellation/disposal behavior; no internal cancellation reason is invented.

Evidence is written only during ordinary process exit, after timed rendering.
Flush failures are contained and cannot replace the original exit status; the
artifact step requires evidence to exist. The original CI test output remains
in Actions logs. JSON artifacts use the existing pinned upload-artifact action
with five-day retention. Everything observed originates in checked-in synthetic
fixtures, with no real app state, source media, project content or credentials.

## Local validation

Only sanitized fake-child recorder tests are run locally:

    node --test tests/diagnostics/native-preview-recorder.test.mjs

These check inactive default, unchanged receiver/argument/callback identity,
return/throw/emit behavior, no added listeners, unmodified buffers, bounded safe
metadata, and contained observation/write failures. Native Windows behavior is
measured only by the approved automatic CI run after independent source review.

Public impact: none. Test-only diagnostics do not change advertised behavior,
installation, runtime data flow or release state. The product manifest, README
and PRIVACY disclosures require no change for this synthetic CI investigation.
