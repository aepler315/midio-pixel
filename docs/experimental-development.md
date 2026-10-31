# Experimental development

Current policy, updated 2026-10-31 at the owner's request.

Midio Pixel is open to experimental development. A current task authorizes
implementation, investigation and iteration within its scope. Make routine
technical choices, keep the result reviewable and report what was learned.
Ask for a consequential missing product decision when it is actually needed;
do not create another approval step from an older plan or an optional workflow.

## What may change

Experiments may replace or extend renderers, terrain and forest representations,
pixel grids and reconstruction, visual styles, palettes, scene catalogs, camera
routes and timing, music responses, weather, lighting, output sizing, performance
budgets, defaults and optional features. Existing values describe the current
implementation. They are available for intentional revision with their affected
code, interfaces and documentation.

Choose a bounded pilot, parallel alternatives, a feature switch or a direct
implementation according to the task. Earlier pilot orders, preservation lists,
scope exclusions and decisions to close an investigation do not prohibit a new
experiment. A previously rejected approach may be revisited with a new hypothesis.

This policy does not itself change application behavior. An implemented runtime
check, approval field, supported browser API or asset hash remains real until
the corresponding implementation changes. Describe candidate eligibility and
review status accurately while experimenting; do not relabel unreviewed evidence
as approved merely to satisfy a loader.

## Evidence supports iteration

Use the checks that answer the current question. For code changes, focused
behavior tests and lint are useful starting points. Run broader suites, matched
render captures, representative music and real-device checks when available
and relevant. Documentation-only work normally needs editorial, link and
whitespace checks. Full local validation remains available for broad changes
and release preparation.

Baseline captures, a passing full suite, a particular GPU, a complete visual
corpus and owner artistic signoff are not prerequisites for starting or
continuing an experiment, committing local work or preparing a draft review.
An unrelated baseline failure or missing tool should be recorded along with
the checks that did run. Fix regressions introduced by the change or clearly
identify remaining work; never represent failed, skipped or unrun checks as
passing.

Visual and musical judgments require actual observation. State the recording,
timestamp and environment for a specific finding. Unit tests, changed pixels
and software-rendering timings support only the claims they measure. Partial
evidence can guide the next iteration without being presented as release or
device validation.

## Reading older material

This policy and the current user task govern development. Dated plans, audits,
reviews, evidence records and inherited Midio-5 documents retain their historical
results, command examples and design rationale. Instructions such as “preserve,”
“on hold,” “out of scope,” “before editing” or “approval required” in those
records describe the scope of that recorded work, not standing vetoes on a new
task. Consult the current source for actual behavior and runtime requirements.

Current task-specific instructions can still set a scope, a comparison method
or a release decision. Keep that distinction explicit rather than treating all
historical requirements as active.

## Practical boundaries

Keep unrelated work, source provenance, attribution, licenses and credentials
intact. Use isolated browser sessions by default and avoid interrupting the
user. Keep generated captures outside the source tree's tracked history unless
the user deliberately chooses another destination. Asset changes should carry
consistent manifests, pins and compatibility handling.

This repository policy removes stale development restraints. It does not
override the host's permissions, authorize an external action the user has not
authorized, or alter operational/security requirements by changing prose.
