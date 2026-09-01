# Mandatory browser verification gate

This gate applies to every future agent working on Zuradio. A task that can affect behavior is **not done** until its user-visible function has been exercised in a real browser and the required gate passes.

## Required completion sequence

1. Add or update a Playwright scenario under `web/tests/e2e/` for every changed user workflow, regression, permission boundary, or responsive UI state. Assert the outcome a user experiences, not merely an HTTP response or implementation detail.
2. Build the optimized Rust daemon and production web assets.
3. Run `scripts/verify-feature-completion.sh`. It executes the live browser-to-Rust qualification path through VDO.Ninja, including the password, stream, control, playlist, upload, format, security, and responsive UI scenarios.
4. If the change affects the installed desktop shell or public companion, cold-launch the installed app and exercise the public GitHub Pages site against that real app. Confirm that the browser receives the expected stream/control result; a backend `On` flag alone is not proof.
5. Record the command, pass count, browser/runtime, and any intentionally untested physical-device or release-channel limits in the final handoff.

## Hard rules

- Never declare completion while the gate is failing, skipped, timed out, or was not run.
- Never replace the browser run with unit tests, typechecking, screenshots, mocked transport, curl, or visual inspection.
- Never weaken, skip, delete, or narrow an existing end-to-end assertion merely to make a change pass.
- A failed browser scenario is a product defect until its root cause is fixed and the full gate passes again.
- Preserve test isolation: use the qualification script's temporary database and cleanup path; never stop the user's installed broadcast as test cleanup.

CI runs the same gate on every pull request and push to `main`. Agents must still run it locally before handoff because remote CI is confirmation, not the first functional test.
