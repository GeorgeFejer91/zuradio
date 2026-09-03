# Zuradio

Zuradio turns one laptop into a private music library, local player, and live
radio source. The Rust service owns the catalog, queue, playlists, favorites,
history, authorization, and every state change. **Zuradio Web Companion** is a
static phone-friendly listener/controller that connects to the laptop's active
remote-access beacon. The installed desktop shell starts at login, activates a
fresh password-protected beacon, and restores it after a host or transport
failure. This makes the laptop discoverable; it does not start music playback.

Music is never uploaded to or hosted by the companion site. GitHub Pages ships
only about 180 KiB of HTML, CSS, and JavaScript. While music is playing, the laptop
decodes the selected local file and publishes that same live audio through the
official VDO.Ninja SDK/WebRTC path. Turning the laptop or Zuradio host off makes
remote access and the stream unavailable.

## What works

- Recursive AAC, AIFF, ALAC, FLAC, M4A, MP3, MP4, OGG, Opus, WAV, and WebM
  catalog scans with metadata and bounded embedded-artwork reads. Real WAV,
  FLAC, AIFF, MP3, and OGG fixtures are included in browser qualification.
- Search and browsing by library, album, artist, favorite, history, and
  persistent ordered playlist. Search covers normal tags/folder names and
  parallel Shazam title, artist, album, and genre fields.
- One canonical queue with play, pause, stop, next, previous, seek, volume,
  mute, shuffle with order restoration, and off/all/one repeat modes.
- A complete CLI over the same typed Rust action model used by the UI.
- A loopback-only local web player installed as a hardened systemd user service.
  Linux opens it in a dedicated Chromium app window for complete WebRTC and
  unattended audio support; the cross-platform Tauri v2 shell remains a
  least-privilege native fallback with no WebView IPC permissions.
- A supervised Linux desktop-host service that opens at login and restarts the
  Chromium host if its window or process exits. Its normal operating mode keeps
  the password-protected discovery beacon active for as long as the app runs.
- Always-ready remote access from the installed desktop shell, a secure beacon
  restart control, and password-discovered, separately scoped Listen, Control,
  and Upload modes with no invitation URLs. Beacon readiness never starts a song.
- A read-only listener UI, a controller UI with player, queue, favorite, and
  playlist controls, and a folder/file upload UI that writes directly to this
  laptop rather than GitHub Pages.
- A visible managed repository at `Zuradio Library` inside the computer's Music
  folder. Uploads are integrity-checked, classified from embedded tags plus
  folder/file names, and organized by artist, album, year, track, and title.
  Metadata can be corrected from the desktop UI and those overrides survive
  rescans.
- Automatic Rust SongRec/Shazam recognition after each new song is published.
  The installer supplies a pinned official helper; its independently stored
  title, artist, album, genre, match label, and provider ID are searchable but
  never rename, overwrite, or reorganize the original file.
- Real WebRTC audio and data channels through `@vdoninja/sdk` 1.5.5. VDO.Ninja
  transports packets; Rust independently proves and authorizes controllers.

## Install on Linux

Requirements are Rust, Node.js 22+, npm, a Chromium-class browser, systemd user
services, `curl`, `dpkg-deb`, and the normal desktop helpers (`xdg-open` and
`xdg-user-dir`). No root access is required.

```sh
./scripts/install-local.sh
```

The installer performs locked web installation, TypeScript and unit checks, a
production web build, Rust tests, and an optimized Rust build before replacing
the local binaries. It also downloads the official Rust SongRec 0.7.5 package
from its maintainer's PPA, verifies a pinned SHA-256 digest, and installs only
its separately licensed helper and notices. It enables both the Rust authority
and supervised desktop host as user services, so Zuradio opens with a
discoverable beacon automatically at login and recovers if the host exits.
It then installs:

- `~/.local/bin/zuradio`, `zuradio-launch`, and `zuradio-desktop-launch`;
- `~/.local/lib/zuradio/` for the daemon, local UI, and verified SongRec helper;
- `~/.config/systemd/user/zuradio.service` and `zuradio-host.service`;
- `~/.local/share/applications/zuradio.desktop`; and
- private state under `~/.local/share/zuradio/`.

Launch **Zuradio** from the application menu or run:

```sh
zuradio-desktop-launch
```

The native Tauri release candidate can be installed after building or
downloading its AppImage:

```sh
./scripts/install-tauri-appimage.sh
```

This replaces only the application-menu launcher. On Linux it prefers a
Chromium app window because many distro WebKitGTK builds omit WebRTC at compile
time; it falls back to the Tauri binary or AppImage when no Chromium-class
browser is available. The same systemd service, CLI, library, database, and
private runtime credentials remain authoritative.

The service starts at login and binds to a random `127.0.0.1` port. Its runtime
credential file is mode 0600. The browser exchanges a one-use fragment secret
for an `HttpOnly`, `SameSite=Strict` cookie and erases the fragment.

Remote access uses one password stored in `zuradio.txt` on the desktop. On
Linux, Zuradio discovers either `~/Desktop/zuradio.txt` or
`~/Schreibtisch/zuradio.txt`; the file must contain 8–256 bytes and must not be
readable by group or other users (`chmod 600`). It can also be selected with
`--remote-password-file` or `ZURADIO_REMOTE_PASSWORD_FILE`. The password is
never placed in a URL, database, GitHub Pages artifact, or log.

After one correct password, Rust issues that browser a device-bound credential
that expires after 24 hours. The companion stores the signed credential and
password-derived discovery coordinates, never the raw password. During that
window, tapping Listen, Control, or Upload reconnects without another password
dialog. **Forget this browser** removes the local credential; changing the
laptop password invalidates every remembered browser.

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
host UI. The installed Linux app window is launched with unattended audio
enabled; ordinary development browser tabs may still require one playback
gesture under their autoplay policy.

Authorized Upload mode accepts individual files or a browser-selected folder.
Files are transferred sequentially over the encrypted live data bridge and
checked with SHA-256. Before any music bytes are sent, the receiver durably
probes the visible managed-library root and reports a precise storage stage if it
is unavailable. Each completed file is moved immediately into
`Zuradio Library` inside the computer's Music folder, catalogued incrementally,
and pushed into every open library view without waiting for the rest of the
selection. A bounded background recognition queue starts for that song only
after publication, with at most two recognizers running at once, so an offline
or slow provider cannot hold up the catalog or transfer. While this happens, the local app shows the current incoming file,
acknowledged bytes and percentage, and how many tracks are already catalogued;
it then reports completion or interruption. Private partial files remain under
Zuradio app data. A verified file remains retryable if its destination commit
fails, and cross-drive/library mounts use a synced atomic-copy fallback. Upload
receiver transactions are limited to 512 files, 512 MiB per file, 16 GiB, and a
bounded control declaration. Larger browser selections—including multi-thousand
file libraries—are split into independently committed transactions while the
uploader keeps one global file/catalogue count. Compact acknowledgements keep
the remote reply independent of the total library size. See
[the upload protocol](docs/upload-protocol.md).

Automatic acoustic metadata uses the official Rust
[SongRec](https://github.com/marin-m/songrec) helper installed with Zuradio.
The MIT-licensed Zuradio daemon does not copy or link SongRec's GPL code; it
invokes the separately installed executable with a 30-second limit and consumes
only bounded JSON. The UI stores and displays a parallel `Artist — Title` match,
album, and genre, and local/remote search uses those fields alongside ordinary
tags and folder-derived metadata. A manual **Scan library** retries helper or
network errors. SongRec creates a fingerprint locally and sends the
fingerprint—not the original audio file—to Shazam's service, so recognition
needs Internet access and is not a fully offline recognizer.

An external program or Codex agent can use the same browser bridge through the
machine-readable upload command. It accepts repeated individual files, one
whole folder, or a catalogue manifest and never places the password on the
command line:

```sh
cd web
npm ci
npx playwright install chromium
npm run upload -- --password-file "/path/to/zuradio.txt" --file "/path/to/song.flac"
npm run upload -- --password-file "/path/to/zuradio.txt" --folder "/path/to/music-folder"
npm run upload -- --password-file "/path/to/zuradio.txt" --manifest "/path/to/batch.csv" --source-root "/path/to/music" --ledger "/path/to/catalogued.jsonl"
```

The command defaults to the public companion, can target another deployment
with `--url`, and can use an installed Chrome or Brave binary with
`--browser-executable`. It prints JSON describing the selected/imported tracks,
source byte count, connection time, upload duration, and transfer rate, so
automation can verify the result. While it runs, bounded connection, selection,
receiver-progress, per-song catalogue, and completion updates are written to
standard error; the final standard output remains JSON-only for automation.
The browser remains only a secure transport client; files still travel directly
to the active laptop and are never stored by GitHub Pages. Its default
whole-upload timeout is eight hours; use
`--upload-timeout-ms` for a different 10-second-to-24-hour window. For a large
folder, each bounded transaction is a durable checkpoint and a later failure
reports how many earlier tracks are already safely catalogued.

Manifest mode is intended for large, deduplicated catalogues. JSON or CSV rows
provide `batchId`, `ordinal`, `sha256`, `relativePath`, `sizeBytes`, and
`modifiedUnix`; a row may include `sourcePath`, or its relative path is resolved
under `--source-root`. The CLI rejects path escape, duplicate digests, changed
size or modification time, and unsupported media before connection. Each
receiver catalogue acknowledgement is appended and synced to the JSONL ledger,
which contains no source-root path. A retry selects only hashes that do not yet
have a durable acknowledgement.

Authenticated Control snapshots are framed into ordered messages below the
16 KiB control ceiling and reassembled under a 64 MiB, 30-second bound before
the controller is declared ready. This keeps the full library and latest chat
available when a real catalogue no longer fits one WebRTC message.

## Broadcast to a phone

1. Log in to this computer. Zuradio opens automatically, rotates any stale
   session, and keeps its password-protected discovery beacon available. No
   music starts merely because the beacon is active.
2. Select and play a track locally or from an authenticated Control connection.
3. Open the Zuradio Web Companion on a phone and tap **Listen**, **Control**, or
   **Upload**. The first connection prompts for the shared password; that
   browser then reconnects without another prompt for 24 hours. No URL needs to
   be copied or pasted.
4. Listen receives live audio and sanitized now-playing data. Control adds the
   player, queue, library, favorites, and a persistent playlist library. Upload
   accepts files or folders for the managed laptop repository. Rust grants only
   the selected mode after mutual proof.
5. Choose **Restart secure beacon** to revoke current peers and grants, discard
   incomplete uploads, and immediately establish a fresh discoverable epoch.
   Closing the supervised window opens it again; stopping the Zuradio user
   services is the deliberate way to turn remote access off.

The password derives only a deterministic, data-only rendezvous route. The
laptop returns fresh private session coordinates over the exact requester-bound
WebRTC channel, then Rust requires a separate PBKDF2/HMAC proof before exposing
state, audio, uploads, or control. The companion registers no service worker and
has no catalog or media endpoint.

Remembered browsers use a separate signed 24-hour bearer credential to produce
a fresh nonce-bound HMAC proof for every new session. The credential is bound
to one generated browser-device ID and never bypasses mode scopes, sequence
checks, broadcast rotation, or mutual server proof.

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
listener, controller, and uploader. Its compatibility gate runs the companion
through Chromium (Chrome, Brave, Edge, Android), Firefox, and WebKit
(Safari/iPhone) engines and verifies both a real laptop audio track and
browser-selected file/folder upload. The wider suite validates the VDO.Ninja
media/data path, password proof, uploads, metadata edits, WAV/FLAC decode, all
local and remote controls, responsive layouts, mode isolation, peer/session
binding, monotonic replay rejection, Stop-based grant revocation, sub-15-second
remote connection ceilings, and sub-2-second command acknowledgement. See
[release qualification](docs/qualification.md)
for the exact evidence and remaining distribution gates.

## Project layout

- `crates/zuradio-core`: scanner, SQLite catalog/state, closed actions, queue,
  playlists, favorites, history, and revision/deduplication rules.
- `crates/zuradio-daemon`: CLI, loopback HTTP/WebSocket server, authenticated
  Range/artwork endpoints, broadcast sessions, and remote grant enforcement.
- `apps/zuradio-desktop`: least-privilege Tauri v2 fallback shell that reuses a healthy
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
- `web/scripts/verify-installed-public.mjs`: installed desktop to public Pages
  stream/control check with connection and command latency measurements.
- `web/scripts/upload-cli.mjs`: cross-platform, JSON-emitting remote file or
  folder uploader for agents and shell automation.
- `scripts/benchmark-library.sh`: repeatable scan, snapshot, media Range, and
  resident-memory thresholds over a 60-track corpus.
- `.github/workflows/pages.yml`: companion-only GitHub Pages deployment with a
  build-time assertion that rejects media files and local media API references.

Design rationale is in [architecture](docs/architecture.md),
[threat model](docs/threat-model.md), and
[source research](docs/research.md).

## Distribution status

The Linux service, CLI, dedicated WebRTC desktop window, Tauri fallback, Debian
package, and AppImage are built and qualified on this laptop. The public source is available at
[GeorgeFejer91/zuradio](https://github.com/GeorgeFejer91/zuradio), and the
[Zuradio Web Companion](https://georgefejer91.github.io/zuradio/) is deployed
through GitHub Pages. The cross-platform CI matrix builds the Tauri source on
Linux, Windows, and macOS; signing/notarization and physical-device/forced-TURN
qualification remain separate release-channel gates.

Zuradio is MIT licensed. The pinned VDO.Ninja SDK is MPL-2.0; see
[third-party notices](THIRD_PARTY_NOTICES.md).
