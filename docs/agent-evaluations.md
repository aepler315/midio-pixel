# Coding-agent evaluation tasks

`evaluations/tasks.json` contains ten assignments: terrain geometry, pixel
fidelity, audio mapping, growing cameras, performance, geography, regression
debugging, constrained-device UI, architecture and safe modification. Each has
starting context, a concrete objective, observable acceptance criteria, selected
production tests, a 100-point rubric and required artifacts. No proprietary API
is needed; the model/agent can work manually in any harness.

```sh
npm run eval:agents
npm run eval:agents -- --task terrain-geometry --out .smoke/eval-run-1 --model MODEL_AND_HARNESS --artifacts PR_OR_ARTIFACT_LOCATION
```

Start models from the same clean commit in separate branches/worktrees, with the
same task text, tools, time/effort limit and declared constraints. Have the model
perform the assignment first. Run its catalog checks and relevant broader checks
against the resulting branch. The runner records current Git identity, test logs,
artifact pointer and an unassessed score. It never calls a model, changes code,
claims a model completed the assignment or awards points merely because tests pass.

A reviewer inspects the patch and artifacts against every acceptance criterion.
Use `--assessment assessment.json` with `reviewer`, `evidence` (artifact references)
and `scores` (one numeric score per rubric row, within its points). Run again into
a new output directory to attach that assessment. Record missing evidence and
partial credit in `evidence`; tests cover only part of artistic/device correctness.
Keep full transcripts/cost/time records externally with the run when comparing
systems, and record whether the model saw hidden checks or prior solutions.

No model-comparison results are asserted by this infrastructure. A local runner
rehearsal validates the runner only. Baseline test failures and unavailable browser
or hardware checks are confounders to report, not points to silently waive.
