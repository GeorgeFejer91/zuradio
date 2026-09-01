# Zuradio remote password and upload protocol

Status: protocol versions 2–3, 2026-09-01.

## Modes and trust boundary

Starting a broadcast activates a password-derived data-only rendezvous plus
fresh, unrelated private control and audio routes. The companion exposes only
`listen`, `control`, and `upload` buttons. After a password gesture, a
requester/nonce-bound rendezvous beacon supplies current private coordinates;
there are no invitation URLs. GitHub Pages serves only the static companion.
Music bytes move directly between the remote browser and the laptop over
VDO.Ninja's encrypted WebRTC data channel.

The browser derives a 256-bit key with PBKDF2-HMAC-SHA-256 using 210,000
iterations, then proves it with HMAC over the versioned session, epoch, mode,
peer ID, and fresh client nonce. Rust verifies that proof and returns a server
proof over the same transcript. The browser clears the entered password and
derived key after mutual authentication completes. A successful proof creates a short-lived,
mode-scoped grant bound to that VDO peer and a strictly increasing request
sequence. Reusing a proof for another mode does not work.

After a successful password proof, the same browser may use Zuradio's signed
24-hour trusted-device credential for later connections. It still sends a
fresh nonce-bound proof and receives only the selected mode's scope; the
credential does not turn an upload session into a controller or listener.

- `listen`: sanitized now-playing state and the live Opus audio route.
- `control`: canonical library/player state, live audio, and the closed Rust
  action schema for transport, queue, favorites, and playlists.
- `upload`: library upload and resulting imported metadata only; no player
  actions and no live-audio route.

Stopping or restarting a broadcast revokes every grant and partial transfer.
Because partial transfers are not resumable across daemon restarts, startup
also purges abandoned private staging directories. Files that already passed
`finish_file` remain safely catalogued in the visible library.

## Upload transaction

Uploads use ordered operations acknowledged one at a time:

1. `begin` declares a random transfer ID and every file's random ID, relative
   path, and byte size.
2. `chunk` carries at most 8 KiB of base64 data and its exact expected offset.
3. `finish_file` supplies the browser's SHA-256 digest; Rust compares it with
   the staged file.
4. `finish_file` also parses, classifies, moves, incrementally catalogs, and
   publishes that verified file immediately. This per-file commit means a later
   failure does not hide or discard songs that already finished.
5. `commit` confirms that every declared file completed and returns the full
   imported-file summary.
6. `abort` removes only incomplete private staging data; already catalogued
   originals remain in the library.

The daemon accepts at most 512 files, 512 MiB per file, and 16 GiB per batch.
It rejects zero-byte files, special/path-traversal components, duplicate IDs,
unordered offsets, oversized messages, unsupported extensions, digest
mismatches, stale sequences, wrong peers, and wrong-mode grants.

Supported catalog and upload extensions are AAC, AIF/AIFF, ALAC, FLAC, M4A,
MP3, MP4, OGG, Opus, WAV, and WebM. The local WebView/browser must have a codec
for playback; Chromium qualification explicitly decodes real WAV and FLAC and
declares MP3, AAC/M4A, OGG/Vorbis, OGG/Opus, and WebM/Opus support. AIFF and
ALAC playback may use platform media codecs even though they are always
accepted, cataloged, and preserved losslessly.

## Managed repository and metadata

Completed files are stored in the visible `Zuradio Library` folder inside the
computer's Music folder (for example `~/Musik/Zuradio Library`):

```text
Zuradio Library/<album artist>/<album (year)>/<track - title [digest]>.extension
```

The digest suffix avoids accidental overwrites and is hidden from fallback
display titles. Metadata precedence is:

1. user edits saved in the catalog override table;
2. embedded tags read with Lofty;
3. relative folders such as `Artist/Album (2024)`;
4. filenames such as `03 - Artist - Title.flac`;
5. safe `Unknown Artist`, `Unknown Album`, or cleaned filename fallbacks.

The local metadata editor can change title, artist, album, album artist, track,
disc, and year. Overrides persist across rescans without rewriting the original
audio tags.

Transfer-related development must pass the staged browser/CLI upload-download
benchmark in `scripts/verify-data-transfer.sh` before the complete browser gate.
The benchmark verifies immediate first-file publication, organized placement,
source-to-download SHA-256 equality, and throughput floors.

## Password file

The password file is local-only, must contain 8–256 bytes after trailing line
endings are removed, and on Unix must have no group/other permission bits.
Zuradio never returns its contents. Operators should use a long, unique random
password: PBKDF2 slows guessing but this protocol is not a PAKE, so an observed
proof and weak human password can still enable offline guessing.
