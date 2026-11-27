# Khmer Interface Glossary and Style Guide

## 1. Purpose and scope

This document fixes the terminology, tone, punctuation, and orthography for Sthang Studio's **Khmer interface (`km`)** in `apps/web/src/i18n/messages/km/`.

- **Interface copy only:** These rules govern menus, buttons, dialogs, hints, review reasons, setup guidance, and status messages.
- **Never caption output:** Interface localisation does not change user-authored captions, generated Khmer transcripts, SRT exports, rendered video appearance, or project data.
- **Brand and honesty invariants still apply:** Keep `StudioBrand` and approved brand lockups untouched, and translate privacy, storage, recovery, and capability claims accurately without strengthening or weakening them.

---

## 2. Conventions

### Register, pronouns, and buttons
- **Register:** Everyday modern digital Khmer — polite, direct, and easy to scan for Cambodian short-form creators (similar to modern Cambodian consumer apps and Khmer CapCut/YouTube tutorials). Avoid stiff ministerial phrasing (`សូមមេត្តាអនុវត្ត`, `ធ្វើសមកាលកម្ម`) and overly casual slang or age-assuming pronouns (`បង`, `អូន`, `ឯង`).
- **Pronouns:** Drop the pronoun by default in buttons, headings, tooltips, and short instructions. Use **`អ្នក`** only where possession or agency genuinely needs it (e.g., privacy disclosures, your key, your video, your edits). Never use `លោក/លោកស្រី`.
- **Buttons:** Use bare, direct action verbs (verb or verb + object) with **no `សូម`**. Use `សូម` sparingly in polite recovery prompts or error instructions (`សូមព្យាយាមម្ដងទៀត។`).
- **Honesty:** Translate claims faithfully. Preserve distinctions such as *uploaded* vs *verified*, *checked* vs *verified*, *no autoplay*, local service key handling, OS secure-storage scope, and exact setup prerequisites.

### Digits and dates
- **Digits:** Use **Western (Arabic) digits (`0–9`) everywhere** — timestamps (`00:00.000`), counts (`នៅសល់ 2 ឃ្លាត្រូវពិនិត្យ`), durations (`2.5 វិនាទី`), resolutions (`1080p`), percentages, and dates. Never use Khmer digits (`០–៩`) in UI templates. (Timestamp inputs continue to accept typed Khmer digits and normalise them on commit.)
- **Dates and times (for later phases):**
  - Always use **Day Month Year** order (never `MM/DD/YYYY`): `កែសម្រួល 22 វិច្ឆិកា 2026`.
  - With time, use 24-hour clock: `កែសម្រួល 22 វិច្ឆិកា 2026 · 14:30`.
  - Never abbreviate Khmer month names; use the 12 full names: `មករា`, `កុម្ភៈ`, `មីនា`, `មេសា`, `ឧសភា`, `មិថុនា`, `កក្កដា`, `សីហា`, `កញ្ញា`, `តុលា`, `វិច្ឆិកា`, `ធ្នូ`.
  - In ultra-tight layouts, use numeric `DD/MM/YYYY` (`22/11/2026`).

### Punctuation
- **`។` (*khan*):** Use only at the end of full sentences (corresponding to English strings ending with `.`). **Never** place `។` on buttons, headings, menu items, chips, tooltips that are fragments, or short status fragments. Put no space before `។` and one space after `។` before a following sentence.
- **`៖` (*camnuc pii kuuh*):** Use in Khmer prose labels that introduce an explanation or list (`ណែនាំ៖ ...`, `ពីខាងឆ្វេង៖ ...`), with no space before `៖` and one space after.
- **ASCII `:`:** Keep strictly in timestamps (`00:00.000`, `m:ss`, `h:mm:ss`), aspect ratios (`9:16`), and 24-hour times (`14:30`).
- **Guillemets `«…»`:** Use around quoted terms, button names in prose, and user values (`«{canonical}»`, `«{title}»`), with no inner spaces.
- **Ellipsis `…`:** Use the single Unicode character `…` (`U+2026`) with no preceding space (`កំពុងរក្សាទុក…`, `កែលម្អ…`).
- **Repetition mark `ៗ`:** Write attached with no preceding space (`ពាក្យសំខាន់ៗ`, `ថ្មីៗ`, `ដដែលៗ`) so it cannot wrap orphaned onto a new line.

### Mixed-language text and Latin tokens
- **Keep in Latin, untranslated:**
  - Products, services, and scripts/files: `Sthang Studio`, `Studio`, `CapCut`, `TikTok`, `Gemini`, `Google`, `Google AI Studio`, `Python`, `Install Sthang Studio.bat`, `setup-local-timing-windows.bat`, `bash ./setup-local-timing-macos.sh`, `apps/server/.env`, model names (`Gemini 3.8 Flash`, `3.6 Flash`, `3.7 Flash`, `Gemini 4 Hydrogen`, `Gemini Transcribe`).
  - Formats and units: `SRT`, `MP4`, `MOV`, `MP3`, `WAV`, `AI`, `API`, `HD`, `4K`, `1080p`, `720p`, `fps`, `ms`, `MB`, `GB`, `QR`, `m:ss`, `h:mm:ss`.
  - Keyboard keys and symbols: `Enter`, `A`, `R`, `S`, `E`, `J`, `Alt`, `Ctrl`, `Shift`, `Esc`, `Tab`, `Space`, `↑/↓`, `←/→`.
- **Spacing:** Put **one ASCII space** before and after embedded Latin words and Western numbers inside Khmer text. Exceptions: immediately before `។`, `)`, `»`, `,`, `៖`, `?`, or `…`, or immediately after `(` or `«`.
- **Word order:** Follow head-initial Khmer grammar (`ឯកសារ SRT`, `វីដេអូ MP4`, `កូនសោ API`, `2 ជួរ`, `អក្សររត់ {count} ឃ្លា`).
- **Plurals:** Khmer has no grammatical plural. For every English `{ one, other }` plural key, provide **only** `{ other: "…" }`.

### Orthography
- **Normalise coeng-ដ (`្ដ`, `U+17D2` + `U+178A`):** Always use coeng-ដ (not `្ត`) in standard dictionary spellings across the entire catalog:
  - `ម្ដង`, `ប្ដូរ` (`ផ្លាស់ប្ដូរ`, `ប្ដូរឈ្មោះ`), `ចាប់ផ្ដើម` (`ផ្ដើម`), `សេចក្ដី`, `ផ្ដល់`, `ស្ដាប់`, `ស្ដាំ`, `ស្ដារ`, `ផ្ដោត`, `បណ្ដោះអាសន្ន`, `ក្ដារ` (`ក្ដារតម្បៀតខ្ទាស់`).
- **Spell `សំឡេង` with `ឡ`:** Never use `សំលេង`.
- **No zero-width spaces (`U+200B`):** Rely on `<html lang="km">` dictionary line breaking instead of inserting ZWSP into catalog strings.

### Typography already enforced in code
The web app already implements the Khmer UI typography layer separately from caption rendering and the protected brand lockup:
- **Local bundled fonts (`apps/web/src/interface-fonts.css`):** Bundles variable `Plus Jakarta Sans` and `Noto Sans Khmer` (`@fontsource-variable/*`) locally so offline Windows installs do not fall back to small system fonts such as `DaunPenh`.
- **Dynamic document language (`apps/web/src/App.tsx`):** Sets `document.documentElement.lang = interfaceLanguage` so Chromium/Edge engages ICU Khmer dictionary line breaking under `km`.
- **Scoped `html:lang(km)` metrics (`apps/web/src/interface-khmer.css` and `apps/web/src/i18n/language-controls.css`):**
  - Resets `letter-spacing: 0`, `text-transform: none`, `word-break: normal`, and `overflow-wrap: break-word` so split Khmer vowels/ligatures never detach and embedded Latin tokens (`CapCut`, `ms`) are never uppercased.
  - Uses `14px` (`line-height: 1.4`) for interactive controls/buttons and `14px` (`line-height: 1.55`) for body, dialogs, toasts, and review prose; `13px` (`line-height: 1.55`) for secondary/helper copy; and a `12px` (`line-height: 1.4`) floor for chips, review badges, and compact metadata.
  - Uses `height: auto; min-height: 38px` (`min-height: 44px` at `≤1199px`) on controls and reserves `min-width: 118px` on `.header-actions .save-action` so `រក្សាទុក` / `បានរក្សាទុក` stays width-stable.

---

## 3. Glossary

### Navigation, layout, and places

| English | Khmer | Note |
|---|---|---|
| Home | `ទំព័រដើម` | Universal Khmer UI standard. |
| All projects | `គម្រោងទាំងអស់` | Matches navigation and scope labels. |
| Recent projects | `គម្រោងថ្មីៗ` | Attached `ៗ`. |
| Project | `គម្រោង` | Standard across Khmer software UIs. |
| Project details | `ព័ត៌មានគម្រោង` | Natural phrasing ("project info") rather than stiff `សេចក្ដីលម្អិត`. |
| Rename project | `ប្ដូរឈ្មោះគម្រោង` | Coeng-ដ in `ប្ដូរ`. |
| Guide | `ការណែនាំ` | Avoid formal `មគ្គុទ្ទេសក៍`. |
| Updates | `បច្ចុប្បន្នភាព` | Standard menu label; verify with creators. |
| Settings | `ការកំណត់` | Universal across Khmer apps. |
| Preferences | `ចំណូលចិត្ត` | Used for user preferences service/loading notices. |
| System check | `ការពិនិត្យប្រព័ន្ធ` | Diagnostics tab in Settings (`បើកការពិនិត្យប្រព័ន្ធ`). |
| Tools | `ឧបករណ៍` | Project header menu trigger. |
| Activity | `សកម្មភាព` | Background jobs view (`ការងារកំពុងដំណើរការ` in subtitle). |
| History | `ប្រវត្តិ` | Restore checkpoints (`ស្ដារចំណុចរក្សាទុកមុន`). |
| Correction inbox | `ប្រអប់កែតម្រូវ` | Verify with creators against `បញ្ជីកែតម្រូវ`. |
| Correct everywhere | `កែគ្រប់កន្លែង` | Plain-language alternative to technical Find & Replace. |
| Technical details | `ព័ត៌មានបច្ចេកទេស` | Disclosure/tool label for timing and model info. |
| Arrange panels… | `រៀបចំផ្ទាំង…` | Single Unicode `…`. |
| Preview (panel) | `មើលជាមុន` | Panel header label. |
| Interface language | `ភាសាផ្ទាំងកម្មវិធី` | Distinguishes app UI language from caption text language. |

### Workflow stages and actions

| English | Khmer | Note |
|---|---|---|
| Captions / Caption | `អក្សររត់` | Primary term matching creator usage; use `ឃ្លា` / `ឃ្លានេះ` when counting or pointing to one cue row (`អក្សររត់ {count} ឃ្លា`). |
| Generate captions | `បង្កើតអក្សររត់` | Outcome-focused; avoids provider jargon. |
| Review | `ពិនិត្យ` | Stage tab and workspace name. |
| Appearance | `រូបរាង` | Styling stage; distinct from Look presets (`ម៉ូដអក្សរ`). |
| Export | `នាំចេញ` | Standard in Khmer editor UIs. |
| Save | `រក្សាទុក` | Bare verb, no `សូម`. |
| Saved | `បានរក្សាទុក` | Header Save button reserves width for this label. |
| Saving… | `កំពុងរក្សាទុក…` | Progressive form with `…`. |
| Unsaved changes | `មិនទាន់រក្សាទុក` | Compact status phrasing. |
| Cancel | `បោះបង់` | Standard dialog cancel action. |
| Dismiss | `បិទ` | Dismisses non-blocking cards/notices. |
| Undo | `ត្រឡប់វិញ` | Reverts approval or action. |
| Replace media | `ជំនួសវីដេអូ ឬសំឡេង` | Plain creator language instead of `មេឌៀ`. |

### Review, locking, and editing

| English | Khmer | Note |
|---|---|---|
| Review queue | `បញ្ជីត្រូវពិនិត្យ` | Panel heading when Review mode is active. |
| Needs review | `ត្រូវពិនិត្យ` | Calm, actionable status (`គួរពិនិត្យ` for *Review suggested*). |
| Flagged caption(s) | `អក្សររត់ដែលបានសម្គាល់` / `ឃ្លាដែលបានសម្គាល់` | Avoids repeating `ពិនិត្យ` alongside Review stage/verbs. |
| Approve | `យល់ព្រម` | Warm, compact verb; verify with creators against `អនុម័ត`. |
| Approved | `បានយល់ព្រម` | Paired consistently with `យល់ព្រម`. |
| Approve & next | `យល់ព្រម និងបន្ទាប់` | Stable far-right Review primary button. |
| Skip | `រំលង` | Advances without approving. |
| Previous | `មុន` | Compact navigation button beside `រំលង`. |
| Replay | `ចាក់ម្ដងទៀត` | Coeng-ដ in `ម្ដង`. |
| Play with context | `ចាក់ជាមួយផ្នែកជុំវិញ` | Describes surrounding speech; never use `បរិបទ`. |
| Tight loop | `ចាក់ដដែលៗត្រង់ឃ្លានេះ` | Attached `ៗ`; repeats tightly around current cue. |
| Auto-play next | `ចាក់ឃ្លាបន្ទាប់ស្វ័យប្រវត្តិ` | Review-only checkbox. |
| Review focus | `ការផ្ដោតពេលពិនិត្យ` | Coeng-ដ in `ផ្ដោត`; options: `ស៊ុមជ្រុង + ស្លាក`, `តែស៊ុមជ្រុង`, `បិទ`. |
| Review profile | `ទម្រង់ពិនិត្យ` | Profiles: `TikTok ខ្មែរ៖ លឿន`, `TikTok ខ្មែរ៖ ស្រួលអាន`, `CapCut SRT`, `ភាពងាយស្រួលអាន`. |
| Improve… | `កែលម្អ…` | Outcome-based phrasing; no internal AI provider names. |
| Lock text / Unlock text | `ចាក់សោអក្សរ` / `ដោះសោអក្សរ` | Concrete and concise. |
| Lock timing / Unlock timing | `ចាក់សោពេលវេលា` / `ដោះសោពេលវេលា` | Use `ពេលវេលា`, not `ម៉ោង`. |
| Fix safe timing | `កែពេលវេលាដោយសុវត្ថិភាព` | Review advanced timing fix button. |
| Split caption | `បំបែកឃ្លា` | Single-cue row action. |
| Merge with next | `បញ្ចូលជាមួយឃ្លាបន្ទាប់` | Single-cue row action. |
| Delete caption | `លុបឃ្លា` | Clarifies deleting one cue rather than all captions. |
| Current (playhead) | `បច្ចុប្បន្ន` | Jumps to the caption at the playhead. |
| Follow playback | `តាមការចាក់` | Keeps playing caption scrolled into view. |
| Compare captions | `ប្រៀបធៀបអក្សររត់` | Later phase (proposal comparison). |
| Keep current | `ទុកដដែល` | Later phase (proposal comparison). |
| Use proposed | `ប្រើសំណើថ្មី` | Later phase (proposal comparison). |
| Alternative take | `ជម្រើសផ្សេងទៀត` | Later phase; verify with creators. |

### Timing, accuracy, and grouping

| English | Khmer | Note |
|---|---|---|
| Khmer timing | `ការតម្រឹមពេលខ្មែរ` | Avoids `ពេលវេលាខ្មែរ` (which reads like Cambodia timezone). |
| Local timing | `ការតម្រឹមពេលលើម៉ាស៊ីន` | Aligns with `ការតម្រឹមពេលខ្មែរ`. |
| Fine timing | `កែពេលលម្អិត` | Tool strip label. |
| Caption edges | `គែមអក្សររត់` | Later phase (waveform workspace). |
| Word timing | `ពេលវេលាតាមពាក្យ` | Per-word timing adjustments. |
| Sync words | `តម្រឹមពាក្យ` | Later phase; avoid formal `ធ្វើសមកាលកម្ម`. |
| Allow overlaps | `អនុញ្ញាតឱ្យជាន់ពេល` | Phase B term for the waveform checkbox. Until Phase B translates that checkbox, `editor.captions.timingNeighbor` quotes the visible English label «Allow overlaps»; switch it to the Khmer term in the same change that translates the checkbox. |
| Accuracy | `ភាពត្រឹមត្រូវ` | Tool strip and unsaved status label. |
| Accuracy context | `ព័ត៌មានបង្កើនភាពត្រឹមត្រូវ` | Avoids abstract `បរិបទ`. |
| Key terms | `ពាក្យសំខាន់ៗ` | Attached `ៗ`; friendlier than `ពាក្យគន្លឹះ`. |
| This project (scope) | `គម្រោងនេះ` | Later phase (Accuracy / Key terms). |
| Caption grouping | `ការរៀបចំឃ្លា` | Conveys text structure, not visual styling; verify with creators. |
| Word highlighting | `បន្លិចពាក្យ` | Later phase (Appearance). |
| Motion | `ចលនា` | Later phase (Appearance). |
| Look (style preset) | `ម៉ូដអក្សរ` | Later phase; distinct from *Appearance* (`រូបរាង`); verify with creators. |
| Saved presets | `គំរូដែលបានរក្សាទុក` | Later phase; verify with creators. |
| Waveform | `រលកសំឡេង` | Later phase; spell `សំឡេង` with `ឡ`. |
| Timeline | `បន្ទាត់ពេលវេលា` | Later phase; prefer omitting when UI is self-evident. |

### Setup and AI settings

| English | Khmer | Note |
|---|---|---|
| Connect AI | `តភ្ជាប់ AI` | Space before `AI`. |
| API key | `កូនសោ API` | Head-initial Khmer with space before `API`. |
| Forget saved key | `ដកកូនសោដែលបានរក្សាទុកចេញ` | Uses `ដក...ចេញ` ("remove from Studio") to stay distinct from deleting (`លុប`) the key in Google AI Studio. |
| Clipboard | `ក្ដារតម្បៀតខ្ទាស់` | Coeng-ដ in `ក្ដារ`. |
| Primary model / Fallback model | `ម៉ូដែលចម្បង` / `ម៉ូដែលបម្រុង` | Used inside Model settings. |
| Optional | `ជាជម្រើស` | Compact optional badge. |
| Test connection | `សាកល្បងតភ្ជាប់` | Bare verb. |
| Test & save | `សាកល្បង និងរក្សាទុក` | Bare verbs. |

### Export and general status (including later phases)

| English | Khmer | Note |
|---|---|---|
| Captioned video | `វីដេអូមានអក្សររត់` | Self-explanatory contrast with `ឯកសារអក្សររត់`. |
| Captions file | `ឯកសារអក្សររត់` | Standard written UI term. |
| Download SRT | `ទាញយក SRT` | Keep `SRT` in Latin. |
| Render captioned video | `បង្កើតវីដេអូមានអក្សររត់` | Later phase; outcome-based phrasing rather than coining a word for "render". |
| Download video | `ទាញយកវីដេអូ` | Later phase; reserved for actual file downloads. |
| Check layout | `ពិនិត្យប្លង់អក្សរ` | Later phase; includes `អក្សរ` to disambiguate `ប្លង់`. |
| Video settings | `ការកំណត់វីដេអូ` | Later phase. |
| Match source | `ដូចវីដេអូដើម` | Later phase; avoid literal `ផ្គូផ្គងប្រភព`. |
| Recommended | `ណែនាំ` | Compact badge/label (`ណែនាំ៖ ...` in prose). |
| Upscaled | `ពង្រីកទំហំ` | Later phase; honest dimension wording (never `ពង្រីកគុណភាព`). |
| Ready to export | `រួចរាល់សម្រាប់នាំចេញ` | Later phase. |
| Something went wrong. Try again. | `មានបញ្ហាកើតឡើង។ សូមព្យាយាមម្ដងទៀត។` | Calm fallback error; coeng-ដ in `ម្ដង`. |

---

## 4. To verify with creators

Validate these terms in a short comprehension check with Cambodian short-form creators before locking future phases:

1. **Approve / Approved / Approve & next** (`យល់ព្រម` / `បានយល់ព្រម` / `យល់ព្រម និងបន្ទាប់`) vs `អនុម័ត` — confirm `យល់ព្រម` feels right for accepting a reviewed caption.
2. **Updates** (`បច្ចុប្បន្នភាព`) vs `ការអាប់ដេត` — creators often say `អាប់ដេត` in speech while OS menus use `បច្ចុប្បន្នភាព`.
3. **Correction inbox** (`ប្រអប់កែតម្រូវ`) vs `បញ្ជីកែតម្រូវ` — confirm whether "inbox" metaphor lands clearly for first-time users.
4. **Caption grouping** (`ការរៀបចំឃ្លា`) vs `ការបែងចែកអក្សររត់` — confirm it clearly signals text structure rather than visual styling.
5. **Tight loop** (`ចាក់ដដែលៗត្រង់ឃ្លានេះ`) — confirm creators understand it repeats only the selected caption tightly.
6. **API key / Clipboard** (`កូនសោ API` / `ក្ដារតម្បៀតខ្ទាស់`) — confirm setup instructions scan easily for non-developer creators getting a Gemini key for the first time.
7. **Look (style preset)** (`ម៉ូដអក្សរ`) vs `រចនាប័ទ្ម` *(later phase)*.
8. **Saved presets** (`គំរូដែលបានរក្សាទុក`) vs `Preset ដែលបានរក្សាទុក` *(later phase)*.
9. **Alternative take** (`ជម្រើសផ្សេងទៀត`) vs `បង្កើតជម្រើសថ្មី` *(later phase)*.

---

## 5. How to add strings (future phases)

1. **Add the English source key first** in `apps/web/src/i18n/messages/en/*.ts`. Never invent Khmer-only keys.
2. **Mirror the exact structure** in `apps/web/src/i18n/messages/km/*.ts` using `DeepPartial<EnglishMessages['<namespace>']>`.
3. **For plural keys**, provide **only** `{ other: "…" }` in Khmer (never `one`).
4. **Preserve every `{placeholder}`** with exact spelling and **preserve all `<b>` and `<code>` tags** (keep `<code>` contents and file names in Latin; translate non-token text inside `<b>`).
5. **Check terminology against §3** — reuse existing terms consistently instead of inventing synonyms.
6. **Apply formatting and orthography checks:**
   - Western digits `0–9` only (zero Khmer digits `០–៩`).
   - One space around embedded Latin tokens and numbers (except next to `។`, `)`, `»`, `,`, `៖`, `?`, `…`, or after `(`, `«`).
   - `។` only on full sentences (never on buttons, headings, chips, menu items, or keys whose English has no sentence-ending `.`).
   - Normalised coeng-ដ (`ម្ដង`, `ប្ដូរ`, `ចាប់ផ្ដើម`, `សេចក្ដី`, `ផ្ដល់`, `ស្ដាប់`, `ស្ដាំ`, `ស្ដារ`, `ផ្ដោត`, `បណ្ដោះអាសន្ន`, `ក្ដារ`).
   - `សំឡេង` spelled with `ឡ`; no zero-width spaces (`U+200B`); `…` (`U+2026`) and `ៗ` with no preceding space; guillemets `«…»` for quoted terms.
7. **Keep truthfulness exact** — especially in privacy, secure storage, upload recovery, export claims, and setup instructions.
8. **Validate before committing:**
   - Run `npm run typecheck` (or `node scripts/typecheck.mjs --runtime-only` if working on an isolated catalog branch) and `npm run build`.
   - Run a catalog parity script verifying zero missing keys, matching `{placeholders}` and `<b>`/`<code>` tags, zero Khmer digits, zero disallowed `្ត` spellings, and zero trailing `។` on non-sentence keys.
   - Check new Khmer strings visually in the app at desktop (`1200px`) and narrow (`≤620px`) widths so buttons and chips do not clip or wrap awkwardly.
