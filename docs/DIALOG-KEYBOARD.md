# Dialog keyboard consistency — tracker 8

Settings, Find & Correct and Updates now use the same focus handler as Activity,
History, Correction Inbox, media replacement/recovery and Studio confirmations.
The privacy introduction/review uses that shared handler while preserving its
existing consent and dismissal behavior. This source change restores the existing
accessibility contract; it does not introduce a release-availability claim.

On opening, Find focuses its search field, ordinary sheets focus their first
available control, confirmations retain their safe default decision, and Updates
and the privacy introduction focus the dialog root. The latter avoids losing
focus when a check disables the close button and avoids preselecting consent.
Tab/Shift+Tab wrap over visible enabled tabbable controls; a dialog without such
controls retains root focus. Programmatic outside focus returns to the top dialog.
Escape dismisses only that dialog, subject to its existing busy guard. Composition
events and field-handled keys are preserved. Closing restores a connected opener;
if the parent simultaneously leaves a busy state, its existing safe focus default
takes precedence (for example, Cancel in media replacement).
editor shortcuts remain isolated even during focus transitions. Native browser
confirmation dialogs and consent/update authority are unchanged.

Public impact: none. This repairs keyboard/focus behavior already required by
PRODUCT.md and DESIGN.md. The product manifest's advertised features, installation,
compatibility, source/download/release claims, identity and privacy/security/data
transfer boundaries are unchanged. No HQ intake or Distribution synchronization
is required for these source corrections. No release or deployment is performed.

Validation: 58/58 focused browser cases and 38/38 isolation/lifecycle guards passed
on Windows/Node 24.21.0 with one worker and zero retries. Coverage includes all
product sheets, keyboard-opened Find, synthetic composition Escape, native select
arrows, fast/deferred Updates, unchanged privacy consents, existing video preset
confirmations and replacement safeguards, and nested destructive cancellation.
22 deterministic privacy/replacement/web tests, typecheck, production build,
brand, manifest, service configuration, public-readiness and whitespace passed.
Desktop Settings and emulated mobile privacy focus captures were inspected; the
component detector returned no findings. Physical-device/OS IME, screen readers,
other browser engines, independent review and public-release runtime were not tested.

Retained earlier evidence: one diagnostic run passed 22/23 but its update mock did
not cover the actual `/api/updates` status endpoint; it is not qualification.
The first expanded run passed 57/58 and exposed initial focus loss when checking
disabled Updates' close button. Updates now uses stable root focus, with before/
after deferred-response checks. A second 57/58 run exposed a new test's incorrect
Continue-return expectation during nested busy cancellation: the existing parent
deliberately restores safe Cancel. The test now requires that safe default, both
Escape boundaries and no replacement submission. The final 58/58 run was made
after rebuilding the shared package from this branch through `test:browser`.
