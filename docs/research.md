# Zuradio architecture research

**Checked:** 2026-09-01 (Europe/Berlin)
**Scope:** maintained open-source music players and library servers that can inform a lightweight, cross-platform Rust desktop daemon/Tauri shell, a CLI-first command surface, remote browser control, and synchronized browser listening.
**Evidence policy:** scores below are project-fit judgments, not benchmarks. They are based on primary GitHub repositories, source/manifests, licenses, and release pages inspected on the checked date. Repository activity is a snapshot, not a promise of future maintenance.

## Bottom line

Do not fork one product wholesale. Build a small Rust authority that combines three independently useful patterns:

1. **RSPlayer** for the single authoritative player, typed command/event contract, dedicated audio thread, and shared headless/Tauri backend.
2. **rmpd** for the daemon/protocol-adapter boundary, MPD-compatible CLI semantics, SQLite/Tantivy library design, and a tap of the same live mix used for local playback.
3. **Polaris** for resilient library scanning, virtual mount paths, authenticated Range streaming, OpenAPI, and separation of rebuildable catalog indexes from per-user state.

Use the [VDO.Ninja SDK](https://github.com/steveseguin/ninjasdk) or a normal authenticated WebSocket only as a replaceable transport. Rust must remain the sole owner of authorization, queue/player state, filesystem access, and side effects. A VDO.Ninja room, stream ID, peer UUID, transport password, or successful connection is routing information—not controller identity or authorization.

> **Non-negotiable GitHub Pages boundary:** GitHub Pages hosts only the compiled, static companion HTML/CSS/JavaScript and non-user product assets. It hosts **no music, audio/media, album art, catalog, playlists, database, passwords, tokens, signaling service, relay, WebSocket endpoint, or transcoder output**. The laptop remains the catalog/player/media authority. Internet operation still needs a live path provided by the laptop plus VDO.Ninja signaling/STUN/TURN or a separately operated HTTPS/WSS relay.

## Decision criteria

Each candidate was scored on a 0–5 evidence scale and converted to 100 points:

- target fit—local library, host playback, remote control, and browser listening: **30%**;
- Rust, small-process potential, and credible cross-platform path: **20%**;
- typed command, CLI, daemon, and event architecture: **15%**;
- web catalog, API, Range/live-stream support: **15%**;
- maintenance, release evidence, and maturity: **10%**;
- license clarity and practical reuse: **10%**;
- a further **0–10 point risk deduction** for unauthenticated exposure, unclear licensing, unusually young code, stale activity, platform gaps, or dependency forks.

The ranking answers “how useful is this as a Zuradio architecture donor?” It does not rank audio quality or overall product quality.

## Broad candidate set

| Rank | Candidate | Stack / license observed | Currentness observed on 2026-09-01 | Best evidence for this project | Score |
| ---: | --- | --- | --- | --- | ---: |
| 1 | [RSPlayer](https://github.com/ljufa/rsplayer) | Rust, Dioxus, Tauri / MIT | [4.7.0, 2026-07-14](https://github.com/ljufa/rsplayer/releases/tag/4.7.0); pushed 2026-08-30 | Closest end-to-end model: host audio, library, web UI, HTTP media, WebSocket commands | **85** |
| 2 | [rmpd](https://github.com/M0Rf30/rmpd) | Rust / MIT OR Apache-2.0 | [0.6.1, 2026-08-27](https://github.com/M0Rf30/rmpd/releases/tag/0.6.1) | Clean daemon/protocol crates, MPD clients, local playback, same-mix HTTP/FIFO output | **79** |
| 3 | [Polaris](https://github.com/agersant/polaris) + [web client](https://github.com/agersant/polaris-web) | Rust/Axum + Vue / MIT | [0.16.1, 2026-05-08](https://github.com/agersant/polaris/releases/tag/0.16.1) | Mature scanner/index, multi-user HTTP API, authenticated Range streaming | **76** |
| 4 | [MECOMP](https://github.com/AnthonyMichaelTDM/mecomp) | Rust, Tonic, Ratatui / MIT | [0.7.2, 2026-03-09](https://github.com/AnthonyMichaelTDM/mecomp/releases/tag/v0.7.2); pushed 2026-05-09 | Strong daemon + CLI/TUI + MPRIS command boundary | **68** |
| 5 | [WaveFlow Server](https://github.com/InstaZDLL/waveflow-server) | Rust/Axum/SQLite / AGPL-3.0 | pushed 2026-08-31; README reports 2.0.0-beta.0, no tagged release | Best scoped-role/token/session design found; very young and no local player | **67** |
| 6 | [Navidrome](https://github.com/navidrome/navidrome) | Go/React/SQLite / GPL-3.0 | [0.63.2, 2026-07-11](https://github.com/navidrome/navidrome/releases/tag/v0.63.2) | Mature multi-user OpenSubsonic server, transcode pipeline, Jukebox behavior | **66** |
| 7 | [musikcube](https://github.com/clangen/musikcube) | C++ / BSD-3-Clause | [3.0.5, 2025-09-21](https://github.com/clangen/musikcube/releases/tag/3.0.5); pushed 2026-03-23 | Useful split between WebSocket control and HTTP transcoded audio | **64** |
| 8 | [mStream](https://github.com/IrosTheBeggar/mStream) | JavaScript with Rust components / GPL-3.0 | [6.25.0, 2026-08-30](https://github.com/IrosTheBeggar/mStream/releases/tag/v6.25.0) | Polished remote-library, sharing, Jukebox, and quick-sync UX reference | **63** |
| 9 | [smolsonic](https://github.com/tsirysndr/smolsonic) | Rust/Actix/SQLite / MIT | [0.10.0, 2026-07-16](https://github.com/tsirysndr/smolsonic/releases/tag/v0.10.0) | Small one-binary OpenSubsonic/Jellyfin-compatible scanner and Range server | **61** |
| 10 | [OwnTone](https://github.com/owntone/owntone-server) | C/SQLite / GPL-2.0 | [29.3, 2026-07-22](https://github.com/owntone/owntone-server/releases/tag/29.3); pushed 2026-08-29 | Proven server-owned playback, output routing, WebSocket/JSON/MPD control | **60** |
| 11 | [LMS](https://github.com/epoupon/lms) | C++ / GPL-3.0 | [releases current to 2026-08-19](https://github.com/epoupon/lms/releases) | Lightweight, active OpenSubsonic library server | **59** |
| 12 | [Music Player Daemon](https://github.com/MusicPlayerDaemon/MPD) | C++ / GPL-2.0 | pushed 2026-08-27 | Canonical queue/transport command semantics and client ecosystem | **57** |
| 13 | [gonic](https://github.com/sentriz/gonic) | Go / GPL-3.0 | [release activity to 2026-06-08](https://github.com/sentriz/gonic/releases) | Small, pragmatic Subsonic server; no host-player authority | **54** |
| 14 | [Euterpe](https://github.com/ironsmile/euterpe) | Go / GPL-3.0 | [release activity to 2026-01-01](https://github.com/ironsmile/euterpe/releases) | Single-binary REST/UI packaging reference | **52** |
| 15 | [Jellyfin](https://github.com/jellyfin/jellyfin) | C# / GPL-2.0 | pushed 2026-08-31 | Excellent media-server behavior, but far beyond the desired footprint | **47** |
| 16 | [KalinkaPlayer](https://github.com/madenvel/KalinkaPlayer) | Python/C++ / root license unclear | [release activity to 2026-08-30](https://github.com/madenvel/KalinkaPlayer/releases) | Interesting active playback project; do not copy until licensing is resolved | **39** |
| 17 | [tsirysndr/music-player](https://github.com/tsirysndr/music-player) | Rust / MIT | last push observed 2024-10; alpha release in 2023 | Relevant language, but stale/alpha evidence is too weak for a base | **35** |

## Top three

### 1. RSPlayer — best behavioral and process model

**Why it ranks first.** It is the only reviewed Rust candidate already combining local-library playback, a browser UI, typed WebSocket control, browser audio delivery, headless operation, and a Tauri wrapper. The repository was not archived, showed 24 stars/4 forks, and was pushed two days before this review; its main workspace had already moved beyond the latest tagged 4.7.0 release.

**Architecture evidence.** The [architecture document](https://github.com/ljufa/rsplayer/blob/main/docs/architecture.md) divides the workspace into API models, server, configuration, playback, metadata, DSP, synchronization, hardware, wire protocol, and desktop crates. Tokio owns network/control tasks while playback runs on a dedicated thread and the `cpal` callback consumes a ring buffer. The documented chain is Symphonia decode → optional synchronization tee → Rubato resampling/EQ → ring buffer → `cpal`. The Dioxus web UI and Tauri shell use the same backend.

The [shared command model](https://github.com/ljufa/rsplayer/blob/main/crates/api_models/src/common.rs) serializes a closed `UserCommand` enum as JSON. In the [server router](https://github.com/ljufa/rsplayer/blob/main/crates/server/src/server.rs), `/api/ws` receives commands, the command handler mutates one authoritative player, and broadcast events fan state changes to clients. `/music/*` supports browser playback with HTTP Range behavior. The [web client hook](https://github.com/ljufa/rsplayer/blob/main/web-ui/src/hooks/use_websocket.rs) demonstrates reconnecting event projection rather than frontend-owned player state.

**Library/persistence.** RSPlayer keeps one Fjall LSM database (`rsplayer.db`) with separate keyspaces for configuration, songs, albums, play statistics, loudness, queue, playlists, player state, and multiroom state. Song records are JSON keyed by paths relative to the configured library. This is compact, but SQLite is a more inspectable and migration-friendly default for Zuradio.

**Reuse exactly.** Reimplement the one-command-authority/one-event-fanout shape; keep audio off the async executor; share Serde contracts between CLI, Tauri IPC, and remote adapters; let headless and desktop modes call the same core; and degrade the UI cleanly when playback or scanning is unavailable.

**Why not fork it.** On inspection, the router defaulted to `0.0.0.0`, used permissive any-origin CORS, and placed no authentication middleware in front of `/api/ws`, settings, or media routes. WebSocket messages directly deserialize to `UserCommand`, whose variants include machine power/restart operations. That is unacceptable for Internet exposure. The project also has a small adoption base, documents macOS/Windows as experimental, lacks the required controller/listener scope model and CLI boundary, and pins patched Git revisions of `cpal` and Symphonia. Use the MIT architecture as a donor, not its network-security posture. [License](https://github.com/ljufa/rsplayer/blob/main/LICENSE), [manifest](https://github.com/ljufa/rsplayer/blob/main/Cargo.toml).

### 2. rmpd — best daemon, CLI ecosystem, and live-mix model

**Why it ranks second.** rmpd starts from a true daemon boundary and exposes the established MPD protocol, so `mpc`, `ncmpcpp`, Cantata, and `rmpc` can already act as local or scripted controllers. Version 0.6.1 was released and pushed on 2026-08-27, but the project is young (created in 2026; 13 stars/4 forks at review), so it is a design donor rather than a proven base.

**Architecture evidence.** Its [documented workspace](https://github.com/M0Rf30/rmpd#architecture) separates `rmpd-core`, `rmpd-protocol`, `rmpd-player`, `rmpd-library`, plugin, source, stream, and executable crates. The protocol endpoint supports TCP or a Unix socket and defaults to loopback (`127.0.0.1:6600`), with MPRIS and mDNS adapters. Playback uses Symphonia and `cpal`; the library uses SQLite through `rusqlite`, Lofty metadata parsing, filesystem watch/scan, and Tantivy full-text search.

**Playback/streaming.** The [sample configuration](https://github.com/M0Rf30/rmpd/blob/main/rmpd.toml) supports multiple outputs. A local device output and an HTTP `httpd` output or Snapcast FIFO can consume the same canonical live mix. That is the right invariant for listeners: they hear what the laptop is playing, rather than starting independent per-browser queues. The currently documented HTTP format is WAV/PCM; compressed FLAC/Opus/Vorbis output remains work in progress and is essential before WAN use.

**Reuse exactly.** Keep the core independent of protocol adapters; adopt MPD-like queue and playback semantics for the CLI; use SQLite migrations plus Tantivy only if SQLite FTS is measured insufficient; expose MPRIS as a platform adapter; and create one bounded encoded-stream tap after mix/volume policy rather than re-decoding once per listener.

**Why not fork it.** rmpd has no companion web UI, HTTPS/WSS termination, account/session model, listener/controller scopes, or browser-oriented signed media tickets. Raw WAV/PCM is bandwidth-heavy. Windows support is not established in its docs/CI, and the [manifest](https://github.com/M0Rf30/rmpd/blob/main/Cargo.toml) pins revisions of forked Symphonia, Lofty, and `cpal`. Preserve protocol concepts, but build the remote boundary independently. [MIT license](https://github.com/M0Rf30/rmpd/blob/main/LICENSE-MIT), [Apache-2.0 license](https://github.com/M0Rf30/rmpd/blob/main/LICENSE-APACHE).

### 3. Polaris — best scanner, catalog, and browser API model

**Why it ranks third.** Polaris is the mature library-server reference: created in 2016, not archived, 2,724 stars/128 forks at review, and released as 0.16.1 on 2026-05-08. It combines a Rust/Axum server, a separate [Vue/Vite web client](https://github.com/agersant/polaris-web), an Android client, multi-user administration, OpenAPI, playlists, search, and authenticated HTTP Range streaming.

**Scanner and persistence.** The [scanner](https://github.com/agersant/polaris/blob/master/src/app/scanner.rs) uses Rayon and filesystem notifications, debounces change bursts, builds a partial index during first scan, and promotes a completed index rather than exposing half-built state. The [catalog index](https://github.com/agersant/polaris/blob/master/src/app/index.rs) interns repeated strings and serializes its optimized in-memory browser/collection/search structures with `bitcode` to `collection.index`. Per-user [playlists](https://github.com/agersant/polaris/blob/master/src/app/playlist.rs) live separately in `native_db`; users/configuration use TOML.

**API/auth evidence.** The [Axum API](https://github.com/agersant/polaris/blob/master/src/server/axum/api.rs) provides the browser contract and media endpoints. The [authentication implementation](https://github.com/agersant/polaris/blob/master/src/app/auth.rs) uses PBKDF2 password hashes and Branca bearer tokens; current token creation sets a zero TTL, so tokens are effectively permanent until other revocation behavior intervenes.

**Reuse exactly.** Copy the ideas of virtual library mount paths, multi-value tag handling, debounced incremental scan with full-rescan recovery, atomic promotion of a finished catalog, authenticated Range responses, generated OpenAPI, and strict separation between reconstructable catalog data and irreplaceable user state.

**Why not fork it.** Polaris is a streaming library server, not a host-controlled jukebox: each browser owns its playback session, and there is no canonical server queue/play/pause/seek state, host audio engine, CLI, or WebSocket event fanout. Its custom binary index is harder to inspect and migrate than SQLite, its bearer tokens are long-lived, and the [DDNS guidance](https://github.com/agersant/polaris/blob/master/docs/DDNS.md) describes direct raw-HTTP port forwarding that Zuradio must not adopt. Add the Polaris scanner/API patterns to a new player core instead. [MIT license](https://github.com/agersant/polaris/blob/master/LICENSE), [manifest](https://github.com/agersant/polaris/blob/master/Cargo.toml).

## Specialist references

| Reference | Pattern worth preserving | Boundary / reason it is not the base |
| --- | --- | --- |
| [WaveFlow Server](https://github.com/InstaZDLL/waveflow-server), [RFC-002](https://github.com/InstaZDLL/waveflow-server/blob/main/docs/rfcs/RFC-002-waveflow-server-v2.md), [RFC-003](https://github.com/InstaZDLL/waveflow-server/blob/main/docs/rfcs/RFC-003-waveflow-sync-v2.md) | SQLite WAL; one mutation coordinator; repository-enforced owner/manager/listener roles; Argon2id; opaque access/refresh/API tokens stored as hashes; refresh rotation; device sessions; stream tickets; exact-origin CORS; CSRF and path/symlink defenses | No local playback engine, beta-stage/very low adoption, and [AGPL-3.0](https://github.com/InstaZDLL/waveflow-server/blob/main/LICENSE). Study its decisions; do not import server code into a permissive core without choosing AGPL compliance. |
| [MECOMP](https://github.com/AnthonyMichaelTDM/mecomp), [daemon](https://github.com/AnthonyMichaelTDM/mecomp/blob/main/daemon/src/lib.rs), [database](https://github.com/AnthonyMichaelTDM/mecomp/blob/main/storage/src/db/mod.rs) | Clap CLI, Ratatui UI, MPRIS, and daemon all converge through Tonic/protobuf; dedicated Rodio/Symphonia audio thread | Embedded SurrealDB/SurrealKV, analysis, clustering, and recommendation machinery are heavier than this product needs; no remote web-media security plane. |
| [Navidrome](https://github.com/navidrome/navidrome) | OpenSubsonic behavior, multi-user library, transcoding, and server-side Jukebox are the mature interoperability benchmark | GPL-3.0/Go; its built-in web UI does not control Jukebox, so it is not the desired unified companion authority. |
| [musikcube](https://github.com/clangen/musikcube) | Separate WebSocket control/metadata and HTTP transcoded audio channels; Android remote | Its own README warns that the remote uses a simple password, Basic authentication, no TLS, and plaintext password handling. Preserve the split; reject the security design. |
| [mStream](https://github.com/IrosTheBeggar/mStream) | Sharing, local-server audio/Jukebox, OpenAPI/OpenSubsonic, and sync UX | GPL-3.0 and a JavaScript-heavy runtime; Quick Sync does not currently provide the browser companion route required here. |
| [OwnTone](https://github.com/owntone/owntone-server) | Server-owned playback and multiple output/protocol adapters (JSON, WebSocket, MPD, AirPlay, Chromecast) | GPL-2.0/C and no established Windows target; useful output behavior, not a cross-platform Rust base. |
| [smolsonic](https://github.com/tsirysndr/smolsonic) | Minimal Rust/SQLite one-binary scanner, stable IDs, Range responses, Subsonic/Jellyfin compatibility | API server only; no canonical local player or complete companion playback UI. |
| [OpenSubsonic API](https://github.com/opensubsonic/open-subsonic-api) | Apache-2.0 catalog/search/playlist/stream interoperability and compatibility tests | Use for read/catalog/media compatibility. Keep Zuradio's canonical queue and live control in a smaller typed WSS/BRSP contract. |
| [Browser Remote Sync Protocol](https://github.com/GeorgeFejer91/browser-remote-sync-protocol/tree/62ff66c6df724847c1e54161feabb470b67b1192) | Pinned BRSP/1 reference for role-bound proof, scopes, command/state lanes, sequencing, backpressure, stale/lease behavior, and a VDO.Ninja adapter | Adopt only after running its canonical/HMAC and adapter fixtures at the pinned commit. Similar JSON over WebRTC is not conformance. |
| [VDO.Ninja SDK](https://github.com/steveseguin/ninjasdk), [licensing map](https://github.com/steveseguin/ninjasdk/blob/main/LICENSING.md) | Supported SDK path for browser/Node WebRTC audio and data channels, NAT traversal, targeted peers, backpressure inspection, and direct-or-TURN routes | Signaling is a hosted operational dependency and not an auth system. Pin/vendor a reviewed SDK version; never call the private signaling WebSocket directly. The SDK core is MPL-2.0, extras/demos are MIT; the main [VDO.Ninja app](https://github.com/steveseguin/vdo.ninja) defaults to AGPL-3.0. |
| [RustDesk pinned snapshot](https://github.com/rustdesk/rustdesk/tree/03a7fc5992069cc5bc9f7c36b872483dddf4f472) | Architecture-only reference for rendezvous versus direct/relay paths, bounded admission/backpressure, per-session teardown, and platform adapters | AGPL-3.0 remote-desktop code and raw keyboard/pointer authority are the wrong semantics. Reimplement only the selected lifecycle ideas; do not copy code or expose generic input. |

## Reusable patterns versus rejected risks

| Take | Exact implementation rule for Zuradio | Explicit rejection |
| --- | --- | --- |
| One Rust authority | CLI, Tauri UI, MPRIS, authenticated remote control, and tests translate into one closed Rust action enum and reducer; emit revisioned snapshots/events | No generic remote CLI strings, shell/argv execution, Tauri command names, JavaScript, DOM selectors/events, paths, URLs, or arbitrary database queries |
| Two roles, separate grants | `listener` may receive a sanitized snapshot/catalog and the live audio stream; `controller` receives only explicitly granted playback/queue/library mutation scopes | A “join password” must not accidentally grant control. A room/stream password alone is not an application authorization check |
| Pairing bootstrap | Locally enabled session, high-entropy invitation or reviewed PAKE, mutual proof, short-lived device grant, expiry, revocation, and controller replacement fencing | No durable six-digit bearer password, secrets in URL query strings, frontend bundles, localStorage, logs, or GitHub Pages configuration |
| Same-mix streaming | Tap the authoritative post-policy playback mix once, encode with bounded buffers, and fan it out; every listener hears the host timeline | No per-listener independent queue masquerading as “what is playing”; no unbounded WAV/PCM over the WAN as the finished design |
| Reliable commands + coalesced state | Ordered bounded FIFO for commands/acks; newest-only slot for replaceable state; epochs, command IDs, deduplication, heartbeats, capped reconnect | No unbounded channel per socket and no dropping one reliable action while continuing with later actions |
| Rebuildable catalog | SQLite migrations for songs/albums/mounts/queue/playlists/users; scanning jobs build a new generation and atomically publish it; paths stay library-relative/virtual | No browser-visible absolute paths; no catalog/database uploaded to GitHub Pages; no custom opaque index until measurements justify it |
| Transport-neutral bridge | BRSP/application envelopes stay independent of VDO.Ninja, WebRTC, or WSS. Rust validates proof, scope, epoch, revision, size, rate, and action before effects | No assumption that DTLS/WebRTC encryption, VDO room membership, peer UUID, or a WebSocket connection proves identity or scope |
| Inert networking | Remote hosting starts only after explicit local enable and stops/revokes on disable, app exit, owner-window destruction, expiry, or unrecoverable error | No default `0.0.0.0` unauthenticated listener, wildcard CORS, raw HTTP port-forwarding, or privileged remote page loaded inside a Tauri WebView |

## Recommended source architecture

```text
GitHub Pages static companion (untrusted presentation)
  ├─ typed listener/controller UI
  ├─ pinned VDO.Ninja/BRSP transport adapter
  └─ no user data, secrets, catalog, server, or media
                    │ authenticated WebRTC data/media or HTTPS/WSS relay
                    ▼
Tauri packaged bridge (local WebView, narrow capability)
                    │ typed claim / renew / dispatch / revoke + snapshots
                    ▼
Rust core (sole authority)
  ├─ contracts + reducer + revisioned state
  ├─ auth/session/scope service
  ├─ CLI and MPD/MPRIS adapters
  ├─ SQLite repositories + scanner/index worker
  ├─ Symphonia decoder / DSP / cpal output thread
  └─ bounded encoded live-mix publisher
```

The first remote milestone should be an authenticated **read-only listener**: pair, obtain only read/media scopes, receive a sanitized snapshot, and hear the same host mix. Add controller mutation only after expiry, replay, scope-denial, owner replacement, reconnect, backpressure, background-phone, and Stop/revocation tests pass. The VDO.Ninja media-publisher bridge is a specific cross-WebView/platform risk: prove real audio capture/publishing on WebView2, WKWebView, WebKitGTK, Android Chrome, and iOS Safari before claiming cross-platform support.

## Licensing boundary

- **MIT / BSD-3-Clause / Apache-2.0 / `MIT OR Apache-2.0`:** compatible starting points for a permissive project when copyright and license notices are retained and dependency terms are tracked. This covers the relevant RSPlayer, rmpd, Polaris, MECOMP, smolsonic, musikcube, and OpenSubsonic material, subject to each file/dependency's actual notice.
- **MPL-2.0 VDO.Ninja SDK core:** may be bundled in a larger permissive or proprietary work without relicensing the whole work, but distributed MPL-covered files—and modifications to those files—remain MPL-covered with notices/source availability. The SDK's Node extras/demos are separately MIT. Follow the repository's [file-level map](https://github.com/steveseguin/ninjasdk/blob/main/LICENSING.md), not a guessed repository-wide label.
- **GPL-2.0 / GPL-3.0:** use Navidrome, OwnTone, LMS, MPD, mStream, gonic, Euterpe, and Jellyfin as behavioral/protocol references. Copying or linking implementation into a distributed derivative can impose GPL obligations; do not import code into a permissive core without an explicit licensing decision.
- **AGPL-3.0:** use WaveFlow, the main VDO.Ninja application, and [RustDesk](https://github.com/rustdesk/rustdesk) only as architecture evidence unless the project deliberately accepts AGPL network-source obligations. Prefer the separately licensed VDO.Ninja SDK over copying VDO.Ninja application code.
- **Unclear/no license:** treat the code as unavailable for copying by default. KalinkaPlayer remains in this category until a clear applicable license is confirmed.

This is an engineering license boundary, not legal advice. Before release, record every copied file and dependency in an attribution/SBOM review and have the intended distribution model checked against the actual licenses.

## Decision

Proceed with a clean Rust workspace, not a fork: SQLite catalog and state, Symphonia/`cpal` playback on a dedicated thread, a closed reducer shared by CLI/Tauri/remote adapters, revisioned event fanout, an authenticated signed/ticketed live-mix stream, and a static GitHub Pages companion. Use RSPlayer, rmpd, and Polaris as the three primary design references; use WaveFlow/BRSP/VDO.Ninja for security and transport qualification; retain OpenSubsonic as optional catalog compatibility rather than the canonical live-control protocol.
