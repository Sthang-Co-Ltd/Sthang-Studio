# Brand verification on Windows

The approved Sthang Studio SVG source assets are byte-for-byte protected by `brand-manifest.json`.

On Windows, Git's automatic line-ending conversion can otherwise rewrite LF line endings to CRLF in SVG files during checkout without changing their visible artwork. That changes the file SHA-256 and causes `npm run verify:brand`, `npm run typecheck`, and `npm run build` to fail even though the logo geometry is unchanged.

The repository therefore marks `apps/web/public/brand/*.svg` with `-text` in `.gitattributes`. Preserve that rule so Git always checks out those protected SVGs with the exact bytes stored in the repository.

If an older Windows checkout already contains CRLF-rewritten copies, pull the fixed `.gitattributes` and restore the protected SVGs from `HEAD` before re-running verification.
