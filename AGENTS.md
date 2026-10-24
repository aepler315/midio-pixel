# Midio-5 coding workflow

Run browser review in the background without interrupting the user's work.
For bounded Landscape captures, use `npm run review:landscape -- --out
.smoke/<unique-run>` and `docs/landscape-review.md`. Keep Chromium headless,
retain its isolated temporary profile and muted audio, and hide helper-process
windows on Windows. Save reports and clips without automatically opening them.
Do not launch a headed browser, focus a user window, or attach to the user's
Chrome session unless the user explicitly requests that interaction.

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

Checkouts are LF everywhere (`.gitattributes`), and pinned Range/vendor bytes
are never converted. A clone made before that rule may still hold CRLF files,
which `test/lineEndings.test.js` reports. Refresh such a clone once:

1. Commit or stash your own work first; the steps below rewrite files.
2. `git status` may still list files under `src/vendor`, `ridgeview/vendor`
   or `src/assets/range/v2`. Those paths can hold real work, so a modified
   status alone proves nothing. Discard them only after
   `git diff --ignore-cr-at-eol --quiet -- src/vendor ridgeview/vendor src/assets/range/v2`
   exits 0 (the differences are line endings only), with
   `git checkout -- src/vendor ridgeview/vendor src/assets/range/v2`.
   Never commit those CRLF bytes.
3. When `git status --porcelain` prints nothing, rewrite every tracked
   file from HEAD: `git rm --cached -r -q . && git checkout HEAD -- .`.

Never use `git add --renormalize`: for `-text` paths it stages the CRLF bytes.

Run relevant behavior tests and `npm test`/`npm run lint` before completion;
`npm run validate` runs the full local gate (docs/local-validation.md).
Document unavailable browser/device checks accurately. For nonvisual changes,
use the tests relevant to the change; a visual capture is unnecessary.
