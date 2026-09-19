# Continue editing captions in another app

Status: unreleased source. This guide describes the local implementation; it does
not establish availability in a published download. Import guidance was checked
against the publishers' documentation on 19 September 2026.

## Start with your destination

Open **Export → Captions file** and choose where you will continue editing.
**Download SRT** is the default for CapCut Desktop, Premiere Pro, DaVinci Resolve,
and Final Cut Pro. Studio saves the current captions before preparing the file.
The export is stopped when newer caption edits or a different source media make
the prepared snapshot obsolete.

SRT transfers editable caption text and cue timing. Set the font, size, color,
placement and animation in the receiving editor. A successful subtitle import is
not a promise that Studio's current-word highlight will become native animation.

Timecodes are relative to **the source media's 0:00**. Use the same footage at the
same speed and verify the first and last captions after import. A timeline offset,
trim, speed change, or a different edit of the video may require retiming in the
receiving editor. No export silently moves neighboring captions to remove an
overlap. The panel calls out overlapping cue pairs, including the special concern
for Final Cut Pro caption validation.

## CapCut Desktop and mobile

On Desktop, open your project and use **Captions → Add Captions** to import the
UTF-8 SRT. The captions become editable text blocks. Check wording, timing and
wrapping, then choose the look in CapCut.

When the imported file appears as a subtitle asset, add it to the timeline aligned
with source 0:00 before editing the resulting captions.

CapCut's current official help says **mobile does not directly import subtitle
files**. Its documented route is to import SRT in CapCut Desktop or Web, save the
project, and use CapCut's project cloud sync to continue editing on mobile. The
same account and a supported sync feature are needed; availability can differ.
Studio only creates a local file. Choosing CapCut Web or cloud sync is a separate
action through CapCut's service and can upload project/caption data there.

Reference: [CapCut subtitle import guide](https://www.capcut.com/help/how-to-import-subtitles).

## Choose an advanced format only when needed

| Choice | What it carries | Practical limit |
| --- | --- | --- |
| SRT | Cue text and start/end timing | Recreate appearance and highlighting in the destination. |
| One word per caption (SRT) | Every ready word as its own timed cue | Changes grouping to one-word captions; not a full sentence with a moving highlight. |
| WebVTT | Escaped cue text and timing | Intended for web/player and other explicitly compatible importers. |
| One word per caption (VTT) | Separate word cues with their actual starts, ends and gaps | No inline-timestamp animation or destination highlight guarantee. |
| TTML | Plain timed-text XML with preserved line breaks | Generic TTML, not Apple iTT. Check the importer's supported profile and extension. |
| ASS | Styled render events using Studio's saved appearance and source video geometry | Advanced render reference for compatible tools; font availability and renderer behavior matter. |
| Studio caption data | Exact wording, cue/word times, review and lock fields, plus appearance reference | Studio's versioned JSON schema; not a native CapCut/Premiere/Resolve project. |
| Caption handoff kit | Several caption formats, Studio caption data, and a README | ZIP contains no video, audio or font files. The guide identifies omitted optional outputs. |

**Word files require every nonempty caption to have ready word timing.** Missing,
stale, estimated or review-needed tracks cannot silently be replaced by guessed
times or omitted words. **Review word timing** opens the first unresolved caption.
The complete wording, including punctuation and symbols outside a spoken span,
is assigned to the word fragments. Sentence spacing/line breaks may need cleanup
when a destination displays those fragments individually.

Styled ASS is available for video projects with readable source geometry. It uses
the same render-state planner as Studio's captioned video, including full-caption
color states for ready word highlights. One original caption can produce several
ASS events, and overlaps can share render events. It is therefore less convenient
for rewriting a sentence than SRT or Studio caption data. ASS uses centisecond
timing and may wrap differently with a different font or renderer. Fonts are
referenced by family name and never bundled by this export.

The ZIP includes the plain formats and caption-data backup. Ready word files and
styled ASS are included when their prerequisites allow them; its README explains
any omission. Invalid required caption text/timing fails export with an actionable
error instead of producing an apparently complete kit that drops captions.

## Preserve and restore Studio word timing

Choose **Advanced caption formats → Studio caption data** to preserve the caption
representation for later use in Studio or a future documented integration.
The file contains no source-media names/paths, project title, project/caption/word
identifiers, transcript, context, API keys, history, correction memory or account
credentials. It does contain the caption text you explicitly export, its timing,
word spans and review/lock metadata, and an optional appearance reference.

To restore, open the intended source project, choose **Restore Studio caption
data…**, and select the JSON file. Review its caption count, time span, sample
text and warnings. **Keep current captions** discards the preview; **Replace
captions** explicitly applies it. A History checkpoint is created first.

Restore replaces captions only. The source media and current appearance remain
unchanged. Imported captions receive new local identities and are marked
unapproved; the file's word timings and applicable locks remain represented.
Existing locked captions block replacement until they are explicitly unlocked.
Active processing and newer edits/media also block a stale replacement. Imported
caption data is not treated as a new human correction or Contributor evidence.

The file cannot prove which source video it belongs to because it deliberately
contains no source identity. Verify that the selected footage and speed match.
The importer checks bounds against the current local source duration; it does not
stretch the imported timings to fit a different clip.

Out-of-order caption data is sorted chronologically in the preview, with a
warning, and the same reviewed order is applied. A differing saved source duration
is also disclosed; it does not trigger automatic retiming.

## Format validation

Plain subtitle files use UTF-8 and millisecond timestamps. Fractional source
milliseconds are rounded only for these derivatives; intervals that would collapse
are rejected. Studio caption data retains finite fractional times exactly.
Blank first/interior/last cue lines cannot be safely preserved in SRT/WebVTT and
are rejected with a path to TTML or caption data; text is never silently dropped.
WebVTT/XML text is escaped so creator wording cannot become control markup.

Caption data requires `kind: "sthang-caption-data"` and `version: 1`, with bounded
cue/word counts, a 4 MiB file limit, valid Unicode and timing, explicit field
allowlists, and grapheme-safe exact-text word offsets. Unsupported versions and
malformed/stale tracks fail validation. Valid partial/null word timing stays
partial; a file does not automatically certify speech alignment.

## Compatibility evidence

### Local CapCut Desktop check

A synthetic SRT generated by this implementation was imported through **Captions
→ Add captions** in the installed CapCut Desktop **9.4.0.4015** on Windows. Adding
the subtitle asset at source zero produced two editable timeline blocks containing
Khmer/Latin caption text. The second caption was changed to “Edited in CapCut” in
CapCut's own caption editor and the change appeared in the video preview.

The same local check imported a styled ASS containing four full-caption word-color
states. CapCut accepted the file and produced four repeated caption blocks, but
the intended word colors were not retained at the two sampled spoken-word times.
This supports keeping SRT as the clean editable default and avoiding a claim of
native word-highlight transfer just because an editor accepts ASS.

The check used generated local media and no sign-in, subscription, user source
media or cloud project sync. CapCut mobile, Premiere, Final Cut Pro and Resolve
were not executed as part of this local import check.

### Documented import paths

These are documented import paths, not an assertion that every version of every
editor has been exercised with these files:

- [CapCut Desktop/Web/mobile guidance](https://www.capcut.com/help/how-to-import-subtitles):
  Desktop SRT/TXT, Web SRT, mobile through the documented synced-project route.
- [Premiere caption formats](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/supported-file-formats-for-captions.html):
  SRT is the default handoff here; compatible timed-text XML is an advanced path.
  Some importers expect a `.xml` extension for TTML rather than `.ttml`.
- [Final Cut caption import](https://support.apple.com/guide/final-cut-pro/import-closed-captions-ver4185ef95a/mac):
  SRT is supported; its iTT support does not imply generic TTML support. Choose
  media-relative placement appropriately and resolve overlaps.
- [DaVinci Resolve training](https://www.blackmagicdesign.com/products/davinciresolve/training):
  use its documented SRT subtitle-track workflow.
- [WebVTT specification](https://www.w3.org/TR/webvtt1/) and
  [TTML specification](https://www.w3.org/TR/ttml2/) describe their respective
  interchange syntax; syntax support alone is not a styling/animation guarantee.
- [ASS tag documentation](https://aegisub.org/docs/latest/ass_tags/) describes the
  rich subtitle features consumed by compatible subtitle renderers.

For final visual appearance, use Studio's captioned MP4 export. That bakes the
effect into the picture and is a different tradeoff from editable subtitle files.
