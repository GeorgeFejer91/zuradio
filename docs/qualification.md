# Zuradio release qualification

Qualification date: 2026-09-01, Europe/Berlin.

## Result

Zuradio is an installed Linux release candidate on this laptop: Rust service,
complete CLI, dedicated Chromium WebRTC app window, least-privilege Tauri
fallback, Debian package, AppImage, and public Web Companion. Native packages remain unsigned, and physical-phone,
forced-TURN, and endurance qualification remain release-channel gates.

## Installed result

- Binary: `~/.local/lib/zuradio/zuradio` and `~/.local/bin/zuradio`, version
  `0.1.0`.
- Service: `zuradio.service`, enabled and active as a systemd user service.
- Desktop launcher: `~/.local/share/applications/zuradio.desktop`.
- Dedicated browser runtime: Chromium 151 under `~/.local/lib/zuradio/chromium`
  with a private profile and unattended-audio policy.
- CI-built native Tauri fallback: `~/.local/lib/zuradio/zuradio-desktop`.
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

- `cargo test --workspace --exclude zuradio-desktop`: 19 Rust domain, daemon,
  and CLI tests passed, 0 failed (10 core, 8 daemon, 1 CLI).
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Core coverage includes stale-revision rejection, listener mutation denial,
  command-ID deduplication, playlist creation/rename, queue shuffle restoration,
  symlink refusal, all 12 accepted audio extensions, upload path/offset/size and
  digest rejection, metadata inference, JavaScript-safe broadcast epochs,
  explicit CLI boolean parsing, and single-Range parsing.
- Optimized `zuradio-daemon` release build: passed.

### Desktop shells

- Tauri v2 release source compiled against WebKitGTK 2.52.6 from a local build
  sysroot without modifying the system package database.
- Debian and self-contained AppImage bundles were built; inspection found the
  host/companion web resources, no music files, and bundled GStreamer playback
  plug-ins including `appsink` and `playback` in the AppImage.
- The installed app-window launcher rendered the complete library, queue,
  transport, scan, search, and broadcast interface. Runtime inspection proved
  `RTCPeerConnection` is present, the audio context is running without a
  gesture, the broadcast is active by default, and all three CC0 tracks are
  cataloged.
- Debian WebKitGTK 2.52.5 exposes the WebRTC setting but was compiled without
  the base WebRTC feature. The launcher therefore prefers the installed
  Chromium app shell and retains the Tauri binary/AppImage as local-only
  fallbacks rather than falsely reporting a working remote bridge.
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
- Vitest 3.2.7 rendezvous parity and browser format suites: 4 passed, 0 failed.
- Vite 7.3.6 production host build: passed.
- `npm audit`: 0 vulnerabilities after upgrading Vite, Vitest, and Playwright.
- `npm audit --omit=dev`: 0 production vulnerabilities.
- `@vdoninja/sdk`: exactly 1.5.5.

### Live browser UI

Playwright 1.62.1 with Chromium 151 ran 16 tests with one worker. The complete
matrix passed first against the development release build and then again against
the binary and web files installed under `~/.local` using an isolated database:

1. Real VDO.Ninja broadcast with separate host, listener, and controller browser
   contexts, password-only rendezvous, an attached live audio
   `MediaStreamTrack`, sanitized listener now-playing data, and controller
   authentication.
2. Scan, search, album, artist, group-to-library navigation, and library browsing.
3. Phone-width playlist-library create, select, populate through the dedicated
   track picker, reorder, remove, rename, save, reopen, and delete.
4. Play, pause, resume, stop, next, previous, seek, volume, mute, favorite,
   history, shuffle, order restoration, and repeat modes.
5. Queue add, move, remove, and clear.
6. URL-free Listen/Control/Upload buttons, password dialogs, private-route
   handoff, and Stop revocation.
7. Keyboard reachability and 390 × 844 responsive layout.
8. Loopback health and unauthenticated snapshot rejection.
9. Safe offline landing behavior with no URL field or page-load connection.
10. Forged-proof rejection, mode-transcript mismatch, listener/uploader
    escalation denial, actor overwrite, valid controller acceptance, peer
    binding, replay rejection, and grant revocation.
11. Wrong-password rejection before an audio track or authority is exposed.
12. Authenticated single-file upload, SHA-256 verification, embedded-tag
    cataloging, managed-repository visibility, and a 32 KiB/s minimum.
13. Browser folder selection, non-audio filtering, sequential three-file upload,
    and three imported catalog records.
14. Local metadata editing followed by rescan and second edit, proving override
    persistence and reusable UI state.
15. Generated, valid WAV, FLAC, AIFF, MP3, and OGG files: all five were parsed
    with approximately one-second durations; Chromium decoded WAV and FLAC.
16. Cold host launch rotates stale state and starts password discovery and the
    WebRTC broadcaster automatically.

Page and console error collectors were empty in the passing live-stream run.
Phone-width screenshots were visually inspected for the host, controller, and
listener layouts.

The installed Chromium app window was also exercised through the public GitHub
Pages companion, not a local companion build. Listener password-to-live was
5,996 ms, controller password-to-ready was 3,894 ms, and an acknowledged remote
play/pause command took 165 ms. The listener received one live audio track, the
controller selected `Arpent` on the installed app, and the gate enforces ceilings
of 15 seconds for connection and 2 seconds for command acknowledgement.

The final installed-byte rerun used the installed optimized daemon and web
assets with a disposable database and the same static companion bundle that is
published to Pages. Its temporary database, generated format files, staged
uploads, and copied password were removed automatically.

The repeatable installed-byte 60-track performance job completed five scans at
a 55 ms average, returned an authenticated snapshot in 27 ms, served media at
28,732,439 bytes/s, and held the daemon at 10,652 KiB resident memory. A real 6.49 MB WebRTC upload
completed in about 26 seconds, and a three-file 16.2 MB folder upload completed
in about 54–57 seconds through the public VDO.Ninja path.

## Static companion boundary

`npm run build:pages` produced an approximately 168 KiB `web/dist-pages`
artifact containing
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
- A data-channel-open event could precede actual writability, causing Zuradio to
  discard the one password hello and time out. The proof key is now retained
  until a successful send and the hello is retried after the data-only view opens.
- Invitation URLs and malformed-URL states were removed; three explicit mode
  buttons now open an accessible password dialog and discover the laptop.
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
- The metadata-rescan test clicked while the host intentionally rejected input
  in its busy state; it now waits for the explicit accessible busy signal.
- Temporary upload staging names hid the true extension from Lofty and managed
  digest suffixes leaked into fallback titles; staged files now preserve their
  extension and display-name inference strips the digest.
- Discovery-channel teardown and password derivation were serialized ahead of
  private control setup; teardown is now asynchronous and key derivation runs
  concurrently with the control transport handshake.
- Controller readiness waited for an independent audio receiver connection;
  authenticated controls now become usable immediately while audio attaches in
  parallel.
- The distro WebKitGTK runtime omitted WebRTC at compile time. A real runtime
  probe caught this despite successful native compilation, and the installed
  Linux launcher now uses a dedicated Chromium app window with autoplay enabled.

## Remaining release-channel gates

These are intentionally not represented as completed tests:

- Run a physical-phone test over a different network and a forced-TURN route.
- Run long-duration and multiple-simultaneous-listener endurance tests.
- Add malformed-media fuzzing and decoder isolation before accepting untrusted
  uploads or libraries from other users.
- Sign Linux artifacts and add Windows code signing, macOS notarization,
  auto-update metadata, and supply-chain attestations before a stable native
  release.

The release candidate is installed, pinned, automatically broadcasting, plays
and catalogs local music, exposes its full CLI, and uses the public static
companion for the passing low-latency WebRTC path without hosting the music
collection.
