# Zuradio

Zuradio turns one laptop into a private music library, local player, and live
radio source. The Rust service owns the catalog, queue, playlists, favorites,
history, authorization, and every state change. **Zuradio Web Companion** is a
static phone-friendly listener/controller that connects to a broadcast started
on the laptop.

Music is never uploaded to or hosted by the companion site. GitHub Pages ships
only about 180 KiB of HTML, CSS, and JavaScript. While broadcasting, the laptop
decodes the selected local file and publishes that same live audio through the
official VDO.Ninja SDK/WebRTC path. Turning the laptop or broadcast off makes
the stream unavailable.

## What works

- Recursive AAC, AIFF, ALAC, FLAC, M4A, MP3, MP4, OGG, Opus, WAV, and WebM
  catalog scans with metadata and bounded embedded-artwork reads. Real WAV,
  FLAC, AIFF, MP3, and OGG fixtures are included in browser qualification.
- Search and browsing by library, album, artist, favorite, history, and
  persistent ordered playlist.
- One canonical queue with play, pause, stop, next, previous, seek, volume,
  mute, shuffle with order restoration, and off/all/one repeat modes.
- A complete CLI over the same typed Rust action model used by the UI.
- A loopback-only local web player, installed as a hardened systemd user
  service on Linux, plus a Tauri v2 desktop shell with no WebView IPC
  permissions and the bundle identifier `com.georgefejer.zuradio`.
- Explicit Start/Stop Broadcast controls and separate password-gated listen,
  control, and upload invitations.
- A read-only listener UI, a controller UI with player, queue, favorite, and
  playlist controls, and a folder/file upload UI that writes directly to this
  laptop rather than GitHub Pages.
- A managed local repository under the Zuradio data directory. Uploads are
  integrity-checked, classified from embedded tags plus folder/file names, and
  organized by artist, album, year, track, and title. Metadata can be corrected
  from the desktop UI and those overrides survive rescans.
- Real WebRTC audio and data channels through `@vdoninja/sdk` 1.5.5. VDO.Ninja
  transports packets; Rust independently proves and authorizes controllers.

## Install on Linux

Requirements are Rust, Node.js 22+, npm, a Chromium-class browser, systemd user
services, and the normal desktop helpers (`xdg-open` and `xdg-user-dir`). No
root access is required.

```sh
./scripts/install-local.sh
```

The installer performs locked web installation, TypeScript and unit checks, a
production web build, Rust tests, and an optimized Rust build before replacing
the installed files. It then installs:

- `~/.local/bin/zuradio` and `~/.local/bin/zuradio-launch`;
- `~/.local/lib/zuradio/` for the daemon and local UI;
- `~/.config/systemd/user/zuradio.service`;
- `~/.local/share/applications/zuradio.desktop`; and
- private state under `~/.local/share/zuradio/`.

Launch **Zuradio** from the application menu or run:

```sh
zuradio-launch
```

The native Tauri release candidate can be installed after building or
downloading its AppImage:

```sh
./scripts/install-tauri-appimage.sh
```

This replaces only the application-menu launcher with the Tauri/WebKitGTK
window. The same systemd service, CLI, library, database, and private runtime
credentials remain authoritative. The AppImage is installed at
`~/.local/lib/zuradio/Zuradio.AppImage` and can also be opened with
`zuradio-desktop-launch`.

The service starts at login and binds to a random `127.0.0.1` port. Its runtime
credential file is mode 0600. The browser exchanges a one-use fragment secret
for an `HttpOnly`, `SameSite=Strict` cookie and erases the fragment.

Remote access uses one password stored in `zuradio.txt` on the desktop. On
Linux, Zuradio discovers either `~/Desktop/zuradio.txt` or
`~/Schreibtisch/zuradio.txt`; the file must contain 8–256 bytes and must not be
readable by group or other users (`chmod 600`). It can also be selected with
`--remote-password-file` or `ZURADIO_REMOTE_PASSWORD_FILE`. The password is
never placed in an invitation, database, GitHub Pages artifact, or log.

## Add music and use the CLI

The installed service uses the desktop Music folder (on this machine,
`~/Musik`). Put music there and press **Scan library**, or scan one or more
folders from the CLI:

```sh
zuradio scan "$HOME/Musik"
zuradio tracks
zuradio tracks --query river
zuradio status
```

Every player and collection mutation has a typed command. Track and playlist
IDs are shown by `tracks`, `status`, and `playlist list`.

```sh
zuradio play TRACK_ID
zuradio pause
zuradio seek 45000
zuradio volume 65
zuradio mute true
zuradio shuffle true
zuradio repeat all
zuradio queue add TRACK_ID
zuradio queue move 2 0
zuradio playlist create "Late night"
zuradio playlist add PLAYLIST_ID TRACK_ID
zuradio favorite TRACK_ID true
```

Run `zuradio --help` or a subcommand with `--help` for the complete surface.
CLI commands control canonical Rust state. Audio output is produced by the open
host UI, so the browser must be open and must have received a playback gesture
before browser autoplay policy allows unattended CLI playback.

Authorized upload invitations accept individual files or a browser-selected
folder. Files are transferred sequentially over the encrypted live data bridge,
checked with SHA-256, staged until the whole batch validates, and then moved to
`~/.local/share/zuradio/library/`. Upload limits are 512 files, 512 MiB per file,
and 16 GiB per batch. See [the upload protocol](docs/upload-protocol.md).

## Broadcast to a phone

1. Open Zuradio on the laptop and select a track.
2. Open **Broadcast** and choose **Start broadcast**. This explicit local gesture
   unlocks audio capture and creates fresh credentials.
3. Send the listen invitation to someone who may hear the live stream and see
   sanitized now-playing data. They must enter the Zuradio password.
4. Use the control invitation for player, queue, favorite, and playlist access,
   or the upload invitation for adding files/folders to the managed repository.
   The same password unlocks each link, but Rust grants only that link's mode.
5. Choose **Stop broadcast** to close peers, discard partial uploads, and revoke the complete broadcast
   epoch. Old links cannot rejoin a later session.

Invitation credentials live after `#` in the URL, so they are not sent in the
HTTP request to GitHub Pages. The companion removes the fragment immediately
and keeps it only in memory. It registers no service worker and has no catalog
or media endpoint.

## Development and qualification

```sh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
ZURADIO_TEST_MUSIC=/path/to/test-music ./scripts/qualify-cli.sh
cd web
npm ci
npm audit
npm run typecheck
npm test
npm run build
ZURADIO_RUNTIME=/path/to/runtime.json npx playwright test
npm run build:pages
```

The Playwright suite uses independent browser contexts for the laptop,
listener, controller, and uploader. It validates a real VDO.Ninja media/data
path, password proof, uploads, metadata edits, WAV/FLAC decode, all local and
remote controls, responsive layouts, mode isolation, peer/session binding,
monotonic replay rejection, and Stop-based grant revocation. See
[release qualification](docs/qualification.md)
for the exact evidence and remaining distribution gates.

## Project layout

- `crates/zuradio-core`: scanner, SQLite catalog/state, closed actions, queue,
  playlists, favorites, history, and revision/deduplication rules.
- `crates/zuradio-daemon`: CLI, loopback HTTP/WebSocket server, authenticated
  Range/artwork endpoints, broadcast sessions, and remote grant enforcement.
- `apps/zuradio-desktop`: least-privilege Tauri v2 shell that reuses a healthy
  local service or starts the same Rust authority in process; it accepts only
  exact `127.0.0.1` host navigation and exposes no Tauri commands to the WebView.
- `web/src/host.ts`: local player UI, Web Audio output, and VDO.Ninja publisher.
- `web/src/companion.ts`: static listener/controller/uploader UI.
- `packaging/linux` and `scripts/install-local.sh`: local Linux installation.
- `scripts/qualify-cli.sh`: disposable end-to-end qualification of the complete
  installed CLI mutation surface.
- `scripts/qualify-browser.sh`: disposable real-browser qualification against
  the VDO.Ninja bridge, including generated WAV/FLAC format fixtures and upload
  performance checks.
- `scripts/benchmark-library.sh`: repeatable scan, snapshot, media Range, and
  resident-memory thresholds over a 60-track corpus.
- `.github/workflows/pages.yml`: companion-only GitHub Pages deployment with a
  build-time assertion that rejects media files and local media API references.

Design rationale is in [architecture](docs/architecture.md),
[threat model](docs/threat-model.md), and
[source research](docs/research.md).

## Distribution status

The Linux service, CLI, Tauri desktop shell, Debian package, and AppImage are
built and qualified on this laptop. The public source is available at
[GeorgeFejer91/zuradio](https://github.com/GeorgeFejer91/zuradio), and the
[Zuradio Web Companion](https://georgefejer91.github.io/zuradio/) is deployed
through GitHub Pages. The cross-platform CI matrix builds the Tauri source on
Linux, Windows, and macOS; signing/notarization and physical-device/forced-TURN
qualification remain separate release-channel gates.

Zuradio is MIT licensed. The pinned VDO.Ninja SDK is MPL-2.0; see
[third-party notices](THIRD_PARTY_NOTICES.md).
