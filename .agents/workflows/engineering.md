# Midio Pixel engineering workflow

Entry point: read `/AGENTS.md` and follow `/docs/agent-workflow.md`.
This is provider-neutral workflow text, usable without an installed skill loader.
It grants no additional platform permissions and does not override the current task.

- Inspect current branch, source, requirements, PRs and existing implementation.
- Define acceptance criteria; record only consequential design decisions.
- Implement on a feature branch and test actual production relationships.
- Run focused/full tests, lint, module checks and production staging as relevant.
- Capture real output, inspect it, and compare with a reviewed reference.
- Benchmark supported costs on comparable environments and retain limitations.
- Diagnose failures; never silently rebaseline or fabricate device evidence.
- Review final diff and deliver a PR containing actual verification artifacts.
- On interruption: `npm run agent:handoff`; on resumption: `npm run agent:resume`.
