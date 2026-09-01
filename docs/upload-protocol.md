# Zuradio remote password and upload protocol

Status: protocol version 2, 2026-09-01.

## Modes and trust boundary

Starting a broadcast creates fresh, unrelated invitations for `listen`,
`control`, and `upload`. Each invitation contains routing coordinates, a random
PBKDF2 salt, and the mode, but no password or password-derived key. GitHub Pages
serves only the static companion. Music bytes move directly between the remote
browser and the laptop over VDO.Ninja's encrypted WebRTC data channel.

The browser derives a 256-bit key with PBKDF2-HMAC-SHA-256 using 210,000
iterations, then proves it with HMAC over the versioned session, epoch, mode,
peer ID, and fresh client nonce. Rust verifies that proof and returns a server
proof over the same transcript. The browser clears the entered password and
derived key after the hello is sent. A successful proof creates a short-lived,
mode-scoped grant bound to that VDO peer and a strictly increasing request
sequence. Reusing a proof for another mode does not work.

- `listen`: sanitized now-playing state and the live Opus audio route.
- `control`: canonical library/player state, live audio, and the closed Rust
  action schema for transport, queue, favorites, and playlists.
- `upload`: library upload and resulting imported metadata only; no player
  actions and no live-audio route.

Stopping or restarting a broadcast revokes every grant and partial transfer.

## Upload transaction

Uploads use ordered operations acknowledged one at a time:

1. `begin` declares a random transfer ID and every file's random ID, relative
   path, and byte size.
2. `chunk` carries at most 8 KiB of base64 data and its exact expected offset.
3. `finish_file` supplies the browser's SHA-256 digest; Rust compares it with
   the staged file.
4. `commit` parses and classifies every staged file before moving any file into
   the library. A failed batch is discarded instead of partly imported.
5. `abort` explicitly removes a partial transfer.

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

Completed files are stored under the private Zuradio data directory:

```text
library/<album artist>/<album (year)>/<track - title [digest]>.extension
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

## Password file

The password file is local-only, must contain 8–256 bytes after trailing line
endings are removed, and on Unix must have no group/other permission bits.
Zuradio never returns its contents. Operators should use a long, unique random
password: PBKDF2 slows guessing but this protocol is not a PAKE, so an observed
proof and weak human password can still enable offline guessing.
