# Mandatory browser verification gate

This gate applies to every future agent working on Zuradio. A task that can affect behavior is **not done** until its user-visible function has been exercised in a real browser and the required gate passes.

## Non-negotiable responsiveness priority

Low latency, fast connection establishment, and immediate UI feedback are absolute Zuradio product priorities. Within the security, correctness, and data-integrity boundaries, every implementation must minimize user-perceived waiting and avoid serial network work that can safely run in parallel.

- Remote-path changes must measure password-submit-to-ready latency and browser-command-to-laptop-acknowledgement latency through the real VDO.Ninja path. The qualification suite enforces less than 15 seconds to establish listener or controller access and less than 2 seconds for an acknowledged control command. Treat these as regression ceilings, not performance targets; optimize for the lowest stable measured values.
- Keep player commands on the direct ordered WebRTC data channel. Do not add polling, fixed sleeps, proxy round trips, media uploads, or page reloads to an interactive command path.
- Run independent setup work concurrently where safe. The authenticated control surface must not wait for optional audio-analysis, visualizer, or secondary listener setup.
- Preserve the 210,000-round password proof, role boundaries, replay protection, and no-music-on-GitHub-Pages rule. Performance work may not weaken authentication or authorization.
- Preserve the one-password/24-hour trusted-browser flow: never store the raw password, require a fresh nonce-bound proof on reconnect, enforce device binding and expiry in Rust, and invalidate remembered credentials when the laptop password changes. The gate must send and acknowledge a real control command after the passwordless reconnect; rendering the controls alone is not proof.
- Report measured connection and command latency in the verification artifact and final handoff. A feature that works but introduces an avoidable responsiveness regression is not complete.

## Required completion sequence

1. Add or update a Playwright scenario under `web/tests/e2e/` for every changed user workflow, regression, permission boundary, or responsive UI state. Assert the outcome a user experiences, not merely an HTTP response or implementation detail.
2. Build the optimized Rust daemon and production web assets.
3. Run `scripts/verify-feature-completion.sh`. It executes the live browser-to-Rust qualification path through VDO.Ninja, including the password, 24-hour passwordless reconnect, stream, control, latency budgets, playlist, upload, format, security, and responsive UI scenarios.
4. If the change affects the installed desktop shell or public companion, cold-launch the installed app and exercise the public GitHub Pages site against that real app. Confirm that the browser receives the expected stream/control result; a backend `On` flag alone is not proof.
   On this Linux installation, launch the app with an inspection port and run `node web/scripts/verify-installed-public.mjs` with `ZURADIO_TEST_PASSWORD_FILE` and `ZURADIO_INSPECTOR_URL` set. Do not print the password or bootstrap URL.
5. Record the command, pass count, browser/runtime, and any intentionally untested physical-device or release-channel limits in the final handoff.

## Hard rules

- Never declare completion while the gate is failing, skipped, timed out, or was not run.
- Never replace the browser run with unit tests, typechecking, screenshots, mocked transport, curl, or visual inspection.
- Never weaken, skip, delete, or narrow an existing end-to-end assertion merely to make a change pass.
- A failed browser scenario is a product defect until its root cause is fixed and the full gate passes again.
- Preserve test isolation: use the qualification script's temporary database and cleanup path; never stop the user's installed broadcast as test cleanup.

CI runs the same gate on every pull request and push to `main`. Agents must still run it locally before handoff because remote CI is confirmation, not the first functional test.
