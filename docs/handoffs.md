# Continuation and handoff

A handoff records evidence and the next action. It never replaces Git or a current
source inspection. Prefer a WIP commit and a draft PR/issue link for durable work;
`.smoke/` is temporary evidence, not a second project-state database.

Create a JSON record containing nonempty text for `objective`, `decisions`,
`tests`, `visual`, `performance`, `problems`, `remaining`, and `next`.
State exact commands/results, artifact locations and limitations; explicitly write
“not run” when needed. `next` must name the exact first action. Link the task base,
commits and PR in `decisions` or `remaining`. Then run:

```sh
npm run agent:handoff -- --record progress.json --out .smoke/handoff-1
npm run agent:resume -- --handoff .smoke/handoff-1
```

Creation records real Git branch/commit, tracked diff hash and actual uncommitted
file names alongside your evidence narrative. `HANDOFF.md` is readable by any agent;
`report.json` supports a state check. Resume exits nonzero on drift and prints both
states. It does not apply patches, reset the checkout, run recorded commands or
trust a stale next action automatically. An exact match is only a Git-state match:
verify untracked content and external artifact existence separately. Committed
changes require `git diff <task-base>...HEAD` as well as the uncommitted file list.

For durable delivery, put the reviewed handoff in the task PR body/comment or a
small task-specific document on the feature branch. Do not continually rewrite a
global “current state” file that diverges from Git. Private credentials and source
audio with unclear redistribution rights do not belong in a handoff or PR artifact.
