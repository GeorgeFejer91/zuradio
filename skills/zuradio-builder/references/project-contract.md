# Zuradio Project Contract and Lessons

Read this reference for any nontrivial Zuradio change. It captures durable constraints learned from the initial application build and qualification; current repository code and `For-AI` gates remain authoritative.

## Contents

- [System Boundary](#system-boundary)
- [Authority and Protocol Contract](#authority-and-protocol-contract)
- [Connection and Authentication](#connection-and-authentication)
- [Playback and Timeline Reconciliation](#playback-and-timeline-reconciliation)
- [Uploads, Catalog, and Metadata](#uploads-catalog-and-metadata)
- [Responsiveness Contract](#responsiveness-contract)
- [Defect-to-Rule Ledger](#defect-to-rule-ledger)
- [Qualification Boundary](#qualification-boundary)

## System Boundary

```text
local folders -> Rust catalog/reducer <- CLI
                        ^               <- local host UI
                        |
                loopback protected API
                        |
             local Chromium/Tauri host
                        |
           live WebRTC audio + typed data
                        |
          static GitHub Pages companion
```

The static site is a replaceable distribution shell. The laptop owns music bytes, paths, tags, cover art, catalog, history, password material, state, and authority. The host browser owns only browser-native playback/Web Audio/WebRTC adaptation. VDO.Ninja owns transport/signaling behavior, not Zuradio identity or policy.

When a change appears to require Pages to fetch a loopback URL, expose a LAN port, upload the library to hosting, or teach the remote browser a filesystem path, stop: it violates the architecture.

## Authority and Protocol Contract

All local UI, CLI, and authenticated remote mutations converge on one Rust command handler. A command has:

- protocol version;
- stable command ID;
- actor role and peer identity when remote;
- expected state revision where applicable;
- one closed typed action;
- target preconditions for actions such as seek.

Accepted mutation advances canonical revision and emits a fresh projection. Remote stale writes conflict. A duplicate semantic command must not repeat effects. Future hardening should namespace duplicate identity by authority generation and authenticated principal and fingerprint the logical payload; a transport reconnect must not erase retry safety.

Keep application-authority generation separate from transport epoch. Broadcast Stop/restart changes authority. A data-channel reconnect changes transport. Every old callback, grant, sequence, pending request, and snapshot must be checked against the correct generation before it can affect UI or Rust.

Local priority means current laptop intent wins a concurrent controller conflict. It does not justify applying arbitrarily delayed local events. Bind local origin sequence, observed generation/timeline, intended track, and a bounded causal/rebase window.

## Connection and Authentication

The user sees three URL-free buttons: Listen, Control, Upload. The password gesture discovers the active laptop and opens a fresh private path. Socket/data-channel open alone is not success.

Required readiness sequence:

```text
password gesture
 -> password-derived discovery
 -> requester/nonce-bound fresh private coordinates
 -> private channel writable
 -> mutual password proof and Rust server proof
 -> mode-scoped Rust grant
 -> initial authorized state
 -> control/listen/upload ready
 -> optional audio ready in parallel where possible
```

Install listeners before joining/opening. Retain proof material until the first authenticated send actually succeeds. Fence all callbacks by current route/epoch. Discovery cleanup, proof derivation, private connection, and optional audio setup should overlap when independent.

The current protocol is an explicitly documented MVP, not a PAKE. A weak human password and observed proof can permit offline guessing. Do not weaken it or claim more. A future protocol upgrade should separate a station identifier from password routing and use reviewed OPAQUE/SPAKE2 or a high-entropy invitation flow, with migration/version tests.

The 24-hour flow stores no raw password and requires a fresh nonce proof. Preserve expiry, device binding, password-change invalidation, mode scoping, mutual server proof, and Forget. Treat the current stored token as a bearer credential exposed to same-origin script; future proof-of-possession hardening must preserve the one-dialog user experience and revocation.

## Playback and Timeline Reconciliation

Rust state is authoritative, but the live media element owns continuous clock progression between timeline transitions. A snapshot position is an anchor, not an instruction to seek after every unrelated revision.

Hard-align playback only when:

- selected track changes;
- timeline generation changes;
- play/pause/stop/seek explicitly changes the timeline;
- measured drift crosses a justified threshold;
- reconnect obtains a fresh authoritative anchor.

Volume, mute, queue, playlist, favorite, metadata, upload, or other snapshots must not rewind playback. A local seek/scrub creates a bounded pending intent tied to track and expected position; stale projections cannot pull it backward while awaiting Rust, and rejection/timeout/track change clears it.

Remote listeners hear the laptop stream, not independent file playback. Late authenticated listeners receive current now-playing state and the active stream route after authorization.

## Uploads, Catalog, and Metadata

The browser supports both individual file selection and directory selection on capable browsers. Selection is only input; Rust determines what is accepted and where it is stored.

Current transaction rules:

- declare a bounded transfer and file set;
- accept only supported audio extensions and safe relative paths;
- stream ordered bounded chunks into private staging;
- verify exact offsets and final SHA-256;
- parse before commit;
- move into the visible managed `Zuradio Library` hierarchy without overwrite;
- catalog and publish each verified completed file immediately;
- remove only incomplete staging on abort/disconnect/restart.

Metadata precedence is user override, embedded tags, relative folder structure, filename inference, then safe fallback. User edits persist across rescans without rewriting original tags.

Correct bytes come before throughput. After integrity is proven, optimize with streamed browser slices, binary frames, bounded sliding windows, transport backpressure, resumable checkpoints, and an independently prioritized bulk lane. Always measure command acknowledgement while upload is saturated.

All accepted formats must be cataloged losslessly even when one host WebView lacks a decoder. Playback support and catalog/import support are separate claims.

An agent-facing or external upload CLI must be a client of the same public companion upload protocol and mode-scoped Rust grant. It may add structured machine-readable progress/results and non-interactive file/folder enumeration, but it must not expose the loopback daemon, invent a second authentication path, widen upload into control, put the password in process listings/logs, or bypass digest, staging, catalog, and completion gates.

Optional metadata-recognition helpers run outside the authority and transfer-control lanes with strict executable/provider allowlists, input/output/time/network bounds, cancellation, sanitized logs, and deterministic fallback metadata. Probe availability in the exact installed service environment—not the interactive shell—and distinguish `unavailable` from retryable provider failure. Recognition must not make already verified originals disappear, corrupt user overrides, or stall playback control.

Preserve native file/directory input elements while their browser event sequence is active. Copy each `FileList` into a new selection generation and update counters/status in place; do not rerender the upload panel in a way that replaces one picker while its or a sibling picker's delayed `change` event can still fire. Ignore events from older picker/selection generations, reset only deliberately, and test file-then-folder and folder-then-file in all three browser engines.

## Responsiveness Contract

The control critical path is:

```text
gesture -> typed send -> Rust validate/apply -> acknowledgement/state -> render
```

It must not wait behind:

- audio receiver connection;
- SVG visualization or audio analysis;
- cover art;
- scan, metadata recognition, or waveform generation;
- upload hashing/parsing/chunks;
- database work that can be prepared off-authority;
- discovery teardown that can run asynchronously.

Measure password-to-control-ready separately from password-to-audio and command-to-acknowledgement separately from final UI render. The repository's current ceilings are regression gates, not targets. Report real measured results and route/runtime context.

Use bounded queues and queue-age telemetry. Shed optional visual/progress cadence before authoritative control. Never silently drop a reliable command.

## Defect-to-Rule Ledger

| Observed defect | Durable rule |
|---|---|
| Random Rust `u64` broadcast epochs lost precision in JavaScript | Protocol integers crossing JS must be safe integers or strings/bytes, with parity tests |
| Controller trusted the peer without Rust-side proof | Every password session requires mutual proof before state, route, or grant exposure |
| UI displayed connected before proof plus initial snapshot | Readiness is an authenticated application milestone, not a transport event |
| Data channel reported open before first send succeeded | Retain handshake data and retry bounded sends within the fenced epoch |
| Late listener missed now-playing data | Send a fresh authorized snapshot when each observer channel becomes application-ready |
| Host clicks raced automatic `next` | Serialize each origin before Rust and keep revision/target preconditions |
| Local seek snapped backward after unrelated state publication | Use timeline anchors and a track-bound pending local intent; do not reapply stale position |
| Shuffle off could not restore order | Preserve the pre-shuffle canonical queue and specify additions during shuffle |
| CLI booleans only expressed `true` | Require explicit `true`/`false` values and exercise the executable end to end |
| Installer scanned before runtime credentials existed | Probe authenticated service readiness; process existence and sleeps are not readiness |
| Temporary upload name hid extension and digest leaked into title | Preserve parseable extension in staging and separate storage identity from display inference |
| Password KDF and discovery teardown delayed private control | Run independent handshake work concurrently and keep control readiness off optional paths |
| Control waited for a separate audio receiver | Mark control ready after proof/snapshot; attach audio asynchronously |
| WebKitGTK exposed a WebRTC switch but distro build lacked working WebRTC | Probe the exact packaged runtime and validate installed bytes; compile success is insufficient |
| Flatpak existed but the optional recognition application was absent in the installed service environment | Preflight the exact provider/application in the service context and classify unavailable separately from transient execution failure |
| WebKit delivered a delayed folder `change` after a newer file choice while rerendering replaced both inputs | Preserve picker DOM identity, update selection/status in place, and fence delayed events by picker/selection generation |
| Mobile controls or queue were hidden | Exercise all workflows at phone width; responsive layout may reorganize but not remove authority |
| Test clicked while host was intentionally busy | Wait for and assert semantic accessibility state, not arbitrary time |

Add new root causes here only when the lesson is durable and project-specific. Do not turn transient test details into permanent rules.

## Qualification Boundary

Completion evidence must include real browser intent reaching real Rust authority and returning to the user-visible browser. The full gate covers authentication, 24-hour reconnect, live audio, controls, playlists, file/folder upload, formats, permissions, responsive UI, security rejection, and latency ceilings.

Installed/public behavior requires the optimized installed daemon and packaged host runtime against the published Pages companion. A development server is not equivalent.

Keep “not yet qualified” honest. At the initial release-candidate audit these included physical phones on a different network, forced TURN, multiple simultaneous listeners, endurance/soak, malformed-media fuzzing/decoder isolation, Windows WebView2 and macOS WKWebView runtime behavior, and signed/notarized stable release artifacts. Do not silently convert CI compile or Playwright engine coverage into those claims.
