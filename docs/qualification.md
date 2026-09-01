# Zuradio release qualification

Qualification date: 2026-09-01, Europe/Berlin.

## Result

Zuradio is an installed Linux release candidate on this laptop: Rust service,
complete CLI, least-privilege Tauri shell, Debian package, AppImage, and public
Web Companion. Native packages remain unsigned, and physical-phone,
forced-TURN, and endurance qualification remain release-channel gates.

## Installed result

- Binary: `~/.local/lib/zuradio/zuradio` and `~/.local/bin/zuradio`, version
  `0.1.0`.
- Service: `zuradio.service`, enabled and active as a systemd user service.
- Desktop launcher: `~/.local/share/applications/zuradio.desktop`.
- Native AppImage: `~/.local/lib/zuradio/Zuradio.AppImage`, bundle identifier
  `com.georgefejer.zuradio`.
- Data directory: `~/.local/share/zuradio`, mode 0700.
- Per-launch runtime credentials: `runtime.json`, mode 0600.
- Network listener: random loopback-only port.
- Installed production web assets: host, companion, shared stylesheet, and
  pinned bundled VDO.Ninja SDK; no runtime JavaScript CDN.

The installer was run twice after its readiness race was corrected. The final
run completed all internal checks, restarted the existing service, waited for a
successful authenticated status request, scanned the configured Music folder,
and reported success.

## Automated evidence

### Rust

- `cargo test --workspace`: 11 Rust domain, daemon, CLI, and Tauri shell tests
  passed, 0 failed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Core coverage includes stale-revision rejection, listener mutation denial,
  command-ID deduplication, playlist creation/rename, queue shuffle restoration,
  symlink refusal, JavaScript-safe broadcast epochs, explicit CLI boolean
  parsing, and single-Range parsing.
- Optimized `zuradio-daemon` release build: passed.

### Native desktop shell

- Tauri v2 release source compiled against WebKitGTK 2.52.6 from a local build
  sysroot without modifying the system package database.
- Debian and self-contained AppImage bundles were built; inspection found the
  host/companion web resources, no music files, and bundled GStreamer playback
  plug-ins including `appsink` and `playback` in the AppImage.
- The installed AppImage launched at the laptop's 2360 × 1520 HiDPI size and
  rendered the complete library, queue, transport, scan, search, and broadcast
  interface.
- Process inspection found one healthy systemd daemon plus one desktop shell;
  the shell reused the existing authority instead of starting a duplicate.
- The Tauri capability grants zero WebView permissions. Unit tests reject
  HTTPS, `localhost`, non-loopback hosts, missing bootstrap secrets, wrong
  paths, and follow-up navigation to a different loopback port.

### Installed CLI

`scripts/qualify-cli.sh` started the optimized installed-style daemon with a
fresh temporary database and exercised the executable rather than calling Rust
internals directly. It passed scanning, search, play/pause/stop, seek,
next/previous, volume, explicit mute true/false, shuffle true/false, all repeat
modes, queue add/move/remove/clear, favorite true/false, and playlist
create/list/add/move/remove/rename/delete. Final canonical state was checked with
`jq`, and the temporary daemon/database were removed.

### Web and dependencies

- Node.js 22.23.2 / npm 10.9.8.
- TypeScript `tsc --noEmit`: passed.
- Vitest 3.2.7 invitation/parser suite: 3 passed, 0 failed.
- Vite 7.3.6 production host build: passed.
- `npm audit`: 0 vulnerabilities after upgrading Vite, Vitest, and Playwright.
- `npm audit --omit=dev`: 0 production vulnerabilities.
- `@vdoninja/sdk`: exactly 1.5.5.

### Live browser UI

Playwright 1.62.1 with Chromium 151 ran ten tests with one worker. The complete
matrix passed first against the development release build and then again against
the binary and web files installed under `~/.local` using an isolated database:

1. Real VDO.Ninja broadcast with separate host, listener, and controller browser
   contexts, an attached live audio `MediaStreamTrack`, fragment erasure,
   sanitized listener now-playing data, and controller authentication.
2. Scan, search, album, artist, group-to-library navigation, and library browsing.
3. Playlist create, select, populate, reorder, remove, rename, and delete.
4. Play, pause, resume, stop, next, previous, seek, volume, mute, favorite,
   history, shuffle, order restoration, and repeat modes.
5. Queue add, move, remove, and clear.
6. Separate controller/listener invitation creation, clipboard copy, and Stop
   revocation.
7. Keyboard reachability and 390 × 844 responsive layout.
8. Loopback health and unauthenticated snapshot rejection.
9. Safe no-invitation/offline landing behavior and editable malformed-link
   validation.
10. Forged-proof rejection, listener escalation denial, actor overwrite, valid
   controller acceptance, peer binding, replay rejection, and grant revocation.

Page and console error collectors were empty in the passing live-stream run.
Phone-width screenshots were visually inspected for the host, controller, and
listener layouts.

The final installed-byte rerun used the installed optimized daemon and web
assets with a disposable database and the public Pages companion. All 10 tests
passed in 30.9 seconds. The first harness attempt correctly exposed missing
fixture pre-scan and preview-server setup; after those test prerequisites were
made explicit, the complete matrix passed without a product-code change.

## Static companion boundary

`npm run build:pages` produced a 180 KiB `web/dist-pages` artifact containing
only:

- `index.html`;
- `companion/index.html`;
- one CSS asset; and
- one JavaScript asset.

An automated invariant check found no AAC, AIFF, ALAC, FLAC, M4A, MP3, MP4,
OGG, Opus, WAV, or WebM files and no `/api/v1/media` reference. The Pages
workflow repeats typechecking, unit tests, the companion-only build, and those
negative assertions before upload.

The public source is [GeorgeFejer91/zuradio](https://github.com/GeorgeFejer91/zuradio).
The [Zuradio Web Companion](https://georgefejer91.github.io/zuradio/) is live
over HTTPS, returns the companion-only interface, and passed both the Verify
Zuradio and Deploy Zuradio Web Companion GitHub Actions workflows.

## Defects found and corrected during qualification

- JavaScript precision loss for random Rust `u64` broadcast epochs broke HMAC
  transcripts; epochs are now generated inside the JavaScript safe-integer
  range.
- Disabling shuffle did not recover the original queue; the pre-shuffle queue is
  now persisted and restored while retaining later additions.
- A late listener could miss now-playing state; the host now publishes it when
  that peer's data channel opens.
- The controller accepted no proof of the Rust side; mutual server-proof
  verification is now required.
- The companion could display “Controller connected” before receiving the
  mutually authenticated initial snapshot; success now waits for both.
- A malformed pasted invitation was erased during validation; it now remains
  editable while the error is shown.
- Local user actions could race a short track's automatic `next`, causing stale
  revisions; host mutations are now serialized.
- Clap interpreted positional boolean values as presence flags, preventing CLI
  commands from expressing both enabled and disabled states; mute, shuffle, and
  favorite now require and parse explicit `true` or `false` values.
- The installer could scan before the first service startup had written its
  runtime file; upgrades now restart and actively wait for authenticated
  readiness.
- Mobile host controls and queue content were previously hidden; all output and
  queue controls are now visible at phone width.

## Remaining release-channel gates

These are intentionally not represented as completed tests:

- Run a physical-phone test over a different network and a forced-TURN route.
- Run long-duration and multiple-simultaneous-listener endurance tests.
- Add malformed-media fuzzing and decoder isolation before accepting untrusted
  uploads or libraries from other users.
- Sign Linux artifacts and add Windows code signing, macOS notarization,
  auto-update metadata, and supply-chain attestations before a stable native
  release.

The release candidate is installed, plays and catalogs local music, exposes its
full CLI, and uses the public static companion for the already-passing WebRTC
path without hosting the music collection.
