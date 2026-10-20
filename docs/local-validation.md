# Local validation and publishing

Routine validation runs locally, without GitHub Actions minutes. All test and
visual workflows are manual (`workflow_dispatch`) only; they have no push,
pull-request, schedule, or reusable-workflow trigger. Do not dispatch hosted
validation unless explicitly requested.

Use Node 24 and the locked dependencies:

```sh
npm ci --no-fund
npm audit --audit-level=high
npm run lint
npm test
npm --prefix ridgeview test
npm run stage:site
npm run test:bootstrap
```

For upload and playback, start `npm start` in another terminal, then run
`npm run test:smoke -- http://127.0.0.1:8080`. Repeat against a server with
`SITE_ROOT=_site` to check the staged application. Browser checks are headless.
Retain logs and captures outside Git.

The active publisher is GitHub's branch-based Pages build and deployment,
confirmed on main at commit 9a500dfbb07b3f389c4efae47f8a30e3b9cce4ac. It is
independent of the Test workflow. Keep repository Pages settings unchanged.
The optional manual `static.yml` workflow stages and publishes without calling
test workflows or installing Chromium; run the checks above locally first.
Changing workflow triggers does not clear historical billing-blocked runs.
