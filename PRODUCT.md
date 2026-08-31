# Sthang Studio product context

## Product

Sthang Studio is a short-form video finishing workspace. Its current flagship module, **Captions**, helps Khmer-speaking creators move from a CapCut export to accurate, locally aligned, reviewable captions and a CapCut-ready SRT.

## Primary users

- Cambodian TikTok and short-form creators.
- Many users are comfortable with CapCut but are not developers.
- Experience ranges from first-time caption-tool users to power users who need waveform timing, locks, correction memory, and regeneration diffs.

## Primary job

> Upload a video, generate accurate Khmer captions, quickly verify the few uncertain parts, and export an SRT without learning a professional subtitle application.

## Aha moment

The first captioned playback stays synchronized through the full video, with Khmer wording that is materially better than CapCut and an obvious path to correct any remaining issue.

## Core workflow

```text
Upload → optional accuracy context → generate → review flagged captions → export SRT
```

Everything else is secondary and should appear progressively, at the moment it becomes useful.

## Product principles

1. **Evidence stays visible.** Audio/video remains playable during any decision about text or timing.
2. **Safe by default.** Regeneration proposes; it never silently destroys reviewed work.
3. **Local where practical.** KFA/Whisper timing stays local and paid cloud timing remains a last resort.
4. **Reuse completed deterministic work.** Normalized/range audio, local acoustic evidence, exact timing results, and completed stages of the same resumable job should be reused when their signatures still match. A request for a fresh AI alternative must remain a fresh listen.
5. **Fast repeated review matters.** The first pass may perform necessary preparation; subsequent Improve, Deep Verify, exact realignment, waveform reopening, and job resume should avoid repeating unchanged work wherever accuracy and safeguards allow.
6. **Plain language.** Casual users should not need to understand `.env`, forced alignment, CPS, tokens, providers, model names, or timing infrastructure to succeed. Keep implementation names out of routine tooltips and primary workflow copy; disclose them only where setup or diagnostics genuinely require them.
7. **Power without intimidation.** Advanced controls remain available, but one focused tool is shown at a time.
8. **Errors explain recovery.** Messages name what failed and the exact next action.
9. **Khmer typography is first-class.** Do not apply English word-spacing assumptions to Khmer text.
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
- Analytics funnel measures such as project creation → generation → review/approval → successful SRT export, without collecting caption content.
