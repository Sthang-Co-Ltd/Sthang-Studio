# Studio OTA production signer

This directory contains the production Cloudflare Worker used to sign Sthang Studio OTA release metadata without exposing the Ed25519 private key to ChatGPT, Codex, GitHub Actions, Blacksmith, a development checkout, or a release artifact.

This source is not evidence that the Worker, R2 bucket, webhook, update origin, or any signed Studio release is live. Production deployment and release evidence are recorded separately.

## Trust boundary

The Worker accepts only GitHub repository webhook deliveries at `https://signer.sthang.app/github/webhook`. A signing request is recognized only when all of these are true:

- the webhook HMAC-SHA256 signature validates using `STUDIO_GITHUB_WEBHOOK_SECRET`;
- the event is a newly created `issue_comment` for `Sthang-Co-Ltd/Sthang-Studio`;
- the issue is open and its title starts with `release:`;
- the comment body is exactly `/studio-ota-sign`;
- the sender and comment author are the approved Studio owner identity;
- the webhook delivery ID has not already been accepted.

The GitHub webhook secret is a separate Worker secret. The Studio Ed25519 private key is not a Worker secret and is not committed here; it is read through the account-level Cloudflare Secrets Store binding `STUDIO_SIGNING_KEY` and must resolve to the separately provisioned secret `STHANG_STUDIO_OTA_PRIVATE_KEY_V1`.

## No arbitrary-byte signing

The Worker does not accept a manifest or arbitrary message to sign.

Before signing, it:

1. resolves the exact current `main` commit through GitHub;
2. downloads GitHub's ZIP archive for that exact commit;
3. reads a staged private R2 `package.zip` for that same commit;
4. parses both ZIPs without executing or extracting them to a filesystem;
5. rejects traversal, protected state, encryption, unsupported compression, ZIP64, duplicate/case-colliding paths, invalid CRCs, oversized archives, or unexpected files;
6. requires the staged package's complete file set and every file byte to match the same source projection used by Studio's OTA packager;
7. requires the accepted source trust root to be provisioned with `studio-updates-ed25519-root-v1` and the exact committed public key;
8. derives release notes, dependency hashes, version, package URL, package hash, byte count, and unpacked size itself from accepted source/package bytes;
9. verifies the Secrets Store private key by signing a challenge and checking it with the registered public key;
10. signs the canonical release manifest and a separate provenance attestation.

Versioned R2 release objects are create-only. A retry may reuse an object only when its bytes already match exactly; the signer never overwrites different immutable release bytes.

## R2 layout

The private bucket defaults to `sthang-studio-updates`.

```text
staging/<accepted-main-sha>/package.zip
studio/windows/v<version>/Sthang-Studio-OTA-v<version>.zip
studio/windows/v<version>/release.json
studio/windows/v<version>/release-attestation.json
audit/webhook/<delivery-id>.json
audit/webhook/<delivery-id>.result.json
status/issues/<issue-number>.json
```

Staging is temporary release input. The versioned `studio/windows/v<version>/` namespace is immutable. `latest.json` is intentionally not created or promoted by this Worker command.

## Agent invocation without hosted runners

After a reviewed candidate is staged, ChatGPT chat mode or Codex can use the connected GitHub account to add exactly:

```text
/studio-ota-sign
```

to the authorized open release issue. GitHub sends the issue-comment webhook directly to Cloudflare. No GitHub Actions or Blacksmith runner is used for signing.

A public, non-sensitive result can be read from:

```text
https://signer.sthang.app/v1/studio/issues/<issue-number>/latest
```

That endpoint exposes only release status, version, accepted source commit, and release digests. It never returns signing secrets or provider credentials.

## Local deployment and staging

`scripts/deploy-ota-signer.ps1` performs the separately approved one-time production setup from an owner-controlled Windows machine with authenticated Wrangler and GitHub CLI sessions. It:

- ensures the private R2 bucket exists;
- generates a high-entropy GitHub webhook secret locally;
- sends that secret to the Worker through Wrangler stdin;
- injects the private Secrets Store ID only into a temporary Wrangler config, never into the repository;
- dry-runs the Worker bundle;
- deploys the Worker to the `signer.sthang.app` custom domain;
- verifies `/health`;
- creates the repository webhook for only `issue_comment` events using the same in-memory webhook secret.

`scripts/stage-ota-candidate.ps1` is the local/Codex release-preparation path. It requires an exact clean checkout of current `main`, a provisioned public trust root, committed release notes, local repository-owned validation, and then uploads only the generated OTA ZIP to `staging/<commit>/package.zip`. The Cloudflare signer independently verifies it again.

Neither script publishes a GitHub Release or promotes `latest.json`.
