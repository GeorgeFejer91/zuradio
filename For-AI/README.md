# For AI

This is the mandatory first read for Zuradio. It keeps the control plane small and routes work to the three existing task and gate documents.

## Common control-plane contract

- **Boundary:** Product source, shipped assets, user documentation, and final deliverables stay outside this folder. This folder owns agent routing, durable context, verification policy, and decision pointers.
- **Authority:** Direct instructions and the nearest `AGENTS.md` win. Existing project documents remain authoritative for their named subjects; link instead of copying.
- **Skills:** Use `$ponytail` for every implementation, fix, refactor, code review, and technical design when available. Load other skills only for matching tasks; do not create speculative skill infrastructure.
- **Workflow:** Define one bounded outcome and its checks, reuse what exists, and make the smallest coherent diff.
- **Verification:** A task is ready only after focused checks, applicable full checks, diff review, and instruction synchronization. Report unrun checks and never overclaim evidence.
- **Self-update:** Update durable goals, constraints, decisions, routes, and gates in the same change that alters them. Do not keep chat logs, daily diaries, duplicate ledgers, generated evidence, or speculative backlogs.
- **Git:** Inspect status before and after work; stage only intended paths; use coherent, itemized commits; push validated completed work when branch policy permits. Never force-push, bypass protection, publish secrets, or absorb unrelated changes.
- **YAGNI:** Add a file here only when it has a distinct current owner and consumer. Prefer one section or link over a new document, script, dependency, or abstraction.
## Project route

- Read [VERIFICATION-GATE.md](./VERIFICATION-GATE.md) before any implementation or release claim.
- Read [TRANSPORT-SELECTION-TASK.md](./TRANSPORT-SELECTION-TASK.md) for transport decisions.
- Read [DATA-TRANSFER-GATE.md](./DATA-TRANSFER-GATE.md) for data-transfer work.
- Do not add another document unless none of these owners can hold a current, durable rule.
