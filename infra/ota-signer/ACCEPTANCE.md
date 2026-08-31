# OTA signer acceptance and deployment gate

The runner-free Studio signer source is accepted only when its exact branch head is deliberately advanced to `main`. Production deployment must use that accepted `main` source; do not deploy an unaccepted feature branch.

The owner has requested that routine Studio signing and this infrastructure setup avoid GitHub Actions and Blacksmith runner usage. The final acceptance commit therefore carries GitHub's supported `[skip ci]` annotation so a separately approved direct fast-forward to `main` can avoid the repository's push-triggered Actions workflow. No pull request is required for this exceptional quota-preserving acceptance path.

Before that direct baseline write, review the complete `main...chatgpt/ota-signer-worker` diff and confirm:

- no private signing key, recovery passphrase, webhook secret, Cloudflare credential, Secrets Store ID, secret ID, account ID, or other private provider coordinate is committed;
- the only key material in source is the public Ed25519 verification identity;
- the Worker accepts only HMAC-verified owner issue-comment commands;
- staged ZIPs are bounded, parsed without execution, and required to match the exact accepted source projection byte-for-byte;
- the accepted `main` commit is rechecked immediately before private-key use and again before immutable release-object writes;
- versioned R2 release objects are create-only;
- the signing command does not publish a GitHub Release or promote `latest.json`;
- local repository-owned checks are run before staging a release candidate;
- the accepted runtime trust root stays fail-closed until the deliberate bootstrap release provisions the public key.

After source acceptance, the separately approved production deployment is performed from an owner-controlled Windows checkout using `scripts/deploy-ota-signer.ps1`. Provider-specific IDs are supplied only as local command parameters and temporary config values and are never committed.

Deployment alone is not public OTA release evidence. The current public Studio release remains unchanged until the release, clean-Windows, immutable-object, latest-pointer, HQ, and Distribution gates are completed.
