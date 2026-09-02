# Direct transfer protocol selection task

Status: benchmarked architecture decision, 2026-09-02. Implementation remains staged.

## Objective

Move uploaded music from a computer or smartphone browser to the Zuradio laptop as quickly as the direct path allows without a torrent, swarm, seeding network, hosted music copy, or silent relay. Preserve application authentication, upload scope, byte integrity, organized library placement, immediate per-file catalogue publication, acoustic recognition, visible progress, and interactive-control responsiveness.

In networking terminology a browser and laptop are still two peers. “No P2P network” here means one authenticated point-to-point transfer: no peer discovery network, distributed storage, multi-peer forwarding, or torrent behavior.

## Measured baseline and candidates

All local candidate runs used Chromium 151 on the same Debian laptop with a 2-core/4-thread Intel i5-3210M. The microbenchmarks isolate transport capacity; only the production gate includes authentication, Base64/JSON processing, Rust staging, SHA-256, metadata parsing, catalogue publication, recognition, and download verification. Do not compare those rows as if their endpoints were identical.

| Path | Payload and runs | Median/result | Connection/control evidence | Qualification |
| --- | --- | ---: | --- | --- |
| Current production VDO upload bridge | 9,729,283 bytes, one staged browser gate | 525,197 B/s | First catalogue 7,637 ms | Real companion → VDO → host → Rust; byte exact; full upload semantics |
| VDO SDK dedicated binary channel | 64 MiB × 3 | 14,941,636 B/s | 3,279 ms setup; selected `host/host` UDP; not relayed | Real public VDO signaling and browser data channel; byte exact; transport only |
| Browser WebRTC, 64 KiB ordered lane | 64 MiB × 3 | 12,813,882 B/s | p95 control RTT 219.8 ms; worst 402.8 ms; ~1.11 MiB max queued | Direct `host/host` UDP; byte exact; transport only |
| Browser WebRTC, 128 KiB ordered lane | 64 MiB × 3 | 13,434,401 B/s | p95 control RTT 1,468.7 ms; worst 2,268.5 ms | 4.8% faster, materially less responsive, and above the conservative 64 KiB fallback |
| `webrtc-rs` 0.20.3 reliable ordered data channel | 128 MiB after 16 MiB warmup | 209.231 Mbit/s (26.15 MB/s) | 1 MiB/512 KiB bounded flow control | Rust↔Rust loopback upstream flow-control benchmark; not browser interoperability proof |
| Browser → Rust WebTransport/QUIC | 64 MiB × 3 | 46,971,977 B/s | 5 ms median setup | Direct loopback HTTP/3 with certificate hash; byte exact; no ICE/NAT traversal proof |

The persisted JSON artifacts are generated under `target/` and intentionally remain outside source control.

## Decision

The most suitable universal browser-to-laptop data plane is a **single reliable ordered binary WebRTC DataChannel terminating in Rust**, using `webrtc-rs`, streamed 64 KiB-or-smaller frames, one MiB bounded buffering, and an explicit scheduler yield after roughly 256 KiB. Keep the existing VDO route for discovery, mutually authenticated application setup, and SDP/ICE signaling. File bytes must use the independent bulk connection/lane and must not use the JSON control channel.

Why this wins under Zuradio's requirements:

- It is browser-native and supports direct ICE/STUN connectivity across ordinary home-router NATs. WebRTC data channels are DTLS-encrypted and support negotiated message limits and buffered-amount backpressure. See [MDN's data-channel guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels) and [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831).
- The stable Rust implementation demonstrated a 26.15 MB/s reliable ordered ceiling on this old laptop. Its current release includes bounded send backpressure and UDP batching. See [`webrtc-rs` releases](https://github.com/webrtc-rs/webrtc/releases) and its [flow-control example](https://github.com/webrtc-rs/webrtc/blob/master/examples/data-channels-flow-control/data-channels-flow-control.rs).
- A single 64 KiB browser lane gave up only 4.8% versus 128 KiB messages while reducing measured p95 control delay by roughly 6.7×. The current 219.8 ms result remains above the 200 ms local target, so scheduler and control-priority work is an implementation gate, not a waived requirement. Four-lane results varied materially between repeated suites and do not justify their added complexity.
- It preserves the existing direct-connect reachability model without exposing the loopback HTTP authority as a public server.

WebTransport/QUIC is the measured speed winner, but not the universal protocol winner. It requires the browser to reach an HTTPS/HTTP3 server directly and does not provide ICE hole punching. It may become an optional authenticated LAN/VPN/publicly-routable fast path after the WebRTC replacement is complete. See the [W3C WebTransport specification](https://www.w3.org/TR/webtransport/) and [Chrome's WebTransport guide](https://developer.chrome.com/docs/capabilities/web-apis/webtransport).

No direct-only browser transport can guarantee connectivity through every restrictive NAT or firewall. Strict-direct mode must reject a selected ICE pair containing a `relay` candidate and report that a direct connection is unavailable. Supporting every network would require an explicit TURN/relay fallback, which is a separate product decision.

## Implementation stages

### Stage A — immediate binary-lane improvement

1. Retain the current authenticated VDO session and typed `begin`, `finish_file`, `commit`, and `abort` control messages.
2. Replace whole-file `arrayBuffer()`, 8 KiB Base64 strings, and per-chunk JSON requests with `File.slice()` and one dedicated reliable ordered binary channel.
3. Negotiate frame size as `min(64 KiB, RTCSctpTransport.maxMessageSize minus the frame header)`.
4. Pause above one MiB queued bytes, resume at or below 512 KiB, and yield after about 256 KiB submitted.
5. Forward received host bytes into Rust through a bounded loopback binary WebSocket or streaming request rather than rebuilding Base64 JSON.
6. Keep transfer progress newest-only and lower priority than authentication, commands, acknowledgements, and authoritative snapshots.

This is the lowest-risk first implementation because the measured VDO binary route exposed about 28× the current end-to-end upload rate as available data-plane capacity while preserving the existing discovery topology. It is not an end-to-end 28× claim until Rust streaming, cataloguing, and physical-device gates reproduce it.

### Stage B — direct Rust WebRTC termination

1. Add a `webrtc-rs` bulk endpoint to the daemon without widening the loopback HTTP authority.
2. Bind a single-use transfer token to the authenticated grant, browser peer, broadcast authority generation, manifest fingerprint, expiry, and transfer ID.
3. Relay SDP and trickled ICE only through the already-authenticated control path; send no music bytes through signaling.
4. Permit direct `host`, `srflx`, or validated `prflx` routes. Reject `relay` in strict-direct mode and expose the selected route in sanitized transfer diagnostics.
5. Stream each frame directly into private staging, update incremental SHA-256, acknowledge resumable checkpoints, and publish each completed verified file immediately.
6. Keep the Stage A path as a bounded rollback until physical-device and different-network qualification passes.

### Stage C — optional WebTransport fast path

Attempt only after an authenticated session supplies an explicit endpoint and certificate hash. Race it against direct Rust WebRTC only on supported/reachable networks, choose it when it connects directly within a short deadline, and fall back to direct WebRTC without delaying the upload UI. Never expose catalogue, control, or arbitrary file paths through the QUIC listener.

## Mandatory selection gates

Run:

```sh
scripts/benchmark-transfer-protocols.sh
scripts/verify-feature-completion.sh
```

Any transport implementation must additionally prove:

- exact selected-route type and no silent relay in strict-direct mode;
- source/download SHA-256 equality and existing staging/path/size rejection;
- first-file catalogue publication while later bytes are still arriving;
- resumable interruption and bounded cleanup, without removing completed files;
- median and p95 throughput over at least three 64 MiB runs plus a 1 GiB soak;
- p50/p95/worst command acknowledgement while upload saturates the path;
- bounded sender queue, browser memory, Rust RSS, CPU, and staging disk usage;
- physical Android Chrome and iOS Safari on the same LAN and a different network;
- direct success, restrictive-NAT direct failure, sleep/wake, and network handoff;
- the complete repository transfer and browser qualification gates.

The optimized protocol must beat the current production baseline on the same fixture and route by at least 5× without weakening integrity or increasing command acknowledgement beyond the existing two-second ceiling. The local target is p95 command acknowledgement under 200 ms during saturation; report measured values rather than lowering the gate.

## Latest qualification evidence

On 2026-09-02, `scripts/benchmark-transfer-protocols.sh` passed all three candidate data planes with byte-exact delivery and persisted their JSON artifacts. After the benchmark exposed a concurrent-render race around directory selection, the upload picker was changed to capture its own `change` event even if a live bridge update replaces the visible input. The focused Chromium, Firefox, and WebKit picker qualification then passed 3/3, and `scripts/verify-feature-completion.sh` passed the staged production transfer test plus all 22 browser scenarios from a fresh optimized build.

These are local same-machine measurements, not proof of WAN, restrictive-NAT, Android, iOS, sleep/wake, network-handoff, or 1 GiB behavior. Those gates remain explicitly open for the staged transport implementation.
