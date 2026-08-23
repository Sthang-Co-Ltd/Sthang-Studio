# Sthang Studio brand foundation

## Architecture

```text
STHANG — parent/master brand
├── Sthang ACO — Web3 execution product; falcon/eagle mark
└── Sthang Studio — short-form video finishing product; approved S/media mark
    └── Captions — current Khmer-first workspace
```

## Approved Studio logo system — source of truth

The three SVGs below were supplied and approved by the owner. They are the permanent source artwork for Sthang Studio.

| Surface/use | Approved file | Treatment |
|---|---|---|
| Dark interface or dark marketing surface | `apps/web/public/brand/sthang-studio-mark.svg` | White angular mark with lime play symbol |
| White or light surface | `apps/web/public/brand/sthang-studio-mark-ink.svg` | Dark ink angular mark with lime play symbol |
| Monochrome/single-colour dark use | `apps/web/public/brand/sthang-studio-mark-mono.svg` | White angular mark without lime |

**Do not redraw, trace, approximate, simplify, recolour, or regenerate these SVGs.** Do not replace them with image-generated artwork. A replacement is allowed only when the owner supplies a new approved source set.

`apps/web/public/brand/brand-manifest.json` records their intended roles and SHA-256 fingerprints. `npm run verify:brand`, `npm run typecheck`, and `npm run build` verify that the approved source files remain byte-for-byte intact.

## Runtime use

Use the shared `StudioMark` component from `apps/web/src/components/Brand.tsx`:

```tsx
<StudioMark surface="dark" />
<StudioMark surface="light" />
<StudioMark surface="mono" />
```

The current application is dark, so its home screen and compact project header use `surface="dark"`. Future white panels or light exports must use `surface="light"`; do not apply CSS filters to the dark-surface SVG.

## Product lockup

Preferred hierarchy:

```text
[Studio mark]
              [STHANG wordmark] / STUDIO
                 CAPTIONS / Khmer-first workspace
```

Use **Sthang Studio** as the product name and **Captions** as the module/workspace name. The divider is slightly forward-slanted to echo the parent wordmark, while `STUDIO` is optically aligned to its lower edge rather than vertically centered.

## Colors

- Background: `#08090B`
- Parent/product ink: `#F4F6F8`
- Light-surface ink: `#15181C`
- Studio accent: `#D7FF4F`
- Muted steel: `#737B87`

Sthang orange remains the master-brand color. Inside Studio, lime is the primary product/interface accent; orange should appear sparingly only for parent-brand references.

## Derived assets

The browser favicon, 512px PNG, and Windows ICO are derived from the approved dark-surface mark on a dark rounded tile. They may be regenerated from the approved SVG, but the three source SVGs themselves must remain unchanged.

## Compatibility

The branding integration changes identity assets only. Internal `@kcs/*` package scopes and legacy browser-storage keys remain intentionally unchanged for safe in-place upgrades.
