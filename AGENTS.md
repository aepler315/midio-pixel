# Midio-5 coding workflow

For work that changes rendered appearance or its relationship to music, use
`docs/visual-evaluation-loop.md` before editing. Capture a baseline with
`npm run visual:eval -- --out .smoke/<unique-baseline>`, inspect the actual
images and matching audio, make a scoped change, then capture the identical
manifest as a candidate and run `--compare`.

State the song and timestamp for each finding. Judge musical legibility,
composition and motion from rendered evidence. Numeric controls, passing
unit tests, or changed pixels alone are not visual acceptance. Use continuous
capture when changing render history; sparse captures skip draws between
windows. Preserve baseline evidence and unrelated work. Do not auto-promote
an aesthetic change merely because the capture command passed.

Never commit captured evidence (PNG, GIF, MP4, ZIP, HTML reports, capture
JSON) to the repository: every byte stays in git history forever. Keep it in
`.smoke/`, retain it as a CI artifact (`actions/upload-artifact`), or attach
anything that must outlive artifact retention to a GitHub Release, and link
it from the PR description. `docs/evidence/` is closed to new files; see its
README.

Run relevant behavior tests and `npm test`/`npm run lint` before completion.
Document unavailable browser/device checks accurately. For nonvisual changes,
use the tests relevant to the change; a visual capture is unnecessary.
