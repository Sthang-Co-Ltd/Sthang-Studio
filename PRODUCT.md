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
4. **Plain language.** Casual users should not need to understand `.env`, forced alignment, CPS, tokens, providers, model names, or timing infrastructure to succeed. Keep implementation names out of routine tooltips and primary workflow copy; disclose them only where setup or diagnostics genuinely require them.
5. **Power without intimidation.** Advanced controls remain available, but one focused tool is shown at a time.
6. **Errors explain recovery.** Messages name what failed and the exact next action.
7. **Khmer typography is first-class.** Do not apply English word-spacing assumptions to Khmer text.

## Success measures

- Time from first launch to first successful caption export.
- Percentage of videos completed without manual timestamp entry.
- Number of captions reviewed versus total captions.
- Repeat terminology errors after a correction rule is approved.
- Regeneration proposals accepted without losing locked work.
