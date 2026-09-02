# Mandatory data-transfer verification gate

This gate applies to every change that can affect upload, download, streaming
bytes, file selection, chunking, staging, digest validation, media Range
responses, catalogue publication, managed-library placement, transfer recovery,
or the browser bridge. Such a change is not complete until this gate and the
full browser gate both pass.

## Required staged proof

Run `scripts/verify-data-transfer.sh` before
`scripts/verify-feature-completion.sh`. The command starts an isolated optimized
daemon and drives the production companion in Chromium through the real
VDO.Ninja data path. The test must prove, in order:

1. **Declaration:** the browser selects at least two real audio files and sends
   their IDs, relative paths, and exact sizes before bytes are accepted.
2. **Transfer start:** the UI observes non-zero acknowledged byte progress. The
   browser test must also observe the dedicated `x-zuradio-upload-v1` WebRTC data channel so a
   regression to large JSON/base64 frames cannot pass on loopback by accident.
   Audio frames remain ordered, grant-bound, sequence-bound, bounded by the
   negotiated SCTP limit, and subject to sender backpressure. The
   server continues to reject zero-byte files, excess sizes, wrong offsets,
   path traversal, unsupported formats, stale sequences, and wrong-mode grants.
3. **Per-file integrity:** every file is flushed and its browser SHA-256 digest
   is verified before it leaves private staging.
4. **Immediate catalogue publication:** the first completed song appears in the
   laptop library, and both the remote uploader and the local laptop transfer
   panel report it as catalogued, while later files in the same selection are
   still transferring. The local panel must show acknowledged bytes, percentage,
   current file, and completed-versus-total count. Do not defer this to batch
   `commit` or a later full-library scan. Acoustic recognition must begin only
   after this publication and run in parallel, so a slow or unavailable provider
   can never delay the catalogue or the remaining transfer.
5. **Visible organized original:** the verified bytes reside under the isolated
   `Zuradio Library/<album artist>/<album (year)>/<track - title [digest]>.ext`
   root. Each path component must be sanitized and the source bytes preserved.
6. **Batch completion:** `commit` succeeds only after all declared files finish.
   A disconnect, abort, or restart removes incomplete, unresumable staging data
   but never removes a file that already completed and entered the library.
7. **Authenticated download:** the local media endpoint retrieves each newly
   catalogued file byte-for-byte. The downloaded size and SHA-256 set must equal
   the selected source set. Public companion code must still have no direct
   original-file download route; remote listeners receive only the live audio
   stream.
8. **Recognition metadata and retrieval:** every completed fixture receives a
   separately stored acoustic-recognition status, provider ID, title, artist,
   album, genre, and deterministic SongRec fixture label. The browser must render
   that metadata alongside, without replacing, tag/folder-based metadata. Both
   the local host and authenticated remote controller must retrieve the track by
   a query that exists only in the Shazam album or genre fields. Production
   failures remain explicit `no_match`, `unavailable`, or retryable `error`
   states rather than blocking or inventing metadata.
9. **Performance:** report source bytes, time to first catalogue publication,
   recognition completion, upload duration/rate, download duration/rate, and
   organized-file count. The defaults are first catalogue under 90 seconds,
   recognition fixture completion under 30 seconds, upload above 32 KiB/s through
   the live bridge, and authenticated loopback download above 1,000,000 B/s.

The performance floors are regression ceilings, not targets. They may be made
stricter through `ZURADIO_FIRST_CATALOGUE_LIMIT_MS`,
`ZURADIO_UPLOAD_FLOOR_BPS`, and `ZURADIO_DOWNLOAD_FLOOR_BPS`; do not lower them
to excuse a failure. Attach the emitted JSON benchmark to the final handoff.

On the installed Linux product, `scripts/install-songrec-helper.sh` must verify
the pinned official package digest, executable version, runtime linkage, and
copyright/source notices. The installed service environment—not an interactive
shell—must resolve that private helper. Do not silently downgrade production to
an optional provider while claiming automatic acoustic metadata is integral.

## Test layers that must remain

- Rust upload tests cover path and size bounds, strict offset ordering, digest
  mismatch, per-file survival after grant revocation, restart cleanup, metadata
  inference, destination sanitization, and hidden-library migration.
- `web/tests/e2e/data-transfer.spec.ts` is the browser/CLI benchmark above.
- `web/tests/e2e/upload.spec.ts` covers direct file selection, folder selection,
  a Windows Chromium identity, a stale competing host, wrong passwords, and the
  standalone `web/scripts/upload-cli.mjs` path. It must force a receiver-side
  first-chunk rejection and prove the CLI prints that error plus its last transfer
  stage rather than only timing out while waiting for final success.
- The full multi-browser gate remains mandatory after the focused transfer gate.

Never replace a stage with a mocked channel, an HTTP-only upload, a unit test,
or a check that merely sees an `On` flag. If a transfer stage is intentionally
changed, update its assertion and explain why the same user-visible and
byte-integrity guarantee is preserved.

## Transport-selection benchmark

Any change to the remote transport, binary framing, chunk/window size,
backpressure, browser file streaming, or host-to-Rust byte handoff must also
follow [TRANSPORT-SELECTION-TASK.md](TRANSPORT-SELECTION-TASK.md) and run
`scripts/benchmark-transfer-protocols.sh` before the complete browser gate.
The fastest raw microbenchmark is not automatically the product winner:
selected-route directness, NAT reachability, command latency under saturation,
memory bounds, and complete upload/catalogue semantics remain mandatory.
