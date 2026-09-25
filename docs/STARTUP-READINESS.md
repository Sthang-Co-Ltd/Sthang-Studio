# Local service startup readiness

Base: `d8dca9885f1646fa957e964dc76b70d16e0da1d8`.
Branch: `chatgpt/startup-readiness`.

## Behavior

The shared `scripts/dev.mjs` launcher now starts in this order:

1. Check the existing local ports and prepare the shared caption package.
2. Start the backend, then wait for HTTP 200 and JSON `ok: true` from its local
   `/api/health` endpoint.
3. Only then start Vite and wait for HTTP 200 with a completed response from `/`.
4. Open the registered default browser, or print the local URL for manual opening.

Gating Vite itself prevents an already-open browser tab from reconnecting its
`/api/jobs/events` request through a web proxy whose backend has not started yet.
This is startup ordering, not a fixed sleep or suppression of Vite error logs.
It does not hide connection errors from a backend failure after successful startup.

The order also applies when `KCS_OPEN_BROWSER=false` and on Linux. Both
`scripts/launch-studio.ps1` (Windows) and `run-macos.sh` ultimately use this same
launcher. Windows browser-association checks, the macOS default-browser command,
existing port-conflict handling and the Windows updater's exit code 42 remain intact.

Each service gets a 30-second readiness window. Each probe has a 1.2-second hard
request deadline, including body transfer, and unsuccessful probes retry after
250 ms. Backend JSON is capped at 64 KiB; errors, redirects, incomplete/invalid
JSON and `ok: false` cannot certify readiness. An unset Gemini key or unconfigured
local timing does not prevent startup when the API itself reports `ok: true`.

A readiness timeout prints an actionable error, shuts down this launcher's child
services and exits unsuccessfully. Shutdown aborts pending probes and clears their
sockets/timers before startup can advance to Vite or a browser. No project, media,
caption, key, local settings, model or update-state file is modified by the fix.

## Regression tests

```text
npm run test:startup
node --check scripts/dev.mjs
```

The suite evaluates the actual launcher source with Node VM modules, not a copied
startup algorithm. Subprocesses, port preflight and browser/OS operations are test
doubles. HTTP readiness uses real sockets on an ephemeral loopback port; tests
never bind Studio's actual ports or read the installation's private runtime state.
Test timers shorten the same startup/request/retry intervals. The VM flag is used
only by the test command; normal Studio startup needs no experimental flag or new
dependency. The suite is also included in the local `npm run ci` aggregate.

Coverage includes Windows/macOS startup with and without automatic browser opening,
Linux/manual startup, an immediate job-event request when Vite starts, refused
connections, malformed/oversized/false health responses, truncated responses,
nonresponsive/dribbling servers, readiness deadlines, cancellation, child spawn
failures/exits, updater exit code 42, and default-browser recovery.

## Validation recorded for this change

Executed on Linux with Node 22.16.0 using exact source files read through GitHub;
this environment had no connected Windows/macOS terminal and could not obtain a
complete clone because outbound GitHub DNS resolution failed.

- `npm run test:startup`: 20 passed; no skips.
- `node --check scripts/dev.mjs` and `node --check tests/dev-startup.test.mjs`: passed.
- Regression sensitivity: the two Windows/macOS automatic-browser ordering tests
  fail against the unchanged baseline launcher because it starts Vite too early.
- Changed-file whitespace checks and full changed-file review: passed.

These are executed launcher/HTTP tests with simulated platform operations, not
native Windows/macOS launch certification. Full typecheck, build, existing complete
suites and `check:public` (which requires full Git history) were not run here.
They must be run from a complete local checkout before merge/release; no GitHub
Actions or Blacksmith runner is requested for validation. GitHub API commits do not
execute local hooks. No release asset, OTA pointer or installed app is changed.

For native acceptance, leave an existing Studio tab open, stop its current launcher,
and launch the new source on Windows and Apple Silicon macOS. Confirm backend
readiness precedes "Starting web app", the app opens in the default browser, and
Activity reconnects without the startup proxy refusal. Also check Ctrl+C during
startup does not leave newly started services running. Do not replace or clear user
runtime state to test this fix.

## Public impact

Public impact: none. This corrects the existing readiness behavior promised by
`AGENTS.md` and the Windows/macOS source-installation guidance in `README.md`.
The manifest's release/access, installation, compatibility, feature, identity and
privacy claims are unchanged; no new provider, dependency, transfer or collection
is introduced. `PRIVACY.md`, ordinary installation commands, downloads, artwork
and the pending preview-feature proposal in `.sthang/product-manifest.json` are
unchanged. No new HQ field, Distribution `/studio/` copy, intake proposal or
publication is required for this startup-order correction. The separate preview
feature's already-recorded public-impact follow-up is not superseded.
