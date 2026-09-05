# Sthang Studio product context

## Product

Sthang Studio is a short-form video finishing workspace. Its flagship **Captions**
module helps Khmer-speaking creators generate accurate wording, align it locally,
review difficult moments quickly, style finished captions against the real video,
and choose between a portable subtitle file or a finished captioned-video render.

The published release state is governed separately by release evidence. A feature
being present on `main` is not proof that it is available in the current public
download.

## Primary users

- Cambodian TikTok and short-form creators.
- Many users are comfortable with mainstream video editors but are not developers.
- Experience ranges from first-time caption-tool users to power users who need waveform timing, locks, correction memory, regeneration diffs, and quality-controlled export.

## Primary job

> Upload a video, generate accurate Khmer captions, quickly verify the few uncertain parts, optionally style the captions while watching the video, then export either editable timed captions or a finished captioned video without learning a professional subtitle application.

## Aha moment

The first captioned playback stays synchronized through the full video, with Khmer
wording that is materially better than generic caption tools and an obvious path
to correct any remaining issue. When the creator styles a finished captioned video,
the editor preview responds on the actual footage, that saved project appearance
remains visible while they continue reviewing, and the same layout and appearance
are preserved in the exported picture.

## Core workflow

```text
Upload → optional accuracy context → generate → review flagged captions → export
                                                ↘ Appearance (optional) ↗
                                                          ↳ SRT
                                                          ↳ Captioned video
```

Everything else is secondary and should appear progressively, at the moment it becomes useful.

## Caption appearance contract

Caption appearance is **project editing state**, not an export-only setting.
Creators may style captions before export while watching the real video evidence.

- Appearance is available as a focused editor workspace for video projects once
  captions exist to judge.
- The common path is deliberately small: preset, Khmer font, text color, size and
  position. Weight, outline, shadow, width, alignment and background styling stay
  progressively disclosed.
- The actual editor caption overlay reflects the current project appearance so the
  creator can judge it against their footage while styling **and** while moving
  through Review, Fine timing, Accuracy, Caption grouping, and Details. Appearance
  is where the look is edited; it is not a temporary visual mode.
- Preview/export **layout parity is a contract**. Studio uses the same deterministic
  Khmer-grapheme line plan for the editor and finished-video render, and derives
  preview size, maximum-width region and bottom position from the actual displayed
  video rectangle. A caption planned as one line must not unexpectedly become two
  lines after export, and the relative size/alignment/position must remain stable.
- Browser CSS and libass are different rasterizers, so tiny antialiasing or glyph-
  metric differences can remain. The **Layout-locked appearance preview** badge
  communicates that distinction without excusing changed line count or geometry.
- Project appearance saves automatically and survives leaving/reopening the
  workspace. Reusable presets remain local creator-profile conveniences.
- An unavailable saved font is preserved and disclosed; Studio must not silently
  change the creator's typography. Captioned-video rendering requires an available
  local export font when the saved choice cannot be honored.
- Appearance never changes SRT serialization, caption text/timing, locks,
  correction eligibility, correction memory, Review behavior, or source media.

## Export contract

Sthang Studio has two deliberately different output paths:

- **SRT** remains the portable, editable caption handoff. It contains caption text
  and timing; it does not promise visual-style transfer into another editor.
- **Captioned video** is a new local render with the saved project caption
  appearance baked into the picture. The source media is never overwritten, and
  captions are no longer separately editable inside the exported MP4.

For captioned-video export:

- Export focuses on output decisions. It shows a compact summary of the saved
  project appearance plus an **Edit appearance** path back to the editor; it does
  not duplicate the styling controls.
- Match-source is the recommended quality default.
- HD 720p, Full HD 1080p, QHD 1440p and 4K UHD 2160p must preserve source aspect
  ratio/orientation without implicit cropping; above-source output is labeled as
  upscaled rather than presented as recovered detail.
- Match-source frame rate is the default. Fixed 24/25/30/50/60 fps is an explicit
  conversion choice.
- Studio must probe real local encoder/filter/font capability rather than infer it
  from a GPU name or installed command.
- Khmer burned-in captions require the native ASS/libass path with **explicit
  complex shaping**. If the local FFmpeg runtime cannot expose that capability,
  Studio must block finished-video export rather than produce broken Khmer glyphs.
- Output is non-destructive: render to a partial file, verify it, then publish the
  final file atomically.
- Before a render starts, Studio re-reads the saved project appearance and uses an
  immutable snapshot of captions, appearance, export settings and source-media
  identity. Later caption or appearance edits do not mutate a running export.
- Video rendering has its own processing lane so a long 4K render does not block
  caption generation or regeneration. Media replacement/deletion remains blocked
  while an export uses that source.
- Long-running caption generation/regeneration and video export expose horizontal
  progress plus elapsed time. Completed work keeps the actual duration so creators
  can tell how long the operation took. Completed captioned-video exports expose
  an obvious **Download video** action and list Studio's fixed local exports folder
  so creators know where the verified MP4 is stored.
- Never silently crop, lower the chosen resolution/frame rate, drop source audio,
  flatten HDR, add a watermark, overwrite the original media, substitute a
  different caption font, change planned line count/geometry, or downgrade Khmer
  shaping without warning.
- HDR10, HLG, Dolby Vision and unknown HDR are blocked until the exact color path
  is validated. An honest block is preferable to a successful-looking export with
  damaged color.
- Release readiness requires representative real render validation, not only the
  browser appearance preview or type/build checks. At least one mixed
  Khmer-English regression sample must confirm correct shaping in the actual MP4,
  and one-line/multi-line samples must confirm preview/export layout parity.

## Product principles

1. **Evidence stays visible.** Audio/video remains playable during any decision about text, timing, or caption appearance.
2. **Safe by default.** Regeneration proposes; it never silently destroys reviewed work.
3. **Local where practical.** KFA/Whisper timing and finished video rendering stay local; paid cloud timing remains a last resort.
4. **Reuse completed deterministic work.** Normalized/range audio, local acoustic evidence, exact timing results, and completed stages of the same resumable job should be reused when their signatures still match. A request for a fresh AI alternative must remain a fresh listen.
5. **Fast repeated review matters.** The first pass may perform necessary preparation; subsequent Improve, Deep Verify, exact realignment, waveform reopening, and job resume should avoid repeating unchanged work wherever accuracy and safeguards allow.
6. **Plain language.** Casual users should not need to understand `.env`, forced alignment, CPS, tokens, providers, model names, or timing infrastructure to succeed. Keep implementation names out of routine tooltips and primary workflow copy; disclose them only where setup or diagnostics genuinely require them.
7. **Power without intimidation.** Advanced controls remain available, but one focused tool is shown at a time.
8. **Errors explain recovery.** Messages name what failed, what remains safe, and the exact next action.
9. **Khmer typography is first-class.** Do not apply English word-spacing assumptions to Khmer text; render-only wrapping must respect Khmer grapheme boundaries and final rendering must use complex-script shaping.
10. **Updates never compete with caption work.** Check at most once per Studio
    session plus an explicit manual action, require confirmation before download
    and install, and block activation while editing, Review, regeneration, export,
    or background processing is unsafe to interrupt.
11. **Private unless a creator deliberately contributes.** Caption/audio contribution
    is off by default. Khmer Caption Contributor is an explicit, reversible choice
    that applies only to eligible corrections made after joining; declining never
    reduces caption quality or removes local correction learning.
12. **Verified means verified.** A contributed edit is only candidate evidence until
    corpus QA accepts it. Studio must never inflate contributor progress by calling
    a successful upload a verified correction.
13. **Analytics cannot become content collection.** Optional product analytics is a
    separate explicit choice and is limited to a server-owned event/property
    allow-list. Caption text, media, filenames, project names, context, exports,
    API keys, and Contributor identity never belong in analytics.
14. **Cloud improvement paths fail open for creators.** Contribution/analytics
    outages never block generation, Review, editing, saving, export, or local
    correction memory. Studio remains useful when either service is absent.
15. **Technical export quality is a product promise.** A creator choosing Studio's
    finished-video path should not accept a hidden resolution, timing, audio, color,
    aspect-ratio, Khmer-shaping, layout, or caption-appearance downgrade. Creative
    NLE features remain out of scope unless they directly improve the caption workflow.

## Khmer Caption Contributor

The long-term purpose of Khmer Caption Contributor is to turn high-quality,
consented corrections from real creator workflows into evidence that can improve
Khmer caption technology. The program should help Sthang identify recurring
Khmer speech/transcription errors, build real-world evaluation sets, improve
correction/vocabulary intelligence, compare future models, and eventually prepare
verified training examples where that is justified.

The program has exactly two caption-data states:

```text
Private (default) ↔ Khmer Caption Contributor (explicit opt-in)
```

Contributor onboarding belongs after Studio has already delivered value, such as
a successful export, rather than before first use. The invitation may celebrate
the collective goal of better Khmer caption technology, but it must not shame,
penalize, or repeatedly pressure creators who keep their work private.

There is one migration-only exception: when an installation with evidence of
pre-v0.8 Studio use first runs a version that introduces Contributor, and the
Contributor choice is still unset, Studio may show one dismissible startup
explanation because that creator used the product before this data choice existed.
Fresh installations still use the post-export invitation. Closing or reviewing
the migration notice is not consent, and product analytics remains a separate,
default-off decision. The migration notice is recorded locally so it is not shown
again on every launch; if Contributor remains unset, the normal post-export
invitation may still appear in a later session.

An eligible contribution must trace back to generated wording, contain a material
human correction made after consent, and reach an approval decision. Formatting-
only edits and manually-authored starting captions are excluded. Only the bounded
matching audio clip and the minimum correction/model/timing evidence needed for
quality work may be contributed; the full project/video and unrelated context are
not part of the corpus protocol.

Contributor progress can recognize meaningful participation — for example,
verified correction count and verified Khmer speech duration — without public
leaderboards. Quantity incentives must never encourage fabricated/noisy edits.

## Success measures

- Time from first launch to first successful caption export.
- Percentage of videos completed without manual timestamp entry.
- Number of captions reviewed versus total captions.
- Repeat terminology errors after a correction rule is approved.
- Regeneration proposals accepted without losing locked work.
- Warm selected-range regeneration time versus the first pass on the same range.
- Deep Verify time with upload/emission reuse versus a cold run.
- Resume time after interruption when completed processing checkpoints are available.
- Human correction rate on a stable real-world Khmer evaluation set across Studio/model versions.
- Number and duration of **verified** Khmer contribution samples, kept distinct from submitted candidates.
- Percentage of Contributor uploads rejected as noisy/ambiguous evidence; quality should improve before volume is optimized.
- Contributor withdrawal/deletion requests completed without affecting local projects.
- Analytics funnel measures such as project creation → generation → review/approval → successful export, without collecting caption content.
- Captioned-video render success rate by source resolution/codec/frame-rate class without collecting filenames or content.
- Preview/export line-count and layout parity on a stable caption appearance regression set.
- User-visible caption-generation and export duration, derived from persisted job timestamps rather than analytics-only timing buckets.
- Post-render verification failures, cancellations, and resumptions, using only coarse allow-listed operational buckets if analytics consent is granted.
