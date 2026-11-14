# Settings and listener zoom follow-up validation

Base: `6e7222e`, the merge of PR #137. Node 24.22.1, Linux x64, AMD EPYC
9V74 execution host. No JOYING/Android or physical-GPU result is claimed.

## Behavior checked

- All 15 Camera Studio preferences and both MP4 preferences resolve through
  the settings registry/store. Legacy records, URL precedence without implicit
  saving, validation, sharing, live application, reset and reload are covered.
- Reset/save actions honor capture guards before changing storage, URL,
  source metadata or live settings. Full reset is refused atomically. Rejected
  URL input is cleared by reset; failed saves retain the visit's override.
  Persistence is checked by reading back through the existing storage adapter.
- Grouped editor navigation does not save preferences. Camera Studio explains
  unavailable states; its checkbox enables it. Live snapshots use the existing
  normalized-object fast path.
- Production MP4 arming and transaction code preserve an off-centre, partially
  eased listener camera for completion, cancellation and encoder failure. The
  regression executes the actual camera/session and replaces renderer/codec
  boundaries. Fixed-clock export still disables listener-camera input.
- Public settings retain artistic/playback/output choices. Exactly 19 quality
  and engineering controls move into Diagnostics, and each external editor has
  one navigation action. See [decisions](settings-simplification.md).

## Executed checks

| Check | Result |
| --- | --- |
| Focused settings, camera, export, display and quality regressions | 87 passed, zero skipped |
| Independent production SettingsPanel + SettingsStore DOM smoke | 11 scenarios passed, zero jsdom errors |
| Independent settings adapter value check | 119 default/option/boundary values round-tripped |
| ESLint | Passed |
| Tracked module graph | 466 modules parse and link |
| Ridgeview | 26 passed |
| Generated URL reference | Current |
| Production staging | Passed |
| Full application suite | 5,706 passed, 13 skipped, one existing timing failure (5,720 total; 461.8 seconds) |
| CPU benchmark comparison | Sequential main/candidate comparison passed all eight scenarios; all output checksums identical |

The full suite's existing `an 18-shot library and a 3-minute song plan in under
50 ms` assertion was separately reproduced on unchanged main and the candidate.
At unchanged main, warm/fresh-library minima were 56.6/77.6 ms; candidate minima
were 56.2/81.1 ms. The planner and its threshold are unchanged. These are host
measurements, not physical-device frame rates.

The first CPU benchmark comparison overlapped the full suite. All eight output
checksums matched; its mobile-bias2 median exceeded the timing allowance, so it
is retained as a failed measurement. After the full suite finished, the
sequential main/candidate recheck passed the unchanged allowances in all eight
scenarios. Its mobile-bias2 median was 11.864 ms. This measures Node CPU work,
without a GL context or a device FPS claim.

## Browser and visual limitations

Both `tools/settings-smoke.mjs` and `tools/camera-studio-smoke.mjs` were attempted
with `/usr/bin/chromium` (156.0.8078.79). Chromium aborted before opening a page:
`process_singleton_posix.cc: socket() failed: Operation not permitted`.
Responsive layout, native modal/keyboard/touch interaction, real H.264/AAC
encoding and actual in-browser zoom restoration remain unverified here. No
screenshots, artistic approval or new visual baseline is claimed. DOM checks
establish structure and interaction semantics, without layout or rendering.

Updated browser probes cover wheel-zoom restoration after cancellation and
completion, all three viewport sizes, the Engineering disclosure, grouped
editor navigation, shared URLs, and reset/reload. Run on a browser-capable host:

```sh
npm run test:settings -- --playback
node tools/camera-studio-smoke.mjs .smoke/settings-zoom-browser
npm run lint
npm test
npm run check:modules -- --tracked
npm run stage:site
```

Evidence logs, the standalone jsdom harness and reports, failed attempts and
matched CPU benchmark reports remain under ignored `.smoke/`. Independent code
review found no outstanding code findings after correcting reset/save,
navigation and normalization edge cases. No merge or deployment was performed.
