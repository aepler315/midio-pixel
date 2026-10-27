# Midio-5 coding workflow

Run browser review in the background without interrupting the user's work.
For bounded Landscape captures, use `npm run review:landscape -- --out
.smoke/<unique-run>` and `docs/landscape-review.md`. Keep Chromium headless,
retain its isolated temporary profile and muted audio, and hide helper-process
windows on Windows. Save reports and clips without automatically opening them.
Do not launch a headed browser, focus a user window, or attach to the user's
Chrome session unless the user explicitly requests that interaction.

For changes to rendered appearance or its relationship to music,
`docs/visual-evaluation-loop.md` describes an optional visual comparison
workflow. A baseline or visual capture is not a prerequisite for editing or
completing a change. When useful and available, compare matching captures and
inspect the rendered images and audio; use continuous capture to assess render
history, since sparse captures skip draws between windows.

For visual findings, identify the song and timestamp and distinguish observed
results from unverified expectations. Passing tests or changed pixels alone do
not establish visual quality. Preserve any existing evidence and unrelated work,
and report unavailable visual or device checks accurately.

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
