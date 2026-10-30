# Large-preview editor (development source)

Change ID: `studio-refined-editor-20261023`.

Integration handoff ID: `studio-local-source-integration-20261030`. This intake
combines the source layout and project model-choice work; prior intake IDs or
approvals do not authorize its HQ or Distribution synchronization.

This is a source implementation and proposed public-documentation handoff, not
evidence of an updated public package or website.

During regeneration comparison, notices and persistent save-recovery actions use
a bounded footer outside the editor panes. They must not obscure Keep current
or Accept actions. Small-screen comparison temporarily compacts the preview
while messages are present; the video remains available and an empty stack
reserves no space. `tests/browser/stale-save-conflicts.spec.mts` covers desktop
and mobile decision hit targets together with the guarded accepted-result save
behavior. `tests/browser/playback-grouping.spec.mts` retains exact request checks
for full/selection regeneration, including the Automatic model choice.

## Working layout

At desktop widths of 1200px and above, preview, captions and an optional tool
inspector occupy separate panes. Switching a tool retains the media and caption
list instances and the preview allocation. The picture remains contained at its
real aspect ratio. The default order is Preview, Captions, Tool. The pane
arrangement extension below permits other desktop orders.

The preview and inspector dividers accept pointer dragging, Left/Right keys,
Shift for larger increments, Home/End and double-click reset. **Reset layout**
restores defaults. Numeric proportions stay in optional browser-local storage;
unavailable or invalid storage does not stop editing. **Close tool** returns to
the ordinary video-and-caption view. Review retains its existing queue filtering,
approval, focus and playback behavior.

Smaller windows use an adapted scrolling layout with a consistent preview size
across tools. Captions remain reachable. Appearance shows Looks and essential
font/color/size/position editing first. Motion, word highlighting, other styling
and saved presets are disclosed through labeled sections. Replay stays available
outside Motion. No source artwork, media, caption appearance, export format,
save/conflict behavior or provider boundary changes meaning.

## Verification authority

- `apps/web/src/components/EditorLayout.tsx` owns pane geometry and numeric local
  preferences; App retains project and editing authority.
- `tests/browser/editor-layout.spec.mts` covers stable media/list ownership, large
  portrait geometry, dock relocation/redraw, resizing, reset and unavailable
  storage using isolated synthetic fixtures.
- Existing Fine timing, Appearance, Review, word timing and export browser suites
  cover the real editing controls and native preview/export geometry.
- Browser evidence is tied to this checkout's owned Vite test process. It does
  not establish which artifact an already-running installed Studio uses.

## Public-impact handoff

Public impact: required. This changes navigation, screenshots and instructions
for finding Motion, word highlighting and appearance presets. Product-owned
`README.md`, `PRODUCT.md`, `DESIGN.md` and `PRIVACY.md` describe the development
behavior and the numeric local preference. There are no new hosted services,
dependencies, cloud transfers, identity assets or installation requirements.

The accepted `.sthang/product-manifest.json` describes the existing 0.86.0 public
release. Its source/public version, downloads, approved identity and data-transfer
claims are not replaced by a local UI build. A new intake should use the change ID
above when release evidence is available.

Before public synchronization, HQ should review the editor workflow/capability
description and source-versus-released availability evidence. Distribution's
`/studio/` page and documentation need the approved large-preview screenshots and
updated Appearance/navigation instructions. No HQ or Distribution checkout or
new cross-repository approval was supplied for this task. Follow their respective
Phase 3 intake and Phase 2 synchronization workflows, including their exact
plan-digest and approval-class decisions, before writing those repositories or
publishing. Release, commit/push and deployment remain separate actions.

## Pane arrangement extension (development source)

Change ID: `studio-pane-arrangement-20261025`.

**Arrange panels** adds quick Preview left/middle/right choices and all six pane
orders using dedicated drag handles, Left/Right buttons, or focused-handle arrow
keys. Dragging shows a lightweight lifted proxy and target outlines, while the
real media/caption subtrees stay mounted and stationary until commit. Escape,
outside release, pointercancel, lost capture, window blur, reset, and topology or
viewport changes cancel unfinished gestures. Layout controls own their keys;
Fine timing and global caption shortcuts cannot act through them.

The full order persists independently of tool visibility. In two-pane mode,
moving Preview/Captions replaces only their saved slots; reopening Tool restores
its remembered slot and width. Closing a tool preserves preview width and lets
captions use freed space. Dividers redistribute only their adjacent panes and
clamp to usable minima. Reset restores sizes and order. Previous v1 numeric
preferences migrate on read; v2 stores only proportions and three allowlisted IDs.
Corrupt or denied storage remains fail-open.

Fine timing retains its 184px waveform. When Preview is at an outer edge, the
dock spans the adjacent Captions/Tool columns. With Preview centered, the dock
uses the Caption column only and the other two panes keep their full height.
The dock never crosses video. Geometry changes cancel uncommitted waveform
timing drags rather than interpreting movement as caption edits.

Reordering uses CSS grid positions with native `reading-flow: source-order` and
explicit `reading-order` on panes, dividers, and the waveform dock, so
keyboard traversal follows visual order without DOM-reparenting the playing
video. Browsers that do not support that property keep the canonical arrangement
and show a disabled Arrange action explaining the browser requirement; resizing
still works. Below 1200 CSS pixels, Studio uses its standard preview-first
scrolling layout, closes the arrangement popover, and retains desktop preferences.

Verification authority: `tests/editor-layout-state.test.ts`,
`tests/browser/panel-arrangement.spec.mts`, and the existing editor-layout and
Fine timing suites. Synthetic playing-video continuity, actual Tab traversal,
all six orders, tool visibility transitions, drag cancellation, nearby pane
resizing, waveform geometry and shortcut isolation are distinct acceptance cases.
These checks do not imply universal browser support or a published release.

On October 25, 2026, the owned synthetic-browser run passed all 40 editor-layout,
Fine timing and arrangement regressions. After the final ghost-boundary and
browser-capability polish, all 12 arrangement checks passed again with no
uncaught page errors. The 16 web-optimization/typography/state checks, source
typecheck, production build, brand and product-manifest verification also passed.
Execution used the reviewed Node 24.21.0 runtime. Tests include actual sequential
focus traversal and playing media, rather than inferring those behaviors from
CSS support or DOM identity alone. No user media or live provider request was
needed for these checks.

Public impact: required. The new intake ID above covers arrangement instructions,
desktop screenshots, browser capability limitations, and local preference fields.
HQ should review the Studio editor workflow/capability representation and
`proposal.publicClaims`; Distribution should review `/studio/`, its guide
(`docs/studio/index.md`), and approved screenshots. Keep the accepted manifest's
public version, downloads, identity and provider/privacy evidence intact until
release evidence exists. No authorized HQ/Distribution checkout or exact intake
approval was supplied; Phase 3/Phase 2 handoff and publishing remain pending.

## Direct header arrangement (development source)

Change ID: `studio-panel-header-drag-20261025`.

At supported desktop widths, drag the grip/title in Preview, Captions or the
current tool header onto another visible panel. The six-pixel movement threshold
keeps clicks from becoming accidental moves. A floating label, source outline,
target outline and grabbing cursor provide feedback; the real panes move only
on an accepted drop. Focus a header and use Left/Right or Home/End for keyboard
ordering. The accessible name includes its displayed title, including Review
queue and whichever tool is open. Current, Follow, Add caption and Close tool
remain separate actions.

Only a release inside the visible panel rectangle accepts a move. Toolbar,
divider, waveform and outside releases cancel. Escape, blur, lost capture,
pointer cancellation, viewport/height changes, tool transitions and Reset cancel
pending gestures. Headers, the Arrange popover and dividers share one synchronous
gesture gate. Starting a header move closes the popover and cancels pending
waveform timing edits. Playing media, caption content/caret, scroll and Follow
state retain their existing ownership.

The existing v2 local preference and hidden-tool-slot rules also apply to direct
header moves. No new persisted fields, dependencies, provider calls, hosted
services or data transfers are introduced. Narrow or unsupported layouts retain
plain readable titles and the established fallback arrangement.

Verification authority: `tests/browser/panel-header-drag.spec.mts`, together with
the editor-layout, Arrange panels and Fine timing regressions. The checks cover
all six orders, repeated three-to-two-to-three transitions, exact release hit
testing, independent header buttons, keyboard focus/shortcut isolation,
multi-pointer conflicts, timing-drag cancellation, height-only resize,
breakpoints and media/editing continuity. Browser evidence uses owned synthetic
state and this checkout's Vite process; it does not establish an installed or
published artifact.

On October 25, 2026, the final owned Chromium run passed all 54 direct-header,
Arrange panels, editor-layout and Fine timing checks. Direct-header cases
reported no uncaught page errors. The 16 web-optimization/typography/layout-state
checks, typecheck, production build, brand and product-manifest verification
also passed using Node 24.21.0. Independent read-only source review passed after
the visible-title accessibility fix. The local 5188/8787 processes were bound to
this checkout and reviewed Node runtime; Vite served the new header controller.
These are development-source and synthetic-browser checks, not public-release
or installed-package verification.

Public impact: required. Product-owned `README.md`, `PRODUCT.md` and `DESIGN.md`
describe this development interaction. Prepare a new HQ Phase 3 intake using
the change ID above for the Studio editor workflow/capability and
`proposal.publicClaims`, then Distribution Phase 2 updates for `/studio/`,
`docs/studio/index.md` and approved desktop screenshots. The accepted product
manifest's public version/download/privacy/identity evidence stays unchanged.
HQ/Distribution checkouts, exact plan-digest approvals and release evidence were
not supplied; cross-repository synchronization and publishing remain pending.

## Live panel insertion (development source)

Change ID: `studio-live-panel-sort-20261025`.

This supersedes the direct header's floating-label interaction above. Dragging a
header now lifts the actual pane, keeping its video, caption list and tool
content mounted. Neighbours slide into provisional insertion positions when
the pointer crosses their midpoints; a vacant-slot outline shows the destination.
Midpoint hysteresis keeps a held pointer from oscillating between orders and
allows reversals before release. Only the accepted drop changes the committed
grid and saved preference. The Arrange popover retains its compact proxy.

Pointer following is immediate; neighbouring and settling motion is bounded to
180ms and disabled by Reduce Motion. Escape/outside/cancel restore the committed
order. Geometry or tool transitions remove transient transforms before adopting
the new layout, retaining the existing two/three-panel and hidden-tool-slot rules.
The original pane rectangles define valid drop space, excluding dividers,
toolbar and waveform. No new storage fields, provider calls or transfers occur.

The motion acceptance matrix includes actual pane displacement, neighbours'
insertion positions, held-pointer stability, reversing across both slots,
unchanged storage during hover, all pane orders and hidden-tool transitions,
Reduce Motion, cancellation, and playback/edit continuity. The first motion run
exposed a release-before-resize-notification race: frozen target bounds could
accept a stale desktop drop after the viewport changed. The earlier proxy used
live element bounds and did not exercise this new snapshot path. Release now
checks current root geometry and the desktop breakpoint synchronously; two
additional cases change width/height and release within the same JavaScript
task, before observer notifications, to prevent that regression.

On October 25, 2026, the final owned Chromium run passed all 58 header,
arrangement, editor-layout and Fine timing checks, including the added race
cases, with no uncaught errors in the header cases. The 16 deterministic
web/typography/layout-state checks, typecheck, production build, brand and
manifest verification passed on Node 24.21.0. The lifted/insertion state was
visually inspected. The local 5188 Vite process was bound to this checkout and
served the actual-pane motion and geometry guard. This motion extension was
implemented and reviewed by the primary; no new independent review was run.
The earlier independent review above covered the prior header interaction.
This evidence verifies development source and owned synthetic state, not a
published or installed release.

Public impact: required. `README.md`, `PRODUCT.md` and `DESIGN.md` describe the
development interaction. A new HQ Phase 3 intake using this change ID should
update Studio editor workflow/capability and `proposal.publicClaims`, followed
by Distribution Phase 2 review of `/studio/`, `docs/studio/index.md` and desktop
interaction captures. Exact intake approvals, private checkouts and public
release evidence remain unavailable; no cross-repository writes or publication
are part of this implementation.

## Independent dragging review and interruption fix

The follow-up review used only GPT 6.1 Sol for its independent subagent. It found
one interaction defect: grabbing a settling header cancelled its animation
before measuring its position, changing the grip-to-pointer offset. Browser
regressions reproduced the snap during both landing and cancelled-move settling.
The previous helper always waited for settling to finish, excluding this path.

`PanelHeaderGrip.tsx` now captures the fractional grabbed point before cancelling
motion and carries its presentation offset through the pending and active drag.
This also handles an inspector whose height is settling. A pending click settles
back without saving; geometry/tool changes clear held transforms immediately.
The same Sol reviewer checked the revised source and found no remaining issue.
That is independent static review; runtime verification belongs to the primary.

`tests/browser/panel-drag-transitions.spec.mts` adds every saved order and dragged
source across three-to-two-to-three transitions, both remaining sources opening
Tool mid-drag, valid two-pane swaps retaining hidden Tool slots, interrupted
landing/cancellation in two and three panes, pending clicks and tool toggles,
and scaled-inspector grab anchors. Cleanup assertions cover transforms, held
classes, provisional geometry, order, bounds and stable video/list instances.

The final owned Chromium run on October 25, 2026 passed all 77 layout, timing,
arrangement, header and transition cases, including all 19 new review regressions.
The new transition and header cases reported no uncaught page errors. The 16
deterministic web/typography/layout-state checks, typecheck, production build,
brand and product-manifest verification also passed on Node 24.21.0. The scaled
inspector regrab was visually inspected. These checks use this checkout's Vite
and isolated synthetic state; no live provider request or user media was used.

Public impact: none for this reliability fix within the documented interaction.
The accepted product manifest, `README.md` workflow and `PRIVACY.md` browser-local
preference/data-transfer boundaries remain accurate. The earlier live-panel
feature's release/HQ/Distribution handoff remains pending; this fix adds no new
capability, storage category, provider transfer or publication claim.

## Resize measurement recovery

The live editor exposed stale geometry: a 1262px viewport had an
approximately 1238px editor, but the Preview divider reported 320px for both
minimum and maximum. A one-shot native ResizeObserver did not deliver a callback
in that session. The source relied on that observer to refresh its stored width
after a narrow-to-desktop transition, so a real horizontal drag had no range.
The browser's reason for suppressing delivery was not established.

`EditorLayout.tsx` now measures its current bounding width synchronously during
layout setup and on window resize, with ResizeObserver providing additional
updates. Invalid/zero observations cannot replace the usable width. No saved
layout reset or preference-schema change is needed. Native computer use then
verified a real drag in the live project increased Preview from 376px to 423px.
Captions and pane order were preserved; no source media or caption data changed.

`tests/browser/panel-resize-recovery.spec.mts` reproduces the failure by starting
at 900px and returning to 1262px with observer delivery suppressed. Both two- and
three-pane cases initially failed with zero available range; the recovery checks
exercise real pointer and keyboard resizing and the existing preference fields.
An existing cancellation-loop test also clicked a stale animated-header position;
its ordinary gesture helper now waits for settling. The separate controlled
mid-animation regrab tests retain their coverage unchanged.

Verification: the broad owned run passed 78 of 79 cases; its sole failure was
the stale-coordinate cancellation helper described above. After correcting that
test helper, all 18 header/recovery cases passed in the focused rerun. The other
61 layout/arrangement/transition/timing cases passed on the same unchanged product
source. The 16 deterministic checks, typecheck, production build, brand and
manifest verification passed on Node 24.21.0. Live computer-use verification
confirmed resizing in the user's open project. This is development verification,
not a public release or installed-package check.

Public impact: none. This restores already-documented resizing without changing
the workflow, public claims, installation, identity, local preference format or
data-transfer boundaries in the accepted manifest, `README.md` and `PRIVACY.md`.
The prior source-feature release handoff remains pending. No subagents were used
for this fix; independent review was not run at the user's request.
