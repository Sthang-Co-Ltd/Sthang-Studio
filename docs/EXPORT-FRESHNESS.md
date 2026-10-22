# Export freshness — tracker 7

Change ID: `studio-export-freshness-20261021`.

Source-only. Export history follows the output controls and retains the latest
prepared export per format (at most nine). A SHA-256 fingerprint covers the media
identity and the shared format-specific content basis. SRT/VTT/TTML compare the
serialized text/timing; word files include ready word intervals. Studio data and
bundles include their projected review/appearance metadata. ASS/video compare
configured appearance, caption text/timing and ready word-paint intervals. Video
output settings are retained from that render rather than compared with later
Export control choices. Title and approval changes alone do not stale plain
subtitles or video. Undoing back to the same output content matches again.

The UI compares the open project, including unsaved edits; it does not certify
unseen changes in another client. New completed video jobs also carry their own
immutable content fingerprint and show a comparison in Activity. A different
project must be opened through the existing save/recovery protections first.
Legacy exports are unknown; no fingerprint is retroactively invented. Receipts
record file preparation or successful video completion, not browser download to
disk, file existence, external edits, renderer pixel equality or release readiness.

Receipts contain only format, version, hash and preparation time, in the existing
project history directory. Writes are serialized, atomic and bounded. A corrupt
receipt is preserved and shown as unavailable; optional write failure cannot fail
a ready download or verified video. Project deletion removes receipts with history.
No caption text, source media, filename or credential is duplicated in receipts.

Public impact: required. README.md, PRODUCT.md, DESIGN.md and PRIVACY.md document
the visible workflow and local metadata retention. The verified product manifest,
version and public-download claims are unchanged. Proposed HQ follow-up fields:
Studio export/review workflow evidence and local-storage privacy evidence. Proposed
Distribution follow-up: `/studio/` workflow and privacy documentation. HQ intake
and Distribution synchronization require their separately reviewed exact plan
digests/approval classes; no cross-repository write, release or deployment occurs
in this source PR.

Validation on Windows/Node 24.21.0: 43 caption handoff/evidence tests and 83 video
export tests passed. The latter include two actual synthetic Khmer MP4 jobs that
verify immutable provenance after newer edits and successful completion despite
receipt storage failure. Browser qualification passed 25/25 with one worker,
zero retries, and 38/38 isolation/lifecycle guards. Typecheck, production build,
brand, manifest, service configuration, public-readiness and whitespace passed.
Desktop and emulated mobile captures were inspected; the UI detector found no
issues in the changed component targets. Review was primary-agent-only.

The initial browser run was 21 passed/3 failed: history placed above the output
controls pushed Download SRT outside its required desktop viewport; two new tests
also incorrectly assumed focused-edit autosave and a nonexistent render label.
Traces/screenshots were retained locally before correction. History now follows
the primary controls, the existing viewport assertion remains intact, the test
explicitly saves before reload, and a deferred cross-project response case was
added. The final complete focused run passed all 25 cases. Physical devices,
screen readers, real customer media, full native release qualification and public
availability were not tested.

## Appearance reconciliation correction — 2026-10-22

Correction ID: `studio-export-freshness-appearance-20261022`.

Export and Activity now share one project/media-scoped saved-appearance comparison.
Opening either surface flushes any unfinished appearance save and waits for the
complete save lane before reading the saved look. Pending or failed reconciliation
leaves video, ASS, Studio data and bundle freshness unknown; plain caption formats
remain comparable. Expanded Export history provides appearance retry/repair for
every selected output, including plain SRT/VTT; ordinary downloads remain
available. Activity and styled-output checks retain their recovery paths. A response for a
different project or media cannot supply the comparison. Only appearance is
adopted into this separate comparison state; current caption drafts and the
parent project are never replaced. Returning to an earlier appearance compares
against that actual content again. Pre-render appearance revalidation and
immutable server render snapshots retain their existing authority.

The initial correction baseline used unchanged product head `94e2975`: 38/38
browser isolation/lifecycle guards passed. Four new cases reproduced dishonest
known freshness during a pending save, a failed saved-appearance read, a pending
read, and a response for replaced media. Two other failures were test setup
defects (hidden navigation while Export is open and caption blur committing the
draft), and do not establish product failures. The delayed-read case also had an
incomplete trace archive; the failure output and screenshot were retained.
Historical qualification above belongs to the original PR head and does not
qualify this correction. Focused deterministic reconciliation/save checks pass
12/12 and the web TypeScript check passes.

A separately frozen unchanged-head A→B→A baseline reproduced the original Activity
comparison failure after an actual Appearance control edit. Independent review
then identified a recovery gap in plain-caption mode. The pre-recovery baseline
reproduced a missing saved-appearance repair action. Two read-recovery cases
initially used a one-shot simulated failure that a legitimate second read could
supersede; these were fixture setup failures, retained and excluded from product
findings. After the fixture held failure until unknown was established, both SRT
and VTT downloaded successfully and then reproduced the missing history retry.

Final correction qualification on Windows/Node 24.21.0 passed both freshness
browser specs, 14/14 cases, with one worker, zero retries and 38/38 isolation/
lifecycle guards. This covers actual Appearance A→B→A edits, direct Activity,
pending/failed saves and reads, unsaved caption retention, project/media ownership,
plain SRT/VTT downloads, keyboard retry and appearance-save repair. Completed-video
jobs use immutable synthetic admission snapshots in these browser fixtures;
this run does not establish native rendering, receipt persistence, physical-device,
IME, live-service, release or public-download qualification. All failed attempts
remain retained separately from the final passing run.

Public impact: required for the source-development workflow/evidence correction.
README's existing source-only export-freshness description remains the public
entrypoint. The manifest's advertised export workflow and local-processing claim
remain accurate; version, release/download evidence, installation, brand and data
flow are unchanged. PRIVACY.md already describes the unchanged local receipts.
The existing proposed HQ export/review workflow evidence and Distribution
`/studio/` workflow documentation follow-up should include this correction when
their separate intake/synchronization plans are approved. No public availability
or cross-repository synchronization is established here.
