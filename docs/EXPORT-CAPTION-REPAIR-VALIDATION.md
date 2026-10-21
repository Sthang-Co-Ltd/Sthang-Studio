# Export caption repair: validation

Source qualification on Windows with Node 24.21.0, based on
`ff996a9216a717ef24c7ed22afe84b82c2d79cf4` (main after PR #87).
All media used for these checks was synthetic and isolated from user projects.
This evidence qualifies the source change, not a public installer or release.

## Passing checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, including the added test sources and brand verification |
| `npm run build` | Passed with brand verification |
| `npm run verify:brand` | Passed; approved source artwork is unchanged |
| `npm run test:public` | 16 passed |
| `npm run check:public` | Manifest, service declarations, current tree and locally available refs/history passed after fetching origin |
| `npm run test:export-checks` | 15 passed: output gates, exact keys, malformed data/size limits, HTTP read-only behavior, cancellation and invalidation |
| `npm run test:caption-handoff` | 32 passed, including real handoff-summary agreement with corrupt saved word-data blockers |
| `npm run test:video-export` | 70 passed |
| Focused browser suite | 40 passed across appearance/export, caption handoff, native overflow warning and the first nine new repair scenarios |
| Final repair browser suite | 10 passed after review refinements, including persisted handoff-duration authority |
| Browser isolation/lifecycle guards | 38 passed on each owned browser run |
| Native renderer, persistent preview, scheduler and handoff files | 46 passed; one FFmpeg 7.1 compatibility case skipped because that optional runtime is absent |

Native file command:

```text
node --import tsx --test tests/caption-renderer-native.test.mts tests/persistent-caption-preview.test.mts tests/persistent-caption-preview-phase3.test.mts tests/native-preview-scheduler.test.ts tests/caption-handoff-native.test.mts
```

Focused browser command:

```text
npm run test:browser -- tests/browser/export-caption-repair.spec.mts tests/browser/caption-handoff.spec.mts tests/browser/appearance-export.spec.mts tests/browser/caption-overflow-warning.spec.mts
```

The final repair-only run used the same wrapper with
`tests/browser/export-caption-repair.spec.mts`. It exercised exact caption
selection/seek/focus, Word timing navigation, return with output choices, SRT
independence from native layout failures, invalidation after draft/resolution
edits, late/cancelled replies, project-visit reset, changed settings during save,
format-specific text restrictions, keyboard pagination and mobile controls.

Desktop and 390 px mobile captures were inspected. Pagination brings the focused
checks heading into view; issue text wraps without horizontal overflow and mobile
repair actions have at least 44 px height. The test creates
`test-results/export-caption-repair-desktop.png` and
`test-results/export-caption-repair-mobile.png` from synthetic footage.

## Existing native font failure

`tests/caption-overflow-native.test.mts` produced 20 passes, two skips for absent
Noto Serif Khmer faces, and one failing scenario (reported as two failures because
the parent test also fails). The failure is **Noto Sans Khmer, Size 120, 4K
portrait, “hello world” with a nonbreaking space**. The existing guarded-canvas
allocation check rejects it before native measurement.

The same scenario fails on unchanged main at the base commit above:

```text
node --import tsx --test --test-name-pattern="ordinary 4K portrait" tests/caption-overflow-native.test.mts
```

The new duplicate-paint attribution, overlap-group attribution and diagnostic
opacity/unverifiable tests pass. Attribution leaves the ASS document bytes
unchanged. No font substitution or weakening of the native safety limit was used
to bypass the baseline failure.

## Review and limits

Independent read-only review covered the final changed source and relevant
callers. Its findings were corrected: serializer-specific rejection rules,
corrupt saved word evidence, portable JSON size, source-duration authority and
export-choice ownership after asynchronous saves. The final review reported no
remaining definite blockers.

Final ZIP entry/total limits and execution-time disk/encoder conditions remain
the export path's authority. Actual native rendering still validates its own
snapshot. This work did not benchmark speed or qualify a release package.

See [public impact](EXPORT-CAPTION-REPAIR-PUBLIC-IMPACT.md) for the source-only
documentation and downstream approval boundary.
