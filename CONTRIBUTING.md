# Contributing to Sthang Studio

Thank you for helping improve Khmer caption creation and review.

## Before changing code

1. Start from the latest `main`.
2. Create a focused branch for one feature or fix.
3. Read `AGENTS.md` first.
4. For product/UI work, also read `PRODUCT.md`, `DESIGN.md`, and `BRAND.md`.
   Consult `UX-AUDIT.md` for relevant historical findings, not current QA status.
5. Inspect the affected implementation before changing it.

Sthang Studio prioritizes Khmer accuracy, timing accuracy, fast review, safe
non-destructive editing, and reliable CapCut-compatible SRT export. Please avoid
large rewrites when a focused fix will do.

## Local development

Windows is the primary supported development environment.

```text
npm ci --include=dev
npm run test:public
npm run check:public
npm run typecheck
npm run build
```

Use a complete Git clone with the relevant branches and tags fetched before
running `check:public`. The guard checks current and historical paths, including
deleted files, and common secret patterns in text. It rejects shallow clones and
does not fetch remote refs itself. `test:public` exercises the guard in disposable
repositories without private media or real credentials.

For the local timing environment on Windows, run:

```text
setup-local-timing-windows.bat
```

Start the development app with:

```text
npm run dev
```

The Python timing worker can be syntax-checked without downloading models:

```text
python -m py_compile local-timing/worker.py
```

## Pull requests

A good PR:

- explains the user problem and the smallest coherent solution;
- preserves unrelated working behavior;
- includes relevant documentation updates;
- states exactly what was tested and what was not;
- includes screenshots for meaningful visual changes;
- does not include generated caches, local projects, media, API keys, or other
  private data.

Run `npm run test:public`, `npm run check:public`, `npm run typecheck`, and
`npm run build` before requesting review. Brand verification is included in the
normal build/typecheck flow.

Include the public-impact assessment described in `AGENTS.md`. Maintainers
handle any authorized private HQ/website coordination; contributors do not need
access to those repositories.

## UI and copy

Routine UI copy should describe what an action does rather than naming internal
providers, models, aligners, runtimes, or fallback architecture. Keep the main
upload → generate → review → export path easy to understand.

Do not modify or recreate the approved Sthang Studio logos. See `BRAND.md`,
`AGENTS.md`, and `TRADEMARKS.md`.

## Khmer-specific changes

For Khmer text processing, avoid English-centric assumptions about spaces and
word boundaries. Explain test media/phrases in a way that lets maintainers
reproduce the issue without requiring private user content.

## Security and privacy

Never commit secrets. Do not attach private source media, project data, history,
or API keys to issues or pull requests. Security vulnerabilities should be
reported according to `SECURITY.md` rather than opened publicly.

The scanner is a limited guard, not a complete security review. It does not
inspect commit email metadata, arbitrary binary contents, GitHub discussions,
Actions logs, or downloaded release assets.

### Commit email privacy

Git author and committer email addresses become public with the commits. If you
want to keep your personal address private, copy your own GitHub no-reply address
from GitHub's email settings and configure it for this clone:

```text
git config --local user.email "YOUR_GITHUB_NOREPLY_ADDRESS"
```

Verify the effective author and committer identity before committing; environment
variables and other tools can override this setting. The local setting does not
follow a fresh clone or change GitHub's web-commit email settings. It also does
not remove addresses or local paths already present in published history.
History rewriting requires a separate maintainer decision.

## Licensing contributions

By submitting a contribution, you agree that your contribution may be licensed
under the repository's MIT software license. This does not grant rights to use
Sthang trademarks or brand assets outside the terms in `TRADEMARKS.md`.
