# Brand verification on Windows

The approved Sthang Studio SVG source assets are protected by `brand-manifest.json`.

On Windows, Git's automatic line-ending conversion can rewrite LF line endings to CRLF in SVG files during checkout without changing their visible artwork. That changes a raw file SHA-256 and previously caused `npm run verify:brand`, `npm run typecheck`, and `npm run build` to fail even though the approved artwork itself was unchanged.

The repository marks `apps/web/public/brand/*.svg` with `-text` in `.gitattributes` so new checkouts preserve the repository bytes exactly.

The brand verifier also canonicalizes CRLF to LF for SVG hashing. This is a narrow compatibility rule for line endings only: every other byte/content change still fails against the manifest fingerprint. It lets older Windows working trees validate safely without weakening the protection against artwork edits.

If verification still fails after pulling the latest `main`, treat it as a real content mismatch and do not update `brand-manifest.json` unless the owner has approved a new source asset set.
