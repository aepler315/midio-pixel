# Version picker (switched off)

The version picker (#412) put every past engine on the public site: big
arrows to step through versions, a searchable list, and the current song
carried across. It is switched off. The site and `npm start` serve only the
latest engine.

Its code is still in the repo and still unit-tested, just not published:

| Piece | Where |
| --- | --- |
| Picker page and UI | `src/ui/HistoryPicker.js`, `history-shell.html`, `history-picker.css`, `HistoryFiles.js`, `HistorySource.js`, `history-worker.js` |
| Builds the site with every version | `tools/stage-history.mjs` (`npm run stage:versions`), `tools/lib/version-history.mjs` |
| Local server that builds it on start | `tools/start-history.mjs` |
| Unit tests (still run by `npm test`) | `test/version-history.test.mjs`, `test/history-files.test.js` |
| Server routes for its files | `staticPath()` in `tools/serve.js` (harmless when unused) |

## Turning it back on

1. **Publish it.** In `.github/workflows/static.yml`, job `stage`:
   - give the Checkout step `with: fetch-depth: 0` (it needs the whole history);
   - replace the "Stage public site" step's `npm run stage:site` with
     `npm run stage:versions`;
   - drop the "Validate staged artifact" step, or point it at the picker.
2. **Serve it locally (optional).** In `package.json`, point `start`, `dev`
   and `start:full` at `node tools/start-history.mjs` instead of
   `node tools/serve.js`.
3. **Browser check (optional).** The Playwright check that drove the picker
   (`tools/history-picker-smoke.mjs`, run as `npm run test:versions` in a
   `version-browser` job of `test.yml`) was deleted along with the switch-off.
   Restore it with `git show <commit>^:tools/history-picker-smoke.mjs`, where
   `<commit>` is the one that removed it (`git log --diff-filter=D --
   tools/history-picker-smoke.mjs`). If you restore it, note that its
   fullscreen step searches the second-newest version by a word from its
   label.

Or revert the switch-off commit, which does all three.

`npm run archive` (the local version archive, #411) is a separate tool and
still works.
