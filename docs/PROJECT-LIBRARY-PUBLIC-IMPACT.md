# Project library: public-impact intake

- **Change ID:** `studio-project-library-search-resume-20261021`
- **State:** source-only implementation and intake proposal
- **Public impact:** required for project discovery and reopening documentation
- **Downstream assessment:** uncertain until the authorized HQ Phase 3 intake
  evidence and exact approval plan are available

## Product behavior

Home retains six recent projects and provides access to All projects. The full
view searches every loaded project summary by name, orders by last edited,
creation date or name, and displays 24 results per page. Search is literal,
case-insensitive and Unicode-normalized. Khmer names remain searchable. Changing
the search or ordering returns to the first page.

Projects with captions offer Continue editing; projects without captions offer
Open project. Both fetch the current saved project through the established
guarded open flow. A later project choice or return to Home invalidates an older
pending open. Returning from the editor retains the search, ordering and page in
that tab. Saved captions, approvals, locks, appearance and draft-recovery handling
come from the existing editor path. Reopening does not regenerate captions,
resume an interrupted processing job, or restore/play an earlier playhead.

Loading, failed loading, an empty collection and no search matches have distinct
states. Failed reads remain retryable. Search and ordering operate in browser
memory on the existing local summary response; they do not fetch every project's
captions, create a new persisted search history, or add analytics/provider calls.
The list reflects this tab's loaded summaries and updates from its own accepted
project operations; this feature does not add live synchronization between tabs
or repair unreadable project files skipped by the existing store.

## Evidence and release boundary

| Evidence | Assessment |
| --- | --- |
| `apps/web/src/components/ProjectLibrary.tsx`; `apps/web/src/project-library.ts`; `apps/web/src/project-library.css` | Collection search, stable ordering, pagination and accessible loading/result states |
| `apps/web/src/App.tsx`; `apps/web/src/styles.css` | Home entry points, retained view state and existing guarded opening/navigation |
| `tests/project-library.test.ts`; `tests/browser/project-library.spec.mts` | Whole-collection lookup, ordering, pagination, reopening, asynchronous ownership and responsive/keyboard regressions |
| `README.md`; `PRODUCT.md`; `DESIGN.md`; `CHANGELOG.md` | Source-only user workflow and limits |
| `PRIVACY.md`; `SECURITY.md`; `THIRD_PARTY_NOTICES.md` | Existing local project and metadata boundary applies; no new service, dependency, cloud transfer, telemetry or storage category |

The reviewed `.sthang/product-manifest.json` represents the separately governed
`studio-v0-86-0-release-20261013` change. Its release, distribution, update and
brand evidence remains unchanged. No source or test result here establishes that
the published v0.86.0 installers contain the project library. Installation,
supported platforms, protected artwork and download authorities are unaffected.

## Proposed HQ and Distribution follow-up

| Authority or surface | Proposed follow-up |
| --- | --- |
| HQ Studio workflow/features | Describe Home's recent projects, All projects, name search, ordering, and explicit reopening; keep availability source-only until release evidence advances |
| HQ Studio limitations | Explain that reopening uses current saved work and existing draft recovery; no automatic playhead/job resume or live cross-tab collection synchronization is promised |
| `landing/studio/index.html`; `docs/studio/index.md` | Review `/studio/` project-discovery instructions after HQ acceptance |
| `governance/hq/portfolio.json`; `governance/hq/sync-lock.json` | Carry the exact accepted HQ input through Distribution's Phase 2 workflow |

Distribution's README was read. Its synchronization requires a clean authorized
HQ checkout, an immutable plan and approval of the exact digest/classes. The HQ
checkout is not in the connected roots, so this intake does not invent schema
fields, approval classes or an accepted downstream diff. Prepare the new HQ
Phase 3 intake when its evidence is available, then prepare the matching
Distribution Phase 2 plan for approval. Website/docs synchronization and release
publication retain their own approvals; this feature PR does not perform them.
