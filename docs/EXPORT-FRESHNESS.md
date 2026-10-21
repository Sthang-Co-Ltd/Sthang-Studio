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
