# Zuradio release qualification

Qualification date: 2026-09-01, Europe/Berlin.

## Result

The Rust service/browser application is an installed Linux release candidate on
this laptop. The static Web Companion artifact is build-verified but not yet
published. A native Tauri package is not claimed.

## Installed result

- Binary: `~/.local/lib/zuradio/zuradio` and `~/.local/bin/zuradio`, version
  `0.1.0`.
- Service: `zuradio.service`, enabled and active as a systemd user service.
- Desktop launcher: `~/.local/share/applications/zuradio.desktop`.
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

- `cargo test --workspace`: 8 passed, 0 failed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Core coverage includes stale-revision rejection, listener mutation denial,
  command-ID deduplication, playlist creation/rename, queue shuffle restoration,
  symlink refusal, JavaScript-safe broadcast epochs, and single-Range parsing.
- Optimized `zuradio-daemon` release build: passed.

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
- The installer could scan before the first service startup had written its
  runtime file; upgrades now restart and actively wait for authenticated
  readiness.
- Mobile host controls and queue content were previously hidden; all output and
  queue controls are now visible at phone width.

## Remaining distribution gates

These are intentionally not represented as completed tests:

- Create and publish the public `GeorgeFejer91/zuradio` GitHub repository, enable
  Pages through GitHub Actions, and verify the public URL. Publication exposes
  the MIT source and therefore needs an explicit repository-visibility decision.
- Choose a permanent reverse-DNS bundle identifier before scaffolding/signing a
  Tauri v2 shell. This laptop also lacks the WebKitGTK development headers needed
  for a normal local Tauri Linux build.
- Run a physical-phone test over a different network and a forced-TURN route.
- Run long-duration and multiple-simultaneous-listener endurance tests.
- Add malformed-media fuzzing and decoder isolation before accepting untrusted
  uploads or libraries from other users.

The current local app remains useful without those distribution steps: it is
installed, plays and catalogs local music, exposes its full CLI, and can use a
locally served companion for the already-passing WebRTC path.
