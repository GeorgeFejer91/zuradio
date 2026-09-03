# Zuradio threat model

Status: MVP security contract, 2026-09-01.

## Protected assets

- Local file paths, tags, cover art, catalog membership, listening history, and
  retained chat messages.
- The live audio stream and current player state.
- The central remote password, password proofs, transport coordinates, and
  listen/control/upload grants.
- Playback, queue, playlist, chat-clear, volume, scanning, and broadcast authority.

## Untrusted components

- GitHub Pages and its request logs.
- Public signaling, STUN, and TURN infrastructure.
- Remote browsers, received data-channel messages, and peer display names.
- The separately licensed SongRec helper and Shazam response. Zuradio passes
  only one already-catalogued local audio path to its pinned executable, bounds
  time and captured output, and validates every stored response field.
- The 24-hour credential in companion origin storage. It is a short-lived
  bearer secret exposed to same-origin script, so CSP, dependency pinning,
  framing refusal, device binding, expiry, and the local Forget action are part
  of its security boundary; the raw password is never stored.
- Music metadata, artwork, filenames, symlinks, and malformed media files.

The local browser bridge is less trusted than Rust: it can request a fixed action
but does not receive arbitrary filesystem or process authority.

## Required controls

- Bind the native API to `127.0.0.1`/`::1` only; never wildcard interfaces.
- Bootstrap the local browser with a fragment-held, per-launch secret. Exchange
  it by POST for an `HttpOnly`, `SameSite=Strict` session and immediately erase
  the fragment.
- Enforce exact origin and host checks, small body limits, rate/concurrency
  limits, content types, and response security headers.
- Read the password only from a private local file, reject group/other-readable
  Unix permissions, and never return, log, persist in the database, or include
  it in a URL. Derive rendezvous coordinates and a per-session proof key with
  domain-separated PBKDF2/HMAC operations and compare mutual proofs in constant
  time.
- Generate broadcast routing credentials from operating-system randomness, keep
  them memory-only, and discard them on secure rotation or process exit. Keep mode, scope,
  expiry, peer binding, broadcast epoch, and replay sequence in Rust.
- Keep transport, controller, listener, and media secrets independent. Rotating
  the beacon or stopping the host revokes its complete epoch.
- Validate one versioned JSON schema. Reject unknown actions and unknown fields.
- Treat chat as bounded inert text: derive its local/remote sender from the
  Rust-authorized role, escape it at every HTML render, retain only the latest
  20 messages, permit posting only to Control, and permit deletion/clearing only locally.
- Resolve media IDs through the catalog. Never accept a remote path. Canonicalize
  scan roots, reject escapes and special files, and handle symlinks explicitly.
- Stage uploads beneath the private data directory; constrain count, per-file
  and batch sizes; require ordered chunks and SHA-256; parse every file before
  committing the batch; and discard partial transfers on abort/Stop/restart.
- Expose no shell, process, arbitrary path, URL, SQL, or generic command adapter.
  Remote peers can submit only the closed Rust action schema.
- Treat installation and enablement of the supervised user service as the local
  decision to keep the password-protected beacon available whenever Zuradio is
  running. Beacon startup must not start playback. A secure restart closes media
  tracks and peers, clears grants, discards incomplete uploads, and immediately
  establishes a fresh epoch; stopping the services remains the deliberate off.
- Never put access keys in query strings, logs, local storage, analytics, crash
  reports, or GitHub Pages configuration.
- Treat password-derived discovery as a rendezvous hint, not identity. Bind
  beacons to the requester UUID and nonce, disable signaling fallback, return
  fresh private coordinates, and require Rust authorization on that private
  route. A long unique password remains required because this is not a PAKE.
- Do not register a service worker that caches media, catalog, state, or secrets.

## GitHub Pages limitation

Pages cannot provide every desired response header, particularly a reliable
`Content-Security-Policy: frame-ancestors` header. The companion uses a strict
meta CSP for supported directives, contains no third-party analytics or runtime
CDN, and refuses to operate when framed. A custom static host with full headers
is preferable for a hardened public release.

## VDO.Ninja boundary

WebRTC provides encrypted data/media transport, but a room identifier or SDK
password is not application identity. Zuradio authorizes every peer in Rust
before returning state, catalog data, media coordinates, or a local grant. It
uses the documented SDK rather than imitating VDO.Ninja's internal signaling
protocol. Direct Internet exposure of the loopback daemon is out of scope.

## Qualified on this laptop

- Loopback host/origin and unauthenticated API rejection.
- Local bootstrap fragment removal and 0600 runtime credential storage.
- Single-password PBKDF2/HMAC and server-proof verification, mode denial,
  peer/session binding, monotonic replay rejection, and broadcast Stop revocation.
- Default-on beacon recovery without a playback transition, plus secure beacon
  restart and service-stop revocation.
- Password-gated folder/file upload, wrong-password rejection before audio or
  authority exposure, digest/offset/path validation, managed repository commit,
  metadata inference, and persistent local metadata correction.
- Passwordless trusted-browser reconnect after reload, no password in browser
  storage, device/expiry binding, tamper rejection, password-change
  invalidation, and an explicit Forget-this-browser path.
- Real VDO.Ninja audio/data transport between independent host, listener, and
  controller Chromium contexts.
- Listener UI immutability and controller player/queue/playlist behavior.
- Authenticated Control chat in both directions, Rust-derived sender identity,
  HTML-safe rendering, bounded persistence, and local-only deletion/clearing.
- Companion-only Pages artifact inspection: no media files and no local media
  API reference.
- Tauri v2 shell URL validation, zero-command capability, exact loopback
  navigation policy, bundled-resource inspection, plus an installed Chromium
  app-shell launch that proves WebRTC and running unattended audio without
  creating a duplicate authority process.
- Public GitHub Pages deployment over HTTPS with successful verification and
  deployment workflows.
- The installed Chromium qualification endpoint is disabled by default. The
  installed/public-path gate temporarily binds it to loopback
  (`127.0.0.1:9224`) and restarts the host without it during cleanup, so it is
  never exposed to another machine or left active with the ordinary broadcaster.

## Not yet qualified

- Malicious media corpus fuzzing and decoder sandboxing.
- WebView runtime behavior on Windows/WebView2 and macOS/WKWebView beyond the
  host-native CI compile matrix.
- TURN trust, availability, bandwidth, and abuse limits.
- Forced-TURN, physical-phone, multi-listener, and long-duration endurance.
- A true password-authenticated key exchange (PAKE) to remove the offline
  dictionary-guessing risk for weak human passwords; current deployments should
  use a long unique random password.
- Native code signing/notarization, auto-update, and supply-chain attestations.
