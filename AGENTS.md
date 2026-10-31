# Midio Pixel development

Midio Pixel is an experimental music visualizer. Follow the current user task
and [experimental-development policy](docs/experimental-development.md).
Earlier plans, audits, preservation lists, review holds and rejected trials
record their own revisions; they do not freeze future development.

## Experiment and iterate

- Implement requested experiments and make routine technical decisions without
  repeatedly seeking approval. Keep work reviewable and explain material choices.
- Renderers, terrain representations, pixel treatments, looks, cameras, scenes,
  audio/visual relationships, weather, quality budgets, defaults and optional
  features may evolve. Existing architecture and numerical limits are starting
  points, not permanent design requirements.
- Use branches, small pilots, comparisons or feature switches when they help
  the work. A separate prototype, fixed pilot order or opt-in switch is not a
  universal prerequisite. Preserve unrelated user work.
- Candidate experiments may be built and reviewed before full visual or device
  validation. Keep actual runtime eligibility and approval metadata accurate;
  changing a flag does not create missing evidence. Runtime checks may be
  intentionally redesigned with their consumers and tests.

## Verify what changed

Choose checks proportionate to the change. Run focused behavior tests and lint
for executable changes; use the full suite and browser/device tools when they
help assess integration or release readiness. Documentation-only edits normally
need consistency, link and whitespace checks rather than a full rendering run.
[`npm run validate`](docs/local-validation.md) remains a convenient comprehensive
check, not a prerequisite for every experiment, local commit or draft review.

Use [visual comparisons](docs/visual-evaluation-loop.md) when useful. Capturing
a baseline, completing an artistic review, reaching a clean full suite or having
a particular GPU/device is not required before editing or continuing an
experiment. Report failures, baseline failures, unavailable tools and unrun
checks. Claim visual, musical or device outcomes only when actually observed;
include the song and timestamp for specific visual findings.

## Work carefully

Default automated browser work to an isolated, headless, muted session and save
reports without opening them. Use `npm run review:landscape -- --out
.smoke/<unique-run>` for bounded captures. Respect the user's browser preference
and avoid interrupting their active session.

Keep generated evidence in `.smoke/` or external artifacts rather than adding
large captures to Git. Retain attribution, licenses, private credentials and
unrelated files. Respect `.gitattributes`; avoid accidental line-ending changes
to vendor or pinned assets. Intentional asset/runtime changes should update the
corresponding pins, manifests and verification tools together.

Publishing, merging and other external actions follow the current user's
authorization and the host's permissions. These docs do not grant additional
platform permissions or turn an unrun check into a passing result.
