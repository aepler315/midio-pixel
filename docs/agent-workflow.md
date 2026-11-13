# Agent development lifecycle

**Inspect → Understand → Plan → Implement → Test → Render → Benchmark → Review → Deliver**

1. Read `AGENTS.md` and the current task. Inspect `git status`, branch, default
   branch tip, recent history, open PRs, applicable nested instructions, tests
   and relevant source. Never treat a prior handoff or this conversation as
   current repository state. Find existing implementations before adding one.
2. Read architecture, visual and performance contracts and relevant decisions.
   Trace the actual caller/consumer relationship. Identify whether the behavior
   is active, partial, experimental or historical. New task decisions can evolve
   older plans without pretending unrun runtime approvals already exist.
3. Define observable acceptance criteria and failure cases. Choose focused
   tests, representative song/time/seed/view/grid and comparable benchmark.
   Record consequential choices as a short decision; a small change needs no
   large plan. Use a feature branch based on current main; preserve others' work.
4. Implement bounded changes. Write a regression test that demonstrates a bug
   before fixing it; verify tests exercise production consumers, not only helper
   math. Reuse shared frame state, budgets, seeding and generation ownership.
5. Run focused tests and lint. For broad integration, run `npm test`, the separate
   ridgeview suite, module graph and `npm run stage:site`. Diagnose actual failures;
   keep pre-existing failures named and separate from introduced ones. Use
   `npm run validate` when its comprehensive browser coverage answers the task.
6. Render actual production output for visual changes. Use the small corpus for
   quick comparison and `review:landscape` for consecutive frames and matching
   audio. Inspect the pictures yourself, including close ridge, wide composition,
   growth phases and weather. Report technical/artistic/device judgments separately.
7. Compare supported costs on one environment. Check source/asset/workload hashes,
   actual renderer and quality settings before interpreting timing. Use operation
   counts, CPU, browser delivery and physical-device evidence for the questions
   each can answer. Collect initial baselines when none exists; do not invent one.
8. Investigate failures and iterate. Do not weaken the comparison or replace its
   reference just because a candidate changed. A requested artistic change gets
   an explicit review and documented reference migration.
9. Review the whole diff, generated pins/imports, public asset staging, test
   failures, dependencies and workflow permissions. A second agent or contributor
   should review when available; identify a self-review honestly. Verify each
   acceptance criterion against an observed result.
10. Commit focused changes and open a PR with evidence, known gaps and exact
    reproduction commands. Do not merge or deploy unless separately authorized.
    On interruption, create a [handoff](handoffs.md), commit where appropriate and
    resume by verifying Git state. Git commits/PRs/issues are the durable record.

Provider-independent checklist: [.agents/workflows/engineering.md](../.agents/workflows/engineering.md).
No proprietary model APIs are required. [Evaluation tasks](agent-evaluations.md)
exercise the same project-native commands with different agents manually.
