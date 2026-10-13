# Sthang Studio v0.86 release evidence

The package version is `0.86.0`. Source preparation and release execution are
recorded in pull request #73 and release issue #74. A source commit, local build,
or GitHub draft does not establish a public download or signed update offer.

## Apple Silicon prerequisite runtime

GitHub Actions run `38443742914` built FFmpeg and ffprobe 8.1.3 from source commit
`5285ae5543aaaf11dca569873c7f282f993dbd2e`. The source lock contains nine exact
upstream archives, including the build tools. Both resulting executables are
arm64 Mach-O files with a macOS 12.3 deployment floor and only macOS system
dynamic dependencies. Native checks passed for CoreText/libass Khmer rendering,
complex shaping, H.264/AAC encoding and ffprobe inspection.

The paired artifacts are:

| Artifact | SHA-256 |
| --- | --- |
| `Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-tools.zip` | `adeadc9e75aea26ebed1fe1c2500d70957c51d6b102f26c967045b5e71231767` |
| `Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-corresponding-source.zip` | `3bccacd6904efd4aa32d83a20d84a8bc17a23ab98707227397f54f738d0fe24b` |

The tools, complete corresponding source, original license notices, build receipt
and checksum sidecars belong together on the support release
`runtime-ffmpeg-8.1.3-macos-arm64-r1`. The installed managed runtime retains its
license/source directions. Studio invokes FFmpeg as a separate GPL-licensed
program; Studio's MIT license applies to its own application and build recipes.
See [the source and license review](MACOS-FFMPEG-PROVENANCE.md).

## Application and update acceptance

The application uses the same package and dependency identities on both platforms.
Windows recovery contains the source runtime and reviewed setup; the curated Mac
recovery contains the production build authenticated by
`.sthang/macos-release-build.json`. Installer and OTA inputs must match the exact
accepted source and their reviewed checksums.

The manual native acceptance workflows exercise the installed `0.85.6` broker
against the exact candidate packages on disposable GitHub-hosted Windows and
Apple Silicon macOS runners. Their ephemeral test signatures are confined to
those installations and are restored afterward. Synthetic fault cases and
actual native installation/health results are reported separately. These checks
do not use production signing material or promote public pointers.

The production release requires separate immutable signing and public signature,
manifest, package-hash and pointer verification. Exact native execution and public
promotion results are retained in release issue #74. Tests on the hosted runner
do not imply that every supported hardware or operating-system version was run.
