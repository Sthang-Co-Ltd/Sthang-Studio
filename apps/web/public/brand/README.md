# Sthang Studio approved brand assets

## Protected source artwork

These owner-approved assets are the source of truth. They all use transparent backgrounds.

- `sthang-studio-mark.svg` — white + lime ribbon-S primary mark for dark interfaces.
- `sthang-studio-mark-ink.svg` — dark ink + lime ribbon-S mark for white/light surfaces.
- `sthang-studio-mark-mono.svg` — white monochrome ribbon-S mark for one-colour dark use.
- `sthang-wordmark.svg` — approved white in-house STHANG wordmark for dark surfaces.
- `sthang-wordmark-ink.svg` — approved dark in-house STHANG wordmark for light surfaces.

Do not redraw, trace, approximate, recolour, regenerate, or re-typeset these assets. Their intended use and SHA-256 fingerprints are recorded in `brand-manifest.json`. Run `npm run verify:brand` from the project root to confirm they are unchanged.

## Derived icons

- `favicon.svg` — browser icon derived from the approved primary mark.
- `sthang-studio-icon.png` — 512px application icon derived from the approved primary mark.
- `sthang-studio.ico` — Windows shortcut icon derived from the approved primary mark.

The browser/desktop icons use a dark tile for reliable visibility. The mark and wordmark source assets themselves remain transparent.

## Runtime rule

Use `StudioMark`/`StudioBrand` rather than hard-coding paths or applying CSS filters:

```tsx
<StudioMark surface="dark" />
<StudioMark surface="light" />
<StudioMark surface="mono" />
```

`StudioBrand` must use the in-house STHANG wordmark, followed by the lime slanted divider and restrained `STUDIO` descriptor. Never re-typeset STHANG with a substitute font.

The ACO falcon/eagle remains exclusive to Sthang ACO.
