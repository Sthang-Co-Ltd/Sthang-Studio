# Sthang Studio v0.7.5 frontend audit

## Scope and method

This was a code-and-screenshot audit of the v0.7.4 Captions frontend using the Impeccable 4.1.1 audit, distill, onboarding, and craft-floor criteria. It is not a substitute for a moderated usability test with new users.

## Audit health score

### Before this pass

| Dimension | Score | Key finding |
|---|---:|---|
| Accessibility | 2/4 | Very small helper text, inconsistent focus treatment, small controls |
| Performance | 3/4 | Generally lean, but dense always-mounted work surfaces increased render complexity |
| Responsive design | 2/4 | Narrow layouts converted labeled controls into unexplained icon-only buttons |
| Theming | 2/4 | Strong identity, but many hard-coded UI values and inconsistent browser surfaces |
| Implementation integrity | 2/4 | Product-specific foundation, but toolbar and stacked-card complexity obscured the main task |
| **Total** | **11/20** | **Acceptable — significant UX work needed** |

### After implemented fixes

| Dimension | Score | Key finding |
|---|---:|---|
| Accessibility | 3/4 | Focus system, labels, larger type/targets, calmer states |
| Performance | 3/4 | One advanced workspace is rendered at a time; no new dependency |
| Responsive design | 3/4 | Labeled core actions remain visible and the tools menu adapts to narrow screens |
| Theming | 3/4 | Added semantic surface/text tokens and themed browser interaction states |
| Implementation integrity | 3/4 | Core workflow is visually dominant; specialist tools remain available progressively |
| **Total** | **15/20** | **Good — validate on real devices and continue polishing** |

## Implementation integrity verdict

**Pass.** The application now expresses a coherent, product-specific workflow: video evidence and captions remain persistent, while specialist review, timing, terminology, style, and diagnostics are opened intentionally. The Sthang Studio identity and approved SVG system remain untouched.

## Major findings and fixes

### [P1] Header action overload

**Impact:** A first-time user faced ten similarly weighted controls before understanding the primary task.

**Fix:** Reduced the persistent project header to **Review, Tools, Save, Export SRT**. Correct, History, Jobs, Corrections, Replace, Guide, and Settings are grouped in a labeled Tools menu with descriptions and status counts.

### [P1] Every advanced panel was visible at once

**Impact:** Waveform, QA, context, timing details, and style controls competed with the actual video and captions.

**Fix:** Added a focused workspace switcher. Only one of Review, Fine timing, Accuracy, Caption style, or Details renders at a time. All are optional; the default remains the video and caption list.

### [P1] Caption rows exposed too many specialist actions

**Impact:** Eight hover controls per row were hard to discover, easy to misclick, and visually noisy.

**Fix:** Kept Approve visible and moved locks, nudges, split, merge, and delete into a labeled per-caption menu. Destructive actions are separated and clearly named.

### [P1] Tiny operational text and controls

**Impact:** Several labels were 7.5–10px and difficult to read, particularly at Windows display scaling.

**Fix:** Raised operational font sizes and target heights, added a global focus-visible system, labeled time/text fields, and preserved text labels at responsive breakpoints.

### [P2] Risk-chip alarm fatigue

**Impact:** Multiple yellow chips on every row made the interface look as though everything was wrong.

**Fix:** Unselected rows show one calm “Review suggested” summary. Detailed reasons appear when the caption is selected.

### [P2] Overlapping status messages

**Impact:** Busy, job, error, and notice elements shared fixed coordinates and could cover one another.

**Fix:** Added one ordered toast stack with dismissible error and notice messages.

### [P2] Floating recent projects and setup messages

**Impact:** Fixed-position UI could overlap the upload area or other messages.

**Fix:** Recent projects and setup/status guidance now participate in page flow.

### [P2] Interruptive utility modals

**Impact:** Large centered dialogs obscured the working context.

**Fix:** Utility surfaces now present as consistent right-side sheets. Regeneration remains a non-blocking dock beside the video evidence.

### [P3] Intimidating terminology

**Impact:** “System Doctor” and infrastructure-heavy primary copy felt developer-oriented.

**Fix:** Renamed the visible surface to **System check**, shortened the main generation copy, and moved technical details into the Details workspace.

## Positive findings retained

- Stable caption-list follow behavior with explicit Current and Follow controls.
- Non-destructive regeneration with live Current/Proposed video preview.
- Local KFA timing and honest AI-accuracy fallbacks.
- Caption locks, correction memory, project history, and resumable jobs.
- Approved Sthang Studio logo assets and strong dark/lime product identity.
- Slim custom scrollbars and Khmer-aware text handling.

## Remaining validation

1. Run a first-use test with at least three people who have never opened Sthang Studio.
2. Test Windows display scaling at 100%, 125%, and 150%.
3. Test keyboard-only completion of upload → generate → review → export.
4. Run an automated browser accessibility scan once a full local build is available.
5. Re-run the audit after the next visual inspection round.

## v0.7.10 follow-up — review playback and microcopy

This follow-up applies the same Impeccable audit/distill/onboarding/craft-floor principles used in the v0.7.5 pass to the v0.7.9 Review workflow.

### [P1] Repeated context made correction feel slow

**Impact:** Review loops replayed the configured pre-roll and post-roll every time. That was helpful on first exposure, but during repeated text/timing edits it forced users to wait through neighboring speech before hearing the caption they were actively correcting.

**Fix:** New review items keep one context pass. Subsequent loops and Replay use a tight focus pass (maximum 140 ms lead-in / 120 ms tail). Committing text or timing edits replays the focused caption immediately. Advanced Review keeps **Play with context** for deliberate surrounding-audio checks.

### [P2] Tooltips exposed implementation instead of intent

**Impact:** Hover help and beginner-facing microcopy sometimes named the transcription/alignment stack, which made routine controls feel more technical than the task required.

**Fix:** Tooltips are now short and action-oriented. Primary setup, waveform recovery, timing quality help, and regeneration help describe outcomes rather than providers/aligners. Technical provider/model details remain only in AI connection, Details, and diagnostics where they are actionable.

### Validation target

1. Enter Review and confirm the first pass includes normal context.
2. Let it loop and confirm the next pass starts almost immediately at the selected caption.
3. Press Replay and confirm it uses the tight focus pass.
4. Use Play with context and confirm the longer context pass returns once.
5. Edit text or timing, commit the field, and confirm immediate focused replay.
6. Hover normal editor controls and confirm no tooltip names KFA, Gemini, Whisper, model IDs, or backend/runtime architecture.
