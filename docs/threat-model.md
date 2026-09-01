# Zuradio threat model

Status: MVP security contract, 2026-09-01.

## Protected assets

- Local file paths, tags, cover art, catalog membership, and listening history.
- The live audio stream and current player state.
- Controller and listener access keys.
- Playback, queue, playlist, volume, scanning, and broadcast authority.

## Untrusted components

- GitHub Pages and its request logs.
- Public signaling, STUN, and TURN infrastructure.
- Remote browsers, received data-channel messages, and peer display names.
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
- Generate broadcast credentials from operating-system randomness, keep them
  memory-only, and discard them on Stop or process exit. Compare controller
  proofs in constant time. Keep role, scope, expiry, peer binding, broadcast
  epoch, and replay sequence in Rust.
- Keep transport, controller, listener, and media secrets independent. Rotating
  or stopping a broadcast revokes its complete epoch.
- Validate one versioned JSON schema. Reject unknown actions and unknown fields.
- Resolve media IDs through the catalog. Never accept a remote path. Canonicalize
  scan roots, reject escapes and special files, and handle symlinks explicitly.
- Expose no shell, process, arbitrary path, URL, SQL, or generic command adapter.
  Remote peers can submit only the closed Rust action schema.
- Require an explicit local gesture to start broadcasting. Stop media tracks,
  close peers, clear grants, and release the audio graph on stop/page shutdown.
- Never put access keys in query strings, logs, local storage, analytics, crash
  reports, or GitHub Pages configuration.
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
- Controller HMAC and server-proof verification, role denial, peer/session
  binding, monotonic replay rejection, and broadcast Stop revocation.
- Real VDO.Ninja audio/data transport between independent host, listener, and
  controller Chromium contexts.
- Listener UI immutability and controller player/queue/playlist behavior.
- Companion-only Pages artifact inspection: no media files and no local media
  API reference.
- Tauri v2 shell URL validation, zero-command capability, exact loopback
  navigation policy, bundled-resource inspection, real WebKitGTK launch, and
  absence of a duplicate authority process when the systemd service is healthy.
- Public GitHub Pages deployment over HTTPS with successful verification and
  deployment workflows.

## Not yet qualified

- Malicious media corpus fuzzing and decoder sandboxing.
- WebView runtime behavior on Windows/WebView2 and macOS/WKWebView beyond the
  host-native CI compile matrix.
- TURN trust, availability, bandwidth, and abuse limits.
- Forced-TURN, physical-phone, multi-listener, and long-duration endurance.
- Password-authenticated key exchange for memorable human passphrases.
- Native code signing/notarization, auto-update, and supply-chain attestations.
