# Sthang Studio approved brand assets

## Permanent source artwork

These three owner-supplied SVGs are the approved source-of-truth. Do not redraw, trace, approximate, recolour, or replace them with generated artwork.

- `sthang-studio-mark.svg` — white + lime primary mark for dark interfaces.
- `sthang-studio-mark-ink.svg` — dark ink + lime mark for white/light surfaces.
- `sthang-studio-mark-mono.svg` — white monochrome mark for one-colour dark use.

Their intended use and SHA-256 fingerprints are recorded in `brand-manifest.json`. Run `npm run verify:brand` from the project root to confirm they are unchanged.

## Other files

- `sthang-wordmark.png` — supplied/cropped parent STHANG wordmark.
- `favicon.svg` — dark rounded browser icon derived from the approved primary mark.
- `sthang-studio-icon.png` — 512px raster app icon derived from the approved primary mark.
- `sthang-studio.ico` — multi-resolution Windows shortcut icon derived from the approved primary mark.

## Runtime rule

Use the `StudioMark` component rather than hard-coding paths or using CSS filters:

```tsx
<StudioMark surface="dark" />
<StudioMark surface="light" />
<StudioMark surface="mono" />
```

The ACO falcon/eagle remains exclusive to Sthang ACO.
