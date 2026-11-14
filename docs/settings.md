# Settings

One registry defines every user-adjustable or URL-overridable behaviour of
the app page. The settings panel, URL overrides and programmatic/test
configuration all resolve through it. The [URL parameter reference](url-parameters.md)
is generated from it; the [audit](settings-audit.md) records what existed
before it and where each mechanism went.

## For players

- **Where:** the title screen's **Settings** disclosure, and the **Settings**
  button in the playback HUD (the same panel, in a dialog; the music keeps
  playing). A jump bar moves between sections: Appearance, Camera, Landscape,
  Performance, Audio & playback, Experiments, Diagnostics.
- **Ordinary, advanced, experimental:** each section shows its everyday
  settings. *Advanced …* disclosures hold finer controls. Experimental and
  diagnostic settings live only under **Experiments**, behind a labelled
  disclosure, each with an *Experimental* or *Diagnostic* badge.
- **When a change applies** is shown on every setting that is not immediate:
  *Next landscape*, *Next song*, *Scene rebuild* (the scene is rebuilt in
  place: the song holds its place for a moment and resumes, it does not
  restart), *Renderer restart* (the 3D landscape renderer is recreated the
  same way; during playback this waits for **Apply now**), or *Reload*
  (offered as **Reload page**, which stops the song). A bar at the
  top lists changes waiting to apply.
- **Unavailable settings** are disabled with the reason (for example, 3D-only
  settings while the painted renderer is selected, or the compiled-terrain
  pilot when its packs are not on the site). Parameters with no effect in the
  current product (`rangeMsaa` under the Cinematic look) are not offered.
- **Reset:** each changed setting has ↺; Diagnostics has *Reset all settings*.
- **Diagnostics:** what is running (renderer requested vs running, fallback
  reason, active view, quality level and ceiling, pixel grid, antialiasing
  actually used, compiled-terrain results), every setting that differs from its
  default and where its value came from, rejected/ignored/unknown URL
  parameters, *Copy configuration*, *Copy share link*, and the graphics report.

## Precedence and persistence

Effective value = **URL override → saved preference → default**, resolved once
when the page loads (`appSettings()` in `src/config/appSettings.js`).

| `persist` | Stored in | Used for |
| --- | --- | --- |
| `saved` | `localStorage` (the setting's adapter) | ordinary preferences |
| `url` | the address bar only | diagnostics and review aids, so a reload or shared link reproduces them without leaking into later visits |
| `none` | memory | automation contracts |

- A URL override applies for the visit, is badged *From page address*, and
  is listed in a banner. It is **never saved implicitly**; *Save as my
  settings* saves the `saved`-policy ones and removes them from the address.
- Changing a setting in the panel saves it and removes a URL parameter it
  supersedes (history.replaceState), so the saved value decides on reload.
- An invalid URL value is rejected, reported in Diagnostics and falls through
  to the saved/default value — except where a parameter's historical rule gives
  it its own fallback (`urlNote` in the registry; e.g. `?rangePace=9` still
  means the default pace, `?canopySummary=x` still means the reference path).
- Existing keys are kept, so earlier saved choices carry over: display record
  (`midio-pixel:display:v1`, migrating `smw:display:v1/v2` and `smw:stageRes`),
  `midio-pixel:render-quality:v1` (migrating Economy → Low), `smw:stageFps`,
  `range-pace`, `range-tour`, `midio.playback.v1`, `smw:noLyrics`,
  `smw:btLatencyTrimMs` (migrating `smw:btLatencyTrim`). Settings that had no
  storage share `midio-pixel:settings:v1`.

## Architecture

```
settingsRegistry.js  definitions + pure resolve/parse/format/share
        │
appSettings.js       SettingsStore: values, sources, pending, guards, listeners
        │                    │                         │
SettingsPanel.js     subsystem adapters           main.js applySettingChange
(generated UI)       (msaaOverride(), …)          (lifecycle → running app)
```

- **Definitions** (`SETTINGS`): `id`, `url`, `label`, `description`,
  `section`/`group`, `tier` (basic/advanced/experimental/developer),
  `maturity` (stable/experimental/diagnostic), `type` with `options` or
  `min`/`max`/`step`/`nullable`/`pattern`, `default`, `persist`, `storage`
  adapter, `lifecycle`, `requires` (dependencies/conflicts with reasons),
  `couples` (settings changed together), `availability` (a lazy capability
  probe), `ui: false` (URL-only), `share: false`, `control`/`controlId`/
  `statusId` for the panel, `parseUrl` + `urlNote` for historical URL rules.
- **Store** (`SettingsStore`): `get(id)` is a property read, safe in frame
  loops; nothing parses the URL or touches storage after construction except
  `set`/`reset`/`saveUrlOverrides`. `set` validates, runs guards (e.g. no
  display change while snapshots are saved), persists by policy, applies
  couplings, marks a change *pending* when its lifecycle cannot apply now, and
  notifies listeners once per change. `describe()` and `explainSetting()`
  report requested vs effective values and why.
- **Subsystems** read through the store. Historical parser functions keep their
  signatures as adapters: with no argument they read the page store; with an
  explicit search string that string alone decides, as before (tests and tools
  rely on this). `test/settingsRegistry.test.mjs` fails if application code
  under `src/` parses `location.search` itself (dev review pages and the
  history shell excepted).
- **Lifecycle in main.js:** `SETTING_APPLIERS` handle live settings.
  Renderer-lifecycle settings recreate the landscape presentation
  (`recreateLandscapePresentation`, then the one in-place rebuild
  `rebuildSceneInPlace`): immediately on the title screen, on **Apply now**
  during playback, or at the next song. The rebuild holds the song (audio
  and drawing) at its heard position until the replacement scene can draw,
  keeping the last frame on screen; the audio engine, seed, camera run and the
  heard tour continuation (captured before the old presentation is disposed)
  carry over. Constructor-time reads (RangeScene
  shader flags, RangePresentation tour options, the land-dance memory
  admission) therefore see the new value without a reload. The voxel pilot is
  constructed with the page, so it is the one *Reload* setting.

## Adding a setting

1. Add a definition to `SETTINGS` in `src/config/settingsRegistry.js`. Pick
   the honest `lifecycle` for where the value is read, a `tier`, a `maturity`,
   `requires` for anything it depends on, and `persist`.
2. Read it with `settingValue('id')` (or `appSettings().get('id')`) where the
   subsystem needs it. Do not parse `location.search` or touch `localStorage`
   for it.
3. If it is `live`, add an applier to `SETTING_APPLIERS` in `src/main.js`. A
   `renderer` setting needs nothing more if its consumer reads it when the
   presentation or scene is constructed.
4. Run `npm run settings:reference` to regenerate `docs/url-parameters.md`,
   and add cases to `test/settingsRegistry.test.mjs` for any special URL rule.

Ordinary boolean, enum, number and text settings appear in the panel
automatically. A feature is not complete while its only control is an
undocumented query parameter (see AGENTS.md).

## Custom controls

```js
import { registerSettingControl } from './ui/SettingsPanel.js';
registerSettingControl('myControl', (def, { doc, id, options }) => {
  const input = doc.createElement('input');
  input.id = id;
  return { element: input, input, read: () => input.value, write: v => { input.value = v; },
    setDisabled: d => { input.disabled = d; } /* event: 'input', labelled: true, extraInputs */ };
});
```

Then set `control: 'myControl'` on the definition. Built-in kinds: `checkbox`,
`select`, `slider` (enum on a range input), `range`, `number`, `text`,
`pressButton` (aria-pressed toggle), `tour` (Camera tours checkbox + kind).

## Testing

- `test/settingsRegistry.test.mjs` — definitions, defaults, constraints,
  historical URL rules, precedence, migration, dependencies, store persistence
  and URL clean-up, couplings, guards, pending lifecycles, share links,
  diagnostics, the generated reference and the no-direct-parsing rule.
- Existing parser tests (e.g. `test/rangePresentation.test.js`,
  `test/compiledTerrain.test.mjs`, `test/forestCanopySummary.test.mjs`) keep
  testing each adapter with explicit search strings: URL compatibility.
- `test/pixelDisplayControls.test.js`, `test/qualityControlsWiring.test.js` —
  production appliers driven through a real store.
- `npm run test:settings -- [--playback]` (`tools/settings-smoke.mjs`, in CI
  browser-smoke) — real Chromium at desktop 1440×900, phone 390×844 (touch,
  DPR 2) and head unit 800×480 (Android UA): sections and controls visible,
  override badges and banner, rejected/retired/unknown reporting, disabled
  reasons, ≥36 px targets, no horizontal overflow, keyboard section jumps,
  persistence across reload, reset, saving overrides, share links, the
  experiments disclosure; with `--playback`, live frame-rate/grid changes and a
  renderer restart mid-song keeping the audio engine, seed and clock. With
  `--v2` (local GPU; `SETTINGS_SMOKE_GL=swiftshader` for software GL), a 3D
  landscape renderer restart mid-song: the screen never blanks, presentation
  resumes, the new scene draws the changed setting, audio/seed/camera
  high-water carry over, and repeated restarts leave no context loss.
  Emulation only: not a device test.
