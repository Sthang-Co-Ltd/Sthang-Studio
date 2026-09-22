# Fine Timing and spoken-word highlights

Status: source implementation, unreleased. The existing `0.85.4` release identity
and download/update evidence do not establish availability of these changes.

## Choose the timing you need to change

Open **Fine timing** below the source player. Select a caption in the list or use
**Previous** and **Next**. The waveform focuses around that caption even in a
long recording. **Focus caption**, **Full clip**, and zoom controls switch between
orientation and close editing. Clicking the audio moves the playhead; it does not
change the caption.

**Caption edges** edits when the entire caption appears and disappears.
**Word timing** edits the words inside that caption. These are separate levels:
changing one word does not move the entire sentence, and trimming a sentence does
not stretch its internal word timings.

## Caption edges and neighboring captions

Drag the caption bar's left/right handle to change Start/End. Drag its middle or
use **Move earlier / Move later** to shift the caption while preserving its
duration. Owned word timings move by the same amount. A drag previews locally and
commits once on release; **Escape**, pointer cancellation, or lost pointer capture
cancels the unfinished gesture.

The **− / +** controls use the selected **10**, **50**, or **100 ms** step. Start
and End also accept seconds (`12.375`), `m:ss.mmm`, or `h:mm:ss.mmm`, with one to
three fractional digits. **Enter** or blur commits valid input; **Escape** restores
the accepted value. Invalid text stays uncommitted and explains the required
range. **Set to playhead** is available only at a legal position for that edge.
Selecting another caption or word clears the previous selection's unfinished
timestamp draft, including when the two selections have identical times.

Neighbor protection is on by default: moves and trims stop before creating or
increasing an overlap with another caption. Existing overlaps can be repaired
gradually without a surprise jump. No later caption is silently pushed along.

Under **Snapping, playback speed and display**:

- **Allow overlaps** permits an intentional independent overlap or crossing.
  The list/save order remains chronological and the overlap is shown.
- **Move adjoining edge too** makes an edge edit a shared transition: Start also
  changes the previous caption's End, or End also changes the next caption's
  Start. The two outer edges and all other captions stay put. A locked neighbor
  blocks the entire operation; Undo restores both captions together.

Caption intervals retain at least 40 ms and stay inside the source. That is a
technical minimum, not a recommendation for comfortable reading. Trimming across
an owned word marks its timing for review instead of compressing the word.

## Correct one word

Choose **Word timing**, then click a word chip or its bar above the caption bar.
The selected word has its own Start, End, **Hear word**, and movement controls.
Drag its edges to trim or its middle to move; other words and the caption's outer
edges stay in place. Word edits stop at neighboring word intervals and use 10 ms
precision, matching the native subtitle timing grid.

For example, when “I love you” is already synchronized but “very” is late in
“I love you very much”, select **very** and move just that word earlier. Replay
the full caption afterward to check the result.

The word bars represent this caption's editable, owned timings. **Show original
word estimates** optionally exposes older transcript reference marks in Caption
edges mode; those marks are not independently editable and do not move when a
caption is edited. The text printed inside the larger caption bar is a label,
not a spatial map of its words.

## Correct wording and sync it to speech

Correct the caption text first. Punctuation/spacing changes can preserve timing
when the same spoken units are provably retained. A spelling or lexical
replacement may retain a tentative interval with a review marker. Inserting,
deleting, splitting, merging, or ambiguously repeating words does not assign
timings by proportional distribution. Unchanged surrounding words are preserved
only where their correspondence is safe.

Merging overlapping captions preserves their full combined time span and the
retained word intervals. Overlapping word intervals still require review; the
merge does not invent a new speech sequence.

**Sync words** listens locally to the existing caption interval and a small
margin, aligning the exact current wording without rewriting it or calling
Gemini. The result is a proposal: inspect/listen, then choose **Use timing** or
**Keep current**. It can still contain uncertain words. A newer text, word,
caption-edge, lock, or media change invalidates an in-flight result. Applying a
candidate participates in Fine Timing undo and normal autosave/History.

For manual correction, adjust a tentative word and/or choose **Confirm this
word** after listening. An untimed word has editable local Start/End fields and
an explicit **Apply word timing** action; the offered available gap is not a
claimed alignment. **Set words manually** starts an untimed track when no usable
one exists. A phrase the speaker never said may not align meaningfully; correct
the wording or leave it plain rather than treating generated timestamps as fact.

If neighboring words or the caption edges leave less than 10 ms, the word editor
explains that there is no room and disables the impossible edit. Select a
neighboring word to make space, adjust the caption edges, or use **Sync words**
to review a new proposal. Other words are never moved automatically. Words marked
**Needs review** expose that status to screen readers as well as visually.
During a sync proposal, words remain selectable for inspection and listening;
choose **Use timing** or **Keep current** before making manual edits.

Sync is bounded to one active local word-sync operation and captions no longer
than 60 seconds/2,000 Unicode code points. Active caption processing must finish
first. Canceling the client discards its pending result; already-started local
alignment can finish cleanup before another sync is available.

Khmer word segmentation does not always match a reader's preferred lexical
division. A unit that cannot safely be separated without cutting a grapheme is
kept together. Timing a displayed word/unit does not promise syllable-level
highlighting. Text composition uses a stable edit basis so temporary unfinished
Khmer input does not progressively erase valid surrounding anchors.

## Enable spoken-word highlighting

Open **Appearance → Spoken word highlight**, turn it **On**, and choose a color.
The full caption stays visible. Only the currently timed word changes color;
pauses and the interval after the last word use the normal text color. There is
no cumulative fill, bouncing word, or syllable animation in this implementation.

Appearance shows how many captions have usable word timing and links directly to
the first one needing attention. Every spoken span in a caption must be ready for
that caption to highlight. Missing, stale, overlapping, out-of-range, estimated,
or review-needed timings leave the entire caption plain. Correcting the text
therefore cannot silently highlight the wrong old word.

Native preview and captioned MP4 consume the same word intervals, whole-text
layout, and color states. **SRT has no word-highlight or per-word timing metadata**;
the destination editor controls SRT styling. Export lists any captions that will
remain plain. Per-word tracks and highlight settings remain local and are not
added to Contributor or analytics payloads.

## Listen, undo, and recover

**Replay caption** includes a 120 ms margin on each side. **Hear start / Hear end**
plays 500 ms around a caption edge; **Hear word** uses 120 ms around that word.
**Loop** repeats the chosen audition. Editing, selecting another caption, seeking
through Studio, changing workspace/project/media, or stopping ends that audition.
Speed is under the secondary options. Check the result at normal speed even
when a slower pass helps locate a boundary.

The source player remains visible while timing controls scroll on desktop and
narrow layouts. Timing locks block caption/word edits and sync but preserve
playback. Numeric edits can still work if the waveform preview fails and source
duration is available. Rebuild waveform retries the audio preview independently.

**Undo / Redo** retains up to 50 Fine Timing transactions while the workspace is
open, including word edits, applied sync candidates, and shared edges. It cannot
overwrite intervening text/lock/approval edits. Closing the workspace clears this
local stack; autosave and History remain persistent recovery paths. Text fields
keep their own text undo behavior.

**R** replays the caption. **Alt+Left/Right** moves the selected caption in Caption
edges mode or the selected word in Word timing mode. **Ctrl/Cmd+Z** and
**Ctrl/Cmd+Shift+Z** undo/redo timing outside text fields. These actions do not
enable Review auto-advance or move unrelated captions.

## Validation and public handoff

Relevant checks are `test:fine-timing`, `test:word-timing`, `test:video-export`,
`test:caption-renderer`, `test:browser`, `test:playback-grouping`, `test:performance`,
`typecheck`, and `build`. Automated fixtures use synthetic inputs and no paid AI.
Native tests exercise real Khmer shaping, highlight-state geometry, persistent
preview, and MP4 output. Local sync accuracy still depends on the speech and the
installed timing runtime; a successful fixture is not a universal accuracy claim.

Public impact: required. The source-only proposal
`studio-word-timing-highlights-20260919` extends the earlier Fine Timing work.
See [the public handoff](WORD-HIGHLIGHT-HANDOFF.md) for affected evidence and
downstream approvals. The governed current release manifest, verified download
claims, protected identity, services, and release approvals remain unchanged.
The subsequent [Fine Timing refinement handoff](FINE-TIMING-REFINEMENT-HANDOFF.md)
records selection-state, accessibility, and no-room recovery corrections.
