# Sthang Studio brand foundation

## Architecture

```text
STHANG — parent/master brand
├── Sthang ACO — Web3 execution product; falcon/eagle mark
└── Sthang Studio — short-form video finishing product; approved ribbon-S mark
    └── Captions — current Khmer-first workspace
```

## Approved Studio identity — source of truth

The owner-approved identity uses the new interlocking **ribbon S** mark with a lime edit/continuity hinge plus the in-house **STHANG** wordmark.

All source assets have transparent backgrounds.

| Surface/use | Approved file | Treatment |
|---|---|---|
| Dark interface or dark marketing surface | `apps/web/public/brand/sthang-studio-mark.svg` | White ribbon-S mark with lime hinge |
| White or light surface | `apps/web/public/brand/sthang-studio-mark-ink.svg` | Dark ink ribbon-S mark with lime hinge |
| Monochrome/single-colour dark use | `apps/web/public/brand/sthang-studio-mark-mono.svg` | White monochrome ribbon-S mark |
| STHANG wordmark on dark surfaces | `apps/web/public/brand/sthang-wordmark.svg` | Owner-approved white in-house wordmark |
| STHANG wordmark on light surfaces | `apps/web/public/brand/sthang-wordmark-ink.svg` | Owner-approved dark in-house wordmark |

**Do not redraw, trace, approximate, simplify, recolour, re-typeset, or regenerate these source assets.** In particular, do not replace the STHANG wordmark with ordinary text or a substitute font. A replacement is allowed only when the owner explicitly approves a new source set.

`apps/web/public/brand/brand-manifest.json` records intended roles and SHA-256 fingerprints. `npm run verify:brand`, `npm run typecheck`, and `npm run build` verify the protected source content. For SVGs, the verifier canonicalizes CRLF to LF before hashing so Windows line-ending conversion cannot create a false failure; every other content change still fails verification.

## Runtime use

Use the shared `StudioMark` component and the surface-aware wordmark mapping from `apps/web/src/brand.ts`:

```tsx
<StudioMark surface="dark" />
<StudioMark surface="light" />
<StudioMark surface="mono" />
```

`StudioBrand` automatically pairs the correct mark and STHANG wordmark for the selected surface. Do not use CSS filters to fake a surface variant.

The current application is dark, so its home screen and compact project header use the dark-surface identity.

## Product lockup

Preferred hierarchy:

```text
[Studio mark]  [STHANG wordmark] / STUDIO
                              CAPTIONS
```

The in-house **STHANG** artwork is the dominant wordmark. `STUDIO` is a quiet product descriptor: smaller, lighter in weight, and widely tracked so it accompanies rather than competes with STHANG. Separate the two with the forward-slanted Studio-lime divider.

Use **Sthang Studio** as the product name and **Captions** as the module/workspace name.

## Colors

- Background: `#08090B`
- Parent/product ink: `#F4F6F8`
- Light-surface ink: `#15181C`
- Studio accent: `#D7FF4F`
- Muted steel: `#737B87`

Sthang orange remains the master-brand color. Inside Studio, lime is the primary product/interface accent; orange should appear sparingly only for parent-brand references.

## Derived assets

- `favicon.svg`, `sthang-studio-icon.png`, and `sthang-studio.ico` are derived application/browser icons. They use a dark rounded tile for visibility across desktop and browser chrome; the source logo itself remains transparent.
- Additional raster exports may be generated from the protected SVGs when a platform requires them; keep their backgrounds transparent unless the destination specifically requires an icon tile.

Derived assets may be regenerated from the protected source artwork. Do not alter the protected SVGs as part of routine regeneration.

## Compatibility

The branding integration changes identity assets only. Internal `@kcs/*` package scopes and legacy browser-storage keys remain intentionally unchanged for safe in-place upgrades.
