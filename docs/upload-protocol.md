# Zuradio remote password and upload protocol

Status: protocol versions 2–3, 2026-09-01.

## Modes and trust boundary

Starting the installed app activates a password-derived data-only rendezvous
plus fresh, unrelated private control and audio routes. The supervised host
keeps this beacon active while Zuradio runs and restores it after exhausted
transport recovery; beacon activation never starts music. The companion exposes only
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

Restarting the secure beacon or stopping the Zuradio services revokes every
grant and partial transfer. Normal installed mode immediately replaces a rotated
beacon rather than leaving an app-running-but-off state. Because partial
transfers are not resumable across daemon restarts, startup
also purges abandoned private staging directories. Files that already passed
`finish_file` remain safely catalogued in the visible library.

## Upload transaction

Uploads use ordered operations with explicit receiver acknowledgements. Small
authenticated commands remain on the JSON control channel. A mutually
advertised `binary-v1` capability moves audio bytes onto the SDK's dedicated
ordered binary WebRTC channel, where negotiated SCTP message limits and
`bufferedAmount` backpressure apply. An older host can still receive the
bounded JSON/base64 path during a rolling upgrade.

1. `begin` declares a random transaction ID and every file's random ID, relative
   path, and byte size. Before acknowledging the declaration, the Rust receiver
   verifies the visible managed-library root by creating, writing, flushing,
   syncing, and removing a private probe. Storage faults therefore reject the
   upload before the browser sends song bytes.
2. `chunk` carries an exact expected offset. The direct binary path carries at
   most 64 KiB of raw audio per frame; the compatibility path carries at most
   8 KiB as base64. The host binds binary frame metadata to the authenticated
   grant, peer, sequence, transfer, and file before forwarding bytes to Rust.
3. `finish_file` supplies the browser's SHA-256 digest; Rust compares it with
   the staged file.
4. `finish_file` also parses, classifies, moves, incrementally catalogs, and
   publishes that verified file immediately. A failed destination commit leaves
   the verified staged file retryable in the same transaction. Same-filesystem
   rename is preferred; a cross-filesystem destination uses a flushed and synced
   temporary copy followed by an atomic rename. This per-file commit means a
   later failure does not hide or discard songs that already finished.
5. `commit` confirms that every declared file completed and returns the full
   imported-file summary.
6. `abort` removes only incomplete private staging data; already catalogued
   originals remain in the library.

The daemon accepts at most 512 files, 512 MiB per file, and 16 GiB per
transaction. The browser may select a larger collection: it preserves order and
automatically partitions the selection by all three receiver constraints—file
count, aggregate bytes, and the 16 KiB authenticated WebRTC control-message
ceiling. Each transaction commits independently, while remote progress and the
final imported count cover the original selection. A long-running upload renews
its eight-hour live grant between transactions through the existing 24-hour
trusted-device proof when necessary; it never stores or reuses the raw password.
New companions advertise `compact-v1` upload responses and accumulate each
bounded per-file metadata result locally. The host then omits full catalogue
snapshots and the repeated commit summary from the WebRTC acknowledgement, so
reply size does not grow with the laptop library. A companion without that
advertisement receives the original response shape during rolling upgrades.
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
display titles. Generated components are capped by UTF-8 bytes and normalized
away from control/separator characters, trailing spaces or dots, and reserved
Windows device names, so the same organized library is portable across Linux
and Windows. Metadata precedence is:

1. user edits saved in the catalog override table;
2. embedded tags read with Lofty;
3. relative folders such as `Artist/Album (2024)`;
4. filenames such as `03 - Artist - Title.flac`;
5. safe `Unknown Artist`, `Unknown Album`, or cleaned filename fallbacks.

The local metadata editor can change title, artist, album, album artist, track,
disc, and year. Overrides persist across rescans without rewriting the original
audio tags.

After each completed file is catalogued and published, a bounded two-worker
queue invokes the installed official Rust SongRec helper. Its Shazam fingerprint
result is stored in separate provider, external-ID, recognized title, artist,
album, genre, and display-label columns. These values never participate in file
placement and never replace ordinary metadata, but local and remote flexible
search includes both metadata sets. Recognition has a 30-second deadline, sends
only an acoustic fingerprint to the external service, and cannot delay catalogue
publication or the next file transfer.

Transfer-related development must pass the staged browser/CLI upload-download
benchmark in `scripts/verify-data-transfer.sh` before the complete browser gate.
The benchmark verifies immediate first-file publication, organized placement,
source-to-download SHA-256 equality, structured Shazam metadata, local and remote
search retrieval through those fields, use of the dedicated binary channel,
and throughput floors. A separate forced first-chunk rejection proves that the
CLI reports the receiver error and last acknowledged stage instead of waiting
only for the final import message.

The standalone browser CLI separates its short page/connection timeout from an
eight-hour whole-upload timeout, configurable with `--upload-timeout-ms` up to
24 hours. Completed transactions are durable checkpoints: if a later one fails,
the error reports how many earlier tracks were catalogued, and retrying the same
selection reuses digest-qualified managed destinations instead of overwriting
them.

## Password file

The password file is local-only, must contain 8–256 bytes after trailing line
endings are removed, and on Unix must have no group/other permission bits.
Zuradio never returns its contents. Operators should use a long, unique random
password: PBKDF2 slows guessing but this protocol is not a PAKE, so an observed
proof and weak human password can still enable offline guessing.
