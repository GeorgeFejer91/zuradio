# Zuradio agent instructions

> Mandatory first read: [For-AI/README.md](./For-AI/README.md). It is the YAGNI control-plane router; then follow the project-specific rules below.

Read and obey [For-AI/VERIFICATION-GATE.md](For-AI/VERIFICATION-GATE.md) before changing this repository.

No feature, fix, refactor, dependency update, or release task is complete until the mandatory browser verification gate has passed and the final handoff reports its evidence. Do not waive the gate because unit tests, compilation, screenshots, or API checks pass.

Responsiveness, minimum remote latency, and fastest reliable connectivity are non-negotiable product priorities. Preserve the performance ceilings and measurement requirements in the verification gate, and optimize below them without weakening security or correctness.

<!-- for-ai:shared-skills:start -->
## Shared project workflow

At project entry, also read [For-AI/SKILLS.md](For-AI/SKILLS.md) for the required RTK, GSD Core,
and Superpowers baseline, conditional Rust/Tauri/HTML routes, and Git worktree
policy. Preserve this project's product and evidence contracts.

Read the durable project goal and resume its active checklist at session
start. Before ending, update that same state with evidence, blockers, the
next action, and observed Git/publication state. Keep the overall goal open
until its own acceptance criteria pass.
<!-- for-ai:shared-skills:end -->
