# Bulk correction preview — tracker 6

Change ID: `studio-bulk-correction-preview-20261021`.

Source-only: Tools → Correct everywhere shows Before/After text for every matching
caption, with 30-caption preview pages. The same replacement plan supplies Apply;
locked captions stay unchanged, changed captions become unapproved, and existing
undo/save/word reconciliation paths remain in control. Regex replacement strings
retain the existing JavaScript capture-substitution behavior. An empty replacement
is shown as empty caption text. Cancel makes no edit. This feature makes no model
request and adds no storage or data transfer.

Public impact: required for the new visible correction preview. Product-owned
evidence is README.md, PRODUCT.md and DESIGN.md. The verified release manifest,
version and download claims remain unchanged. Proposed maintainer follow-up: HQ
Studio feature/workflow evidence for bulk corrections, then Distribution `/studio/`
documentation describing Before/After and protected captions. Exact HQ intake and
Distribution plan digests and approval classes must be reviewed separately before
cross-repository writes. No release, website synchronization or deployment is
authorized by this source change.

Validation: 8 replacement-plan tests, 12 existing web/typography tests, 10 focused
browser regressions and 38 browser isolation/lifecycle guards passed locally on
Windows with Node 24.21.0. Typecheck, production build, brand, product manifest,
service configuration, public-readiness and whitespace checks passed. Desktop
1440×1000 and emulated mobile 390×844 captures were inspected. Real-device touch,
assistive technology and public-release availability were not tested. This is a
primary-agent review; no independent reviewer was used.
