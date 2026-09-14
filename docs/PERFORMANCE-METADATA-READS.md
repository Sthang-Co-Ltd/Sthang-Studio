# Narrow project reads: internal contract and validation

Base: `fe4abeb89d34519f6e81f970239a7807039f6bdc` (accepted `main` at implementation).
This is a source optimization, not release evidence or a whole-app speedup claim.

## Scope

`store.has(id)` checks project existence after the same initialization used by
`store.get(id)`. `store.getMedia(id)` returns a detached `{ id, media }` snapshot,
not captions, transcript, appearance, or context. Both read the last published
in-memory state, just like the full getter. They do not await pending per-project
writes or maintain a second cache. A completed save or deletion is immediately
reflected by subsequent reads. Failed writes must not publish replacement metadata.

Only two existing routes use the new reads:

- `GET /api/projects/:id/history` uses the existence check, then the existing
  history index/list path. Restore still loads the complete project.
- `GET /api/projects/:id/normalized-audio.wav` uses the media snapshot. Its force
  refresh parsing, media fingerprint, in-flight serialization, cache-hit checks,
  WAV bytes, response headers, and stream/error handling are unchanged.

The audio-cache input type now requires only ID and media. Full projects remain
structurally valid inputs; no cast to a fabricated complete project is used.
The full `get`/`list` methods, mutation queues, storage layout, export snapshots,
caption layout, correction memory, and privacy choices are unchanged.

## Validation

The additional cases in `tests/project-store.test.mts` exercise shared
initialization, exact missing IDs, no full-project cloning on narrow reads,
mutation isolation, pending and failed saves, cached-WAV equivalence, and deletion.
The suite is already part of `test:video-export` and the local `ci` aggregate;
it is also included in the strict test TypeScript configuration.

Use the current locked dependencies and Node.js 24+ in an isolated checkout.
Run `npm run test:video-export`, `npm run typecheck`, and `npm run build` locally.
For targeted execution after building the shared workspace, use
`node --import tsx --test tests/project-store.test.mts`.
Check the two real HTTP routes for unchanged 404 responses, history JSON,
normalized-audio headers/bytes, and refresh behavior. Synthetic cached-WAV tests
are not a replacement for native FFmpeg or platform installation verification.

## Compatibility and public impact

This change preserves the newer macOS source-beta, Keychain/font support,
dependency refresh, privacy layout fix, and native single-line caption-layout
behavior in its base. No frontend, dependency, installer, workflow, manifest,
provider, or external public claim is changed. Public impact: none for this
internal optimization. Release, merging, and any governed synchronization remain
separate approvals. Do not advertise earlier prototype timings as measurements
of this complete application or current Windows/macOS runtime.
