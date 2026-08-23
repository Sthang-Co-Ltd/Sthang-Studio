# Contributing to Sthang Studio

Thank you for helping improve Khmer caption creation and review.

## Before changing code

1. Start from the latest `main`.
2. Create a focused branch for one feature or fix.
3. Read `AGENTS.md` first.
4. For product/UI work, also read `PRODUCT.md`, `DESIGN.md`, `BRAND.md`, and
   `UX-AUDIT.md` as relevant.
5. Inspect the affected implementation before changing it.

Sthang Studio prioritizes Khmer accuracy, timing accuracy, fast review, safe
non-destructive editing, and reliable CapCut-compatible SRT export. Please avoid
large rewrites when a focused fix will do.

## Local development

Windows is the primary supported development environment.

```text
npm install
npm run check:public
npm run typecheck
npm run build
```

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

Run `npm run check:public`, `npm run typecheck`, and `npm run build` before
requesting review. Brand verification is included in the normal build/typecheck
flow.

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

## Licensing contributions

By submitting a contribution, you agree that your contribution may be licensed
under the repository's MIT software license. This does not grant rights to use
Sthang trademarks or brand assets outside the terms in `TRADEMARKS.md`.
