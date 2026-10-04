# Reviewed dependency and runtime maintenance

Change ID: `studio-dependency-runtime-hardening-20261004`

## Source change and release boundary

This maintenance work is prepared against Studio main `814fb61`. It is separate
from the playback/update-safety change in PR #65. It does not publish a release,
promote an update pointer, or replace the accepted `v0.85.6` release evidence.
The public-release manifest continues to describe that accepted release.

The intended compatibility boundary remains Windows x64 and native Apple Silicon
macOS 12.3 or newer. macOS 12.3–13.4 requires Node 22. Source/runtime validators
accept the maintained Node 22.23.3+ and 24.21.0+ lines, subject to the existing OS
gate; Node 25 and unreviewed future majors are not accepted. Safari 17 remains the
production build target. No Gemini model selection, alignment mathematics,
user project format, paid service, or cloud data destination is changed.

Windows private Node 24.21.0 uses the official `node-v24.21.0-win-x64.zip`
archive, SHA-256
`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`,
checked against Node's versioned `SHASUMS256.txt`. Selection is process-local and
does not replace a system Node installation.

## JavaScript dependency inventory

| Dependency | Previous lock | Reviewed lock | Scope |
| --- | --- | --- | --- |
| `@google/genai` | 2.22.0 | 2.27.0 | Server runtime |
| `proxy-addr` | 2.0.7 | 2.0.8 | Express runtime transitive; CVE-2026-90711 |
| `protobufjs` | 7.6.5 | 7.6.6 | GenAI runtime transitive |
| `lucide-react` | 1.44.0 | 1.51.0 | Browser UI |
| `vite` | 8.3.0 | 8.3.2 | Build/source and Windows web launcher |
| `rolldown` | 1.2.8 | 1.2.12 | Vite transitive |
| `tsx` | 4.23.13 | 4.23.15 | Source launcher and tests |
| `@types/node` | 24.13.4 | 24.19.1 | Types; preserve supported Node 22 API compatibility |
| `@types/multer` | 2.2.0 | 2.3.0 | Types |
| `undici` override | 7.29.1 | 7.30.0 | Wrangler/Miniflare tooling transitive |

`npm ci` remains mandatory. The checked-in lock, including native optional
packages, is the install authority. React/React DOM, Express, Multer, Nanoid,
TypeScript, Playwright, plugin-react, Wrangler and dotenv are not upgraded by
this change. The curated macOS runtime still installs only server/shared
production dependencies and serves the prebuilt web application; it must not
include Vite, tsx, esbuild, TypeScript, React or Lucide npm runtime packages.

The proxy-addr issue requires a particular trust-proxy configuration; Studio
does not configure that vulnerable condition. The regression test still checks
the vulnerable subnet spelling against unrelated IPv4 clients. An npm audit
result of zero is not treated as proof that the dependency graph has no known
advisories: the upstream proxy-addr advisory was found independently.

## Python and privacy controls

The private CPython candidate is **3.12.15+20261003** from Astral's official
`python-build-standalone` release. No Python minor upgrade is included. Its
versioned upstream archives have these published SHA-256 digests:

| Target | Archive | SHA-256 |
| --- | --- | --- |
| Apple Silicon | `cpython-3.12.15+20261003-aarch64-apple-darwin-install_only.tar.gz` | `316a463172740e71d8dca1f2730784e325f3f720941137b5d674d5801a632213` |
| Windows x64 | `cpython-3.12.15+20261003-x86_64-pc-windows-msvc-install_only.tar.gz` | `4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08` |

The new platform locks under `local-timing/locks/` are the exact reviewed
dependency inventories. They separate Windows, Monterey/Ventura and macOS 14+
profiles and pin tooling, versions and upstream artifact hashes. Native source
builds are forbidden; the documented pure-Python `emoji==2.6.0` source exception
remains. KFA 0.2.0, khmercut 0.0.2, sosap 0.4.3, NumPy 1.26.4 and the supported
platform tokenizer pins remain constrained. Requests is updated to a patched
locked version rather than permitting an already-installed 2.31 release.

Official ONNX Runtime native builds can enable telemetry. The worker, setup and
its checks disable telemetry before ONNX initialization. Server-launched Python
processes receive the opt-out environment before the interpreter starts, covering
both persistent-worker and one-shot recovery paths. `ORT_DISABLE_TELEMETRY=1`
must be present before import on non-Windows; a later API call alone can miss an
initialization event. The supported API is also disabled where available.
Hugging Face's telemetry opt-out is set before model-library import. Model
downloads remain explicit setup/lazy-fallback operations; these controls do not
claim that a first installation requires no network.

The audit established a missing privacy control, not that Studio had transmitted
media, captions or telemetry. Release acceptance must independently verify the
new behavior on both native platforms.

## Migration and authentication requirements

An existing environment is reusable only when its reviewed Python and exact lock
inventory pass validation. A changed lock must not be bypassed by the old
"already READY" shortcut. Candidate environments are prepared at stable paths
outside the relocatable OTA source tree, validated, then selected through the
version's `.venv` link/junction. Existing environments and user-owned state must
remain available for rollback; interruption recovery and concurrent setup are
part of the transaction contract.

Preserve the existing signed-update protocol. New lock data is authenticated by
the signed whole-package hash before extraction or execution, then checked
against the authenticated in-package inventory before provisioning. Do not add
new `pythonFiles` keys that make released brokers reject an otherwise compatible
manifest. No unsigned external lock path may influence installation.

An already-released Windows broker invokes its initial `npm ci` before any new
candidate script can select a different interpreter. That initial process retains
the old broker's Node/npm behavior. Once candidate setup has provisioned private
Node, candidate build/typecheck/application entrypoints select the reviewed
runtime or fail safely; they must not activate/run using an excluded Node version.
No package lifecycle hook is introduced to mutate the old broker's interpreter.
Replacing the initial legacy process itself requires a separate broker/manual
installation upgrade; it is not represented as solved by this source change.

## Deferred replacements

- **FFmpeg:** neither platform pin changes here. Windows 9.0.2 still needs native
  codec/shaping/export acceptance. The Mac 0.5.0 vendor archive is covered only
  by the exact `v0.85.6` provenance exception. Upstream 8.1.2 fixes
  CVE-2026-8461 and CVE-2026-30999; a compatible, provenance-reviewed replacement
  needs a separate decision and must not inherit that exception silently
- **Tokenizer stack:** tqdm 4.65.0's CVE-2024-34062 concerns malicious CLI
  arguments; Studio does not invoke its CLI. Its exact pin remains required by
  the supported khmercut stack. A coordinated migration needs clean native tests
- **Python build tooling:** setuptools 80.10.2 retains `pkg_resources`, required
  by pinned CTranslate2 4.6.0. Newer setuptools removes that API. The retained
  release has CVE-2026-59890, a macOS Unicode `MANIFEST.in` exclusion bypass when
  producing source distributions. Studio does not build/publish sdists from
  user files; its sole source build converts the exact hash-pinned emoji archive
  to a wheel. No reachable disclosure route was identified in that flow. A
  coordinated compatible migration is needed to remove this advisory pin
- **Major migrations:** Node 26, Python 3.13+, NumPy 2, librosa 1, SciPy 1.18,
  dotenv 18 and direct overrides of GenAI's major transitive versions are deferred
- **Maintainer tooling:** no Wrangler deployment or Cloudflare compatibility-date
  change is included

## Inherited transport-cancellation limitation

Independent review reproduced a native Node `Request.clone()` cancellation issue
in **both reviewed Node 22.23.3 and 24.21.0**, with no preload or network required:
after forced garbage collection, aborting the original controller marks the
original Request signal aborted but leaves its cloned Request signal un-aborted.
The original controller, Request and clone were all strongly retained.

The same local-loopback check was run with **baseline GenAI 2.22.0 and candidate
2.27.0 on both Node versions**. Each made one transport call and one loopback
request. Without forced GC the transport observed one abort; with GC it observed
zero. On Node 24, the GC case also left the original HTTP socket open after the
visible deadline while the non-GC case closed it. This is an inherited runtime
limitation, not a demonstrated SDK-upgrade regression.

Studio's deadline still rejects and returns control to the caller. That must not
be confused with proof that the underlying provider request stopped: it may
continue after the visible timeout. No production transport workaround is included
in this maintenance change. Fixing it is a separate scoped decision.

The strict assertions are preserved as explicit known-failure diagnostics:

```text
npm run diagnose:node-abort
npm run diagnose:gemini-abort
```

They use forced GC and are expected to exit nonzero on the reviewed runtimes.
The first performs no network activity; the SDK diagnostic uses an offline mock
transport and a non-secret fixture key. Normal `test:gemini` still exercises the
visible deadline, real SDK request/privacy shapes and single-attempt retry
behavior, but does not claim that the strict transport-abort diagnostic passes.

## Local validation on 2026-10-04

- Clean npm installation, typecheck and production build passed on reviewed
  Node 24.21.0; Node 22.23.3 typecheck and focused compatibility suites passed
- macOS policy/installer fixtures: 116 passed; these are not native Mac execution
- Complete Python timing policy/privacy/migration suite: 57 passed
- Dependency/Windows Node bootstrap: 20 passed; actual persistent/recovery
  child-process privacy test passed
- Stable Gemini suite: 23 passed, including two real-SDK offline transport tests;
  the strict cancellation diagnostics above remain known failures
- Updater JavaScript suite: 51 passed, one existing Windows-only skip
- An isolated server/shared production-only install and API/UI/security-header
  smoke passed on Linux Node 22, without build/web packages in the runtime graph
- Official Python/Node archive byte hashes and architectures were verified;
  independent Mac wheel Mach-O inspection found a legacy maximum of 12.3 and
  modern maximum of 14.0. This does not replace native execution
- A fresh Linux CPython 3.12.15 environment installed the same reviewed package
  versions using verified Linux artifacts and passed native imports, Khmer
  tokenizer/phonemizer, synthetic resampling/FFT and Numba JIT. No acoustic model
  inference or Whisper model download was performed
- PowerShell 7.6.6 parsed all scripts. Running the Windows updater fixture on
  Linux hit the same Windows path-separator failure as untouched main; this is
  not native Windows/PowerShell 5.1 acceptance
- Chromium and tsx watcher execution were blocked by the host's Unix-socket
  policy. Browser collection found 154 tests; no browser execution pass is claimed
- One Khmer word-partition assertion, five native persistent-preview assertions
  and two native effect assertions failed identically with untouched main's old
  dependencies on this host. They are retained as unresolved baseline evidence

## Required acceptance before release

1. Clean locked installs and typecheck/build on reviewed Node 22 and 24
2. Gemini upload reuse, request abort/deadline, retry/fallback and privacy tests
3. Real browser regressions with Safari-target build behavior and icon inspection
4. Clean Windows x64 installation with no preinstalled Python, plus retained
   legacy `.venv`, interrupted setup, concurrent setup and rollback cases
5. Native Apple Silicon macOS 12.3/13 and 14+ wheel imports, Mach-O deployment
   floors, KFA model/tokenizer inference and lazy Whisper fallback
6. Network observation proving telemetry is disabled before initialization
7. Signed-package tamper checks, staging-to-version relocation and activation
   health/rollback, preserving project/media/history/credentials
8. Native FFmpeg preview/export tests against the exact selected runtime

Linux tests and archive inspection are not substitutes for the native acceptance
above. Generated build hashes bind source outputs; they are not an approval of a
new public release or native platform compatibility.

Public impact: **required before publication**. This changes installation,
runtime security floors and privacy controls. README, privacy/third-party notices,
macOS compatibility and update documentation must stay aligned. Maintainer HQ
intake and Distribution `/studio/` documentation synchronization remain separately
authorized steps; no website or release availability claim changes here.

## Official sources

- [Python 3.12.15 security release](https://www.python.org/downloads/release/python-31215/)
- [Astral 20261003 assets](https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/20261003)
- [proxy-addr advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
- [ONNX Runtime privacy controls](https://github.com/microsoft/onnxruntime/blob/v1.30.0/docs/Privacy.md)
- [Requests TLS advisory](https://github.com/psf/requests/security/advisories/GHSA-9wx4-h78v-vm56)
- [Requests credential advisory](https://github.com/psf/requests/security/advisories/GHSA-9hjg-9r4m-mvj7)
- [Vite 8.3.2](https://github.com/vitejs/vite/releases/tag/v8.3.2)
- [GenAI 2.27.0](https://github.com/googleapis/js-genai/releases/tag/v2.27.0)
- [Lucide 1.51.0](https://github.com/lucide-icons/lucide/releases/tag/1.51.0)
- [FFmpeg security fixes](https://ffmpeg.org/security.html)
- [tqdm advisory](https://github.com/tqdm/tqdm/security/advisories/GHSA-g7vv-2v7x-gj9p)
- [setuptools advisory](https://github.com/pypa/setuptools/security/advisories/GHSA-h35f-9h28-mq5c)
