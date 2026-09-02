---
name: zuradio-builder
description: Build, debug, secure, test, install, or release the GeorgeFejer91/zuradio Rust music app and its static smartphone Web Companion. Use only for Zuradio repository work involving its Rust core/daemon/CLI, Chromium or Tauri desktop shell, VDO.Ninja WebRTC bridge, password and trusted-browser protocol, local music catalog/playback, playlists, uploads, GitHub Pages companion, packaging, or mandatory browser qualification. Do not use for generic music-player, Rust, Tauri, or website work outside Zuradio.
---

# Zuradio Builder

Maintain Zuradio as one local-first product: a laptop-owned Rust authority, a lightweight desktop/CLI surface, and a static mobile-friendly Web Companion that controls or hears the live laptop without hosting the music collection.

## Start With Repository Authority

1. Locate the actual Zuradio checkout and read its root `AGENTS.md` completely.
2. Read `For-AI/VERIFICATION-GATE.md` before any behavior-affecting change.
3. For uploads, downloads, media bytes, staging, catalog publication, managed-library paths, or recovery, also read `For-AI/DATA-TRANSFER-GATE.md` before editing.
4. Read the relevant current project documents rather than relying on this compact route:
   - `docs/architecture.md`
   - `docs/threat-model.md`
   - `docs/upload-protocol.md`
   - `docs/qualification.md`
5. Read [project-contract.md](references/project-contract.md) for the defect-to-rule map and subsystem invariants.
6. Inspect the working tree before editing. Preserve unrelated/user/other-agent changes and serialize commits in a shared checkout.

The repository instructions and pinned source always override historical assumptions in this skill.

## Hard Product Invariants

- GitHub Pages distributes companion HTML/CSS/JavaScript only. It never stores music, catalog state, passwords, grants, media URLs, or authenticated responses.
- The laptop Rust core is the sole authority for library, queue, playlists, playback policy, uploads, grants, and state revision. Browser and VDO.Ninja code are bounded adapters.
- Music is heard remotely only as a live laptop-originated stream while the installed host and broadcast are active.
- The remote action surface is one closed typed schema. Never expose shell, process, arbitrary path, URL fetch, SQL, dynamic Rust/Tauri function lookup, DOM event injection, or generic CLI parsing.
- `listen`, `control`, and `upload` remain distinct least-authority modes. Authentication does not imply every scope.
- The local laptop operator has the highest current player authority, but seeks and other noncommutative actions remain bound to the intended track/timeline and revision context.
- Passwords and bootstrap URLs are never printed, logged, committed, put in query strings, or returned to remote browsers. The raw remote password is never stored in browser origin storage.
- Stop/restart/credential rotation revokes the complete broadcast authority generation: routes, grants, partial transfers, old callbacks, and replay sequences.
- Low perceived latency and fast recovery are absolute priorities after security, authority, and byte integrity. Interactive commands must not wait for optional audio analysis, visualizers, scans, metadata recognition, or bulk transfer.
- Every behavior-affecting task ends with the repository's real browser-to-Rust gate. Unit tests, curl, mocked transport, screenshots, flags, and compilation are supporting evidence, never substitutes.

## Route the Change

- Rust domain, catalog, queue, playlists, metadata, revision, actor, or command work: inspect `crates/zuradio-core` and keep adapters out of domain logic.
- Loopback HTTP/WebSocket, authentication, grants, upload staging, media Range, CLI server/client, or service work: inspect `crates/zuradio-daemon` and re-evaluate the threat model.
- Host/companion UI, WebRTC, audio graph, connection lifecycle, trusted-browser reconnect, timeline sync, responsive layout, file/folder picker, or Pages work: inspect `web` and exercise independent browser contexts.
- Desktop/runtime work: inspect `apps/zuradio-desktop`, `packaging`, and the installed launcher/service. A successful Tauri compile does not prove the packaged WebView supports WebRTC.
- Deployment work: preserve the companion-only artifact invariant and verify the published GitHub Pages bytes against the installed local app.

Use `$tauri-rust-developer` when a change needs general Tauri/Rust/browser-companion architecture and `$uncodixfy` when generating frontend code, if those skills are available. Zuradio's own gates remain controlling.

## Implementation Workflow

1. Reproduce the user-visible failure and record the exact authority, transport, browser/runtime, and connection state.
2. Trace one semantic operation end to end: UI/CLI intent -> typed request -> authentication/scope -> Rust authority -> revisioned result -> acknowledgement/snapshot -> rendered or audible outcome.
3. Write or update the browser scenario before or with the fix. Preserve existing assertions.
4. Keep one authority. Do not repair races with a second JavaScript store, optimistic DOM click, fixed sleep, page reload, or polling loop.
5. Fence asynchronous work by broadcast authority generation and transport epoch. Late events from an old route are inert.
6. Keep command IDs stable across ambiguous retries, state revisions monotonic, and moving playback synchronized by track/timeline anchors rather than repeated stale positions.
7. Move scans, recognition, hashing, parsing, and large transfers off the interactive authority path; make their final commit short and bounded.
8. Verify focused Rust/frontend behavior, then run every mandatory repository gate.

## Mandatory Completion Gate

Follow the current command sequence in `For-AI/VERIFICATION-GATE.md`; do not substitute commands copied from this skill if the repository changes. At the current project baseline:

- run focused tests and optimized builds appropriate to the changed layers;
- for transfer-related work, run `scripts/verify-data-transfer.sh` first and retain its byte-integrity/throughput artifact;
- run `scripts/verify-feature-completion.sh` for the complete live VDO.Ninja browser-to-Rust matrix;
- when installed desktop or public companion behavior changes, cold-launch the actual installed runtime and exercise the public GitHub Pages companion against it using the repository's installed-public verifier;
- inspect browser console/page errors and user-visible mobile behavior;
- report connection and command latency, transfer throughput when relevant, runtime/browser versions, pass counts, and any physical-device/release gates that remain open.

A timeout, skipped scenario, narrowed assertion, or mocked-only path is a failed completion gate. Diagnose and fix the root cause, rerun the focused failing scenario, then rerun the full gate.

## Security and Responsiveness Review

For remote-path changes, explicitly review:

- routing versus identity versus authorization;
- password/proof transcript, fresh nonce, mutual confirmation, mode binding, grant expiry/revocation, and replay sequence;
- trusted-device expiry, device binding, nonce proof, password-change invalidation, Forget, and absence of raw password storage;
- exact host/origin/cookie/bearer separation at loopback;
- authority generation, transport epoch, reconnect/Stop behavior, and stale callback suppression;
- command acknowledgement ambiguity, duplicate effects, expected revision, and target preconditions;
- authoritative snapshot monotonicity and playback timeline drift/snap-back behavior;
- command latency while scan/upload/recognition/media work is active;
- peer/message/rate/byte/queue/time bounds and cleanup on every failure path.

Do not weaken proof work factors, scope boundaries, replay checks, the companion-only Pages artifact, or local authority to improve a benchmark.

## Completion Report

Lead with the observable result. Include changed subsystems/files, the important authority/security/latency decision, exact commands and outcomes, measured timings, installed/public validation when required, and honestly untested physical/runtime boundaries. Never expose the password, bootstrap fragment, private routes, tokens, or grants in the report.
