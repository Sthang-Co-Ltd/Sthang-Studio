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

## Success measures

- Time from first launch to first successful caption export.
- Percentage of videos completed without manual timestamp entry.
- Number of captions reviewed versus total captions.
- Repeat terminology errors after a correction rule is approved.
- Regeneration proposals accepted without losing locked work.
- Warm selected-range regeneration time versus the first pass on the same range.
- Deep Verify time with upload/emission reuse versus a cold run.
- Resume time after interruption when completed processing checkpoints are available.
