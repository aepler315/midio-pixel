// The settings panel: generated from the registry (src/config/settingsRegistry.js)
// into the title screen's Settings disclosure, which main.js moves into the
// Display dialog during playback. Every definition with a section and
// `ui !== false` appears here without hand-written markup; definitions may
// name a registered control (`control`) and a legacy element id
// (`controlId`) that existing tools and tests drive.
//
// All basic controls stay rendered and visible when the disclosure is open
// (sections are stacked, not tabbed) so keyboard, screen-reader and
// automation users reach them the same way. Advanced, experimental and
// diagnostic controls sit behind labelled disclosures.
import { SECTIONS, SETTINGS, LIFECYCLES, defaultValue } from '../config/settingsRegistry.js';
import { explainSetting } from '../config/appSettings.js';

const controls = new Map();

/**
 * Register a control kind. `factory(def, ctx)` returns
 * { element, input, read(): value, write(value), setDisabled(bool) }.
 * `input` is the focusable element the row's label points at.
 */
export function registerSettingControl(name, factory) { controls.set(name, factory); }

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

const optionKey = value => (value === null ? '' : String(value));

registerSettingControl('checkbox', (def, { doc, id }) => {
  const input = el(doc, 'input', { type: 'checkbox', id });
  return { element: input, input, read: () => input.checked, write: v => { input.checked = !!v; }, setDisabled: d => { input.disabled = d; } };
});

registerSettingControl('select', (def, { doc, id, options }) => {
  const input = el(doc, 'select', { id });
  let current = options;
  const fill = list => {
    current = list;
    input.replaceChildren(...list.map(o => el(doc, 'option', { value: optionKey(o.value), text: o.label })));
  };
  fill(options);
  return {
    element: input, input,
    read: () => current.find(o => optionKey(o.value) === input.value)?.value,
    write: v => {
      if (!current.some(o => optionKey(o.value) === optionKey(v))) fill([...current, { value: v, label: String(v) }]);
      input.value = optionKey(v);
    },
    setDisabled: d => { input.disabled = d; },
    setOptions: fill,
  };
});

/** An enum as discrete steps on a range input (General quality). */
registerSettingControl('slider', (def, { doc, id }) => {
  const input = el(doc, 'input', { type: 'range', id, min: 0, max: def.options.length - 1, step: 1 });
  const out = el(doc, 'output', { for: id, id: `${id}Value` });
  const ticks = el(doc, 'div', { className: 'qualityTicks', 'aria-hidden': 'true' }, def.options.map(o => el(doc, 'span', { text: o.label })));
  const element = el(doc, 'div', { className: 'settingSlider' }, [input, ticks]);
  const write = v => {
    const i = Math.max(0, def.options.findIndex(o => o.value === v));
    input.value = String(i);
    out.textContent = def.options[i].label;
    input.setAttribute('aria-valuetext', def.options[i].label);
  };
  input.addEventListener('input', () => write(def.options[Number(input.value)]?.value));
  return { element, input, output: out, read: () => def.options[Number(input.value)]?.value, write, setDisabled: d => { input.disabled = d; }, event: 'input' };
});

registerSettingControl('range', (def, { doc, id }) => {
  const input = el(doc, 'input', { type: 'range', id, min: def.min, max: def.max, step: def.step || 'any' });
  const out = el(doc, 'output', { for: id });
  const element = el(doc, 'div', { className: 'settingSlider settingRange' }, [input, out]);
  const write = v => { input.value = String(v); out.textContent = Number(v).toFixed(2).replace(/\.?0+$/, ''); };
  input.addEventListener('input', () => { out.textContent = Number(input.value).toFixed(2).replace(/\.?0+$/, ''); });
  return { element, input, read: () => Number(input.value), write, setDisabled: d => { input.disabled = d; }, event: 'change' };
});

registerSettingControl('number', (def, { doc, id }) => {
  const input = el(doc, 'input', { type: 'number', id, min: def.min, max: def.max, step: def.step || 'any', inputmode: 'decimal',
    placeholder: def.nullable ? 'automatic' : null });
  return {
    element: input, input,
    read: () => (input.value === '' && def.nullable ? null : Number(input.value)),
    write: v => { input.value = v == null ? '' : String(v); },
    setDisabled: d => { input.disabled = d; },
  };
});

registerSettingControl('text', (def, { doc, id }) => {
  const input = el(doc, 'input', { type: 'text', id, spellcheck: 'false', autocomplete: 'off', placeholder: def.nullable ? 'automatic' : null });
  return { element: input, input, read: () => (input.value.trim() === '' && def.nullable ? null : input.value.trim()), write: v => { input.value = v ?? ''; }, setDisabled: d => { input.disabled = d; } };
});

/** A toggle button with aria-pressed (Timed lyric grounding keeps the
 *  button tools have always driven). */
registerSettingControl('pressButton', (def, { doc, id }) => {
  let value = false;
  const input = el(doc, 'button', { type: 'button', id, className: 'ghostbtn chipbtn', 'aria-pressed': 'false' });
  const write = v => { value = !!v; input.setAttribute('aria-pressed', value ? 'true' : 'false'); input.textContent = `${def.label}: ${value ? 'on' : 'off'}`; };
  return { element: input, input, read: () => !value, write, setDisabled: d => { input.disabled = d; }, event: 'click', labelled: true };
});

/** Camera tours: the on/off checkbox tools drive, plus which tour. */
registerSettingControl('tour', (def, { doc, id }) => {
  const box = el(doc, 'input', { type: 'checkbox', id });
  const kind = el(doc, 'select', { id: `${id}-kind`, 'aria-label': 'Which camera tour' },
    def.options.filter(o => o.value !== 'off').map(o => el(doc, 'option', { value: o.value, text: o.label })));
  const element = el(doc, 'span', { className: 'settingTour' }, [el(doc, 'label', { className: 'settingCheck' }, [box, ' Camera tours']), kind]);
  return {
    element, input: box, labelled: true,
    read: () => (box.checked ? kind.value : 'off'),
    write: v => { box.checked = v !== 'off'; if (v !== 'off') kind.value = v; kind.disabled = box.disabled || !box.checked; },
    setDisabled: d => { box.disabled = d; kind.disabled = d || !box.checked; },
    extraInputs: [kind],
  };
});

function controlKind(def) {
  if (def.control) return def.control;
  if (def.type === 'boolean') return 'checkbox';
  if (def.type === 'enum') return 'select';
  if (def.type === 'number') return def.nullable || def.max - def.min > 10 ? 'number' : 'range';
  return def.optionsSource ? 'select' : 'text';
}

function formatValue(def, value) {
  if (value === null || value === undefined) return 'automatic';
  if (def.options) return def.options.find(o => o.value === value)?.label ?? String(value);
  if (def.type === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

const SOURCE_LABEL = { url: 'page address', saved: 'your settings', default: 'default', user: 'this session', session: 'this session' };

/**
 * Mount the panel into `root`.
 *  store        the SettingsStore
 *  optionSources  { name: () => [{ value, label }] } for string settings
 *  availability   { name: () => Promise<{ supported, reason }> }
 *  blocked(id)    a temporary reason a control cannot change now, or null
 *  runtime()      live engine facts for the diagnostics view
 *  actions        { applyPending(), reload(), copy(text) -> Promise<bool> }
 */
export function mountSettingsPanel(root, { store, optionSources = {}, availability = {}, blocked = () => null, runtime = () => ({}), actions = {} } = {}) {
  const doc = root.ownerDocument;
  const rows = new Map();
  const availabilityResults = new Map();

  const pendingBar = el(doc, 'div', { className: 'settingsPending', role: 'status', 'aria-live': 'polite', hidden: true });
  const overrideBar = el(doc, 'div', { className: 'settingsOverrides', hidden: true });
  const nav = el(doc, 'nav', { className: 'settingsNav', 'aria-label': 'Settings sections' });
  root.replaceChildren(pendingBar, overrideBar, nav);

  const visible = SETTINGS.filter(def => def.ui !== false && def.section);
  for (const section of SECTIONS) {
    const defs = visible.filter(def => def.section === section.id);
    if (!defs.length) continue;
    const sectionId = `settings-${section.id}`;
    const heading = el(doc, 'h3', { id: `${sectionId}-title`, text: section.label });
    const node = el(doc, 'section', { id: sectionId, className: 'settingsSection', 'aria-labelledby': heading.id, dataset: { section: section.id } },
      [heading, el(doc, 'p', { className: 'hint settingsSectionHint', text: section.description })]);
    const jump = el(doc, 'button', { type: 'button', className: 'ghostbtn chipbtn', 'aria-controls': sectionId, text: section.label });
    jump.addEventListener('click', () => {
      if (section.id === 'experiments') node.querySelector('details')?.setAttribute('open', '');
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    });
    nav.append(jump);

    if (section.id === 'experiments') {
      node.append(el(doc, 'p', { className: 'settingsWarning', text: 'Experimental and diagnostic settings can change how the landscape looks or performs, and some are comparisons for engineering review. They are labelled where they apply.' }));
      const box = el(doc, 'details', { className: 'settingsAdvanced settingsExperiments' }, [el(doc, 'summary', { text: `Show experimental and diagnostic settings (${defs.length})` })]);
      for (const group of [...new Set(defs.map(d => d.group))]) {
        box.append(el(doc, 'h4', { className: 'settingsGroup', text: group }));
        for (const def of defs.filter(d => d.group === group)) box.append(buildRow(def));
      }
      box.addEventListener('toggle', () => { if (box.open) probeAvailability(); });
      node.append(box);
    } else {
      for (const def of defs.filter(d => d.tier === 'basic')) node.append(buildRow(def));
      const advanced = defs.filter(d => d.tier !== 'basic');
      if (advanced.length) {
        const box = el(doc, 'details', { className: 'settingsAdvanced' }, [el(doc, 'summary', { text: `Advanced ${section.label.toLowerCase()} (${advanced.length})` })]);
        for (const def of advanced) box.append(buildRow(def));
        node.append(box);
      }
    }
    root.append(node);
  }

  const diagnostics = buildDiagnostics();
  root.append(diagnostics.element);
  const diagJump = el(doc, 'button', { type: 'button', className: 'ghostbtn chipbtn', 'aria-controls': diagnostics.element.id, text: 'Diagnostics' });
  diagJump.addEventListener('click', () => { diagnostics.element.open = true; diagnostics.element.scrollIntoView({ block: 'start', behavior: 'smooth' }); diagnostics.element.querySelector('summary')?.focus({ preventScroll: true }); });
  nav.append(diagJump);

  function buildRow(def) {
    const id = def.controlId || `setting-${def.id}`;
    const options = def.options || (def.optionsSource ? [{ value: null, label: 'Automatic (the song decides)' }, ...(optionSources[def.optionsSource]?.() || [])] : null);
    const kind = controlKind(def);
    const factory = controls.get(kind) || controls.get('text');
    const control = factory(def, { doc, id, options });
    const descId = `${id}-desc`;
    control.input.setAttribute('aria-describedby', [descId, def.statusId].filter(Boolean).join(' '));
    const badges = el(doc, 'span', { className: 'settingBadges' });
    const reset = el(doc, 'button', { type: 'button', className: 'ghostbtn iconbtn settingReset', 'aria-label': `Reset ${def.label} to default`, title: 'Reset to default', text: '↺', hidden: true });
    const note = el(doc, 'p', { className: 'settingNote', role: 'note', hidden: true });
    const label = control.labelled ? null
      : kind === 'checkbox' ? el(doc, 'label', { className: 'settingCheck' }, [control.element, ` ${def.label}`])
        : el(doc, 'label', { for: id, text: def.label });
    const main = el(doc, 'div', { className: 'settingMain' }, [
      label, kind === 'checkbox' ? null : control.element, badges, reset,
    ]);
    const desc = el(doc, 'p', { className: 'hint settingDesc', id: def.statusId === 'range-tour-status' ? 'range-tour-description' : descId },
      [def.description, def.statusId ? el(doc, 'span', { id: def.statusId, role: 'status', 'aria-live': 'polite', className: 'settingStatus' }) : null]);
    if (desc.id !== descId) control.input.setAttribute('aria-describedby', [desc.id, def.statusId].filter(Boolean).join(' '));
    const row = el(doc, 'div', { className: 'settingRow', dataset: { setting: def.id, tier: def.tier, maturity: def.maturity, lifecycle: def.lifecycle } }, [main, desc, note]);

    const commit = () => {
      const value = control.read();
      const result = store.set(def.id, value, { origin: 'user' });
      if (!result.ok) { control.write(store.get(def.id)); showNote(row, result.reason); }
      sync();
    };
    for (const input of [control.input, ...(control.extraInputs || [])]) input.addEventListener(input === control.input ? (control.event || 'change') : 'change', commit);
    reset.addEventListener('click', () => { store.reset(def.id); sync(); control.input.focus(); });
    rows.set(def.id, { def, control, row, badges, reset, note, kind });
    return row;
  }

  function showNote(row, text) {
    const n = row.querySelector('.settingNote');
    n.textContent = text; n.hidden = !text;
  }

  function badge(text, kind, title) { return el(doc, 'span', { className: `settingBadge settingBadge--${kind}`, text, title }); }

  function syncRow(id) {
    const r = rows.get(id);
    if (!r) return;
    const { def, control, row, badges, reset } = r;
    const e = store.entry(id);
    const value = store.get(id);
    const reason = store.disabledReason(id) || blocked(id) || unavailableReason(def, value);
    control.write(value);
    control.setDisabled(!!reason);
    const pending = store.pending.get(id);
    const items = [];
    if (def.maturity === 'experimental') items.push(badge('Experimental', 'experimental'));
    if (def.maturity === 'diagnostic') items.push(badge('Diagnostic', 'diagnostic'));
    if (e.source === 'url') items.push(badge('From page address', 'url', `Set by ?${def.url}=${e.requested ?? ''} in the address. Not saved unless you choose to.`));
    if (def.lifecycle !== 'live') items.push(badge(LIFECYCLES[def.lifecycle].short, 'lifecycle', LIFECYCLES[def.lifecycle].label));
    if (pending) items.push(badge('Waiting to apply', 'pending', LIFECYCLES[pending.lifecycle].label));
    badges.replaceChildren(...items);
    reset.hidden = Object.is(value, defaultValue(def)) && e.source !== 'url';
    const notes = [];
    if (reason) notes.push(reason);
    if (e.rejected) notes.push(`The address asked for "${e.rejected.raw}", which was not used: ${e.rejected.reason}.`);
    showNote(row, notes.join(' '));
    row.dataset.state = reason ? 'disabled' : pending ? 'pending' : e.source;
  }

  function unavailableReason(def, value) {
    if (!def.availability) return null;
    const result = availabilityResults.get(def.availability);
    // Keep a requested experiment selectable so it can be turned back off.
    if (!result || result.supported || value !== defaultValue(def)) return null;
    return result.reason;
  }

  let probed = false;
  function probeAvailability() {
    if (probed) return;
    probed = true;
    for (const def of visible) {
      if (!def.availability || !availability[def.availability] || availabilityResults.has(def.availability)) continue;
      availabilityResults.set(def.availability, null);
      Promise.resolve(availability[def.availability]()).then(result => {
        availabilityResults.set(def.availability, result);
        sync();
      }).catch(() => availabilityResults.delete(def.availability));
    }
  }

  function syncBars() {
    const pending = [...store.pending];
    if (pending.length) {
      const needsReload = pending.some(([, p]) => p.lifecycle === 'reload');
      const restart = pending.some(([, p]) => p.lifecycle === 'renderer' || p.lifecycle === 'scene');
      const names = pending.map(([id]) => rows.get(id)?.def.label || id).join(', ');
      const children = [el(doc, 'span', { text: `Waiting to apply: ${names}. ${needsReload ? 'A reload stops the song.' : restart ? 'Applying rebuilds the landscape: the song holds its place briefly and resumes.' : 'These apply when the next song starts.'}` })];
      if (restart && actions.applyPending) {
        const b = el(doc, 'button', { type: 'button', className: 'ghostbtn chipbtn', text: 'Apply now' });
        b.addEventListener('click', () => { actions.applyPending(); sync(); });
        children.push(b);
      }
      if (needsReload && actions.reload) {
        const b = el(doc, 'button', { type: 'button', className: 'ghostbtn chipbtn', text: 'Reload page' });
        b.addEventListener('click', () => actions.reload());
        children.push(b);
      }
      pendingBar.replaceChildren(...children);
    }
    pendingBar.hidden = !pending.length;
    const overrides = store.overrides().filter(id => rows.has(id));
    if (overrides.length) {
      const saveable = overrides.filter(id => rows.get(id).def.persist === 'saved');
      const text = el(doc, 'span', { text: `${overrides.length} setting${overrides.length > 1 ? 's come' : ' comes'} from this page's address (${overrides.map(id => rows.get(id).def.label).join(', ')}). ${saveable.length ? 'They last only for this visit unless you save them.' : 'They last only for this visit.'}` });
      const children = [text];
      if (saveable.length) {
        const save = el(doc, 'button', { type: 'button', className: 'ghostbtn chipbtn', text: 'Save as my settings' });
        save.addEventListener('click', () => { store.saveUrlOverrides(); sync(); });
        children.push(save);
      }
      overrideBar.replaceChildren(...children);
    }
    overrideBar.hidden = !overrides.length;
  }

  function buildDiagnostics() {
    // Keeps the id tools and the graphics report have always used.
    const details = el(doc, 'details', { id: 'graphicsTroubleshooting', className: 'settingsDiagnostics' });
    const summary = el(doc, 'summary', { text: 'Diagnostics and graphics report' });
    const engine = el(doc, 'dl', { className: 'settingsFacts' });
    const changed = el(doc, 'table', { className: 'settingsTable' });
    const params = el(doc, 'div', { className: 'settingsParams' });
    const status = el(doc, 'p', { className: 'hint', role: 'status', id: 'settingsCopyStatus' });
    const copyConfig = el(doc, 'button', { type: 'button', className: 'ghostbtn', id: 'copySettingsConfig', text: 'Copy configuration' });
    const copyLink = el(doc, 'button', { type: 'button', className: 'ghostbtn', id: 'copySettingsLink', text: 'Copy share link' });
    const resetAll = el(doc, 'button', { type: 'button', className: 'ghostbtn', id: 'resetAllSettings', text: 'Reset all settings' });
    const link = el(doc, 'input', { type: 'text', readonly: true, className: 'settingsLink', 'aria-label': 'Share link', hidden: true });
    const copy = async (text, what) => {
      const ok = await actions.copy?.(text).catch(() => false);
      status.textContent = ok ? `${what} copied.` : `Select and copy the ${what.toLowerCase()} below.`;
      if (!ok) { link.hidden = false; link.value = text; link.select(); }
    };
    copyConfig.addEventListener('click', () => copy(JSON.stringify({ ...store.describe(), runtime: runtime() }, null, 2), 'Configuration'));
    copyLink.addEventListener('click', () => { const href = store.shareUrl(); link.hidden = false; link.value = href; copy(href, 'Share link'); });
    let armed = false;
    resetAll.addEventListener('click', () => {
      if (!armed) { armed = true; resetAll.textContent = 'Confirm: reset every setting'; return; }
      armed = false; resetAll.textContent = 'Reset all settings';
      store.resetAll(); sync(); status.textContent = 'Every setting is back to its default.';
    });
    // The graphics report controls (bound in main.js).
    const report = [
      el(doc, 'h4', { className: 'settingsGroup', text: 'Graphics report' }),
      el(doc, 'p', { className: 'hint', text: 'If the 3D scenery never appears, copy a report of the graphics state. Audio, filenames and lyrics are excluded.' }),
      el(doc, 'button', { id: 'copyGraphicsReport', className: 'ghostbtn', type: 'button', text: 'Copy graphics report' }),
      el(doc, 'p', { id: 'graphicsReportStatus', className: 'hint', role: 'status' }),
      el(doc, 'textarea', { id: 'graphicsReport', hidden: true, readonly: true, rows: 12, 'aria-label': 'Graphics report' }),
    ];
    details.append(summary,
      el(doc, 'h4', { className: 'settingsGroup', text: 'Engine' }), engine,
      el(doc, 'h4', { className: 'settingsGroup', text: 'Settings that differ from the default' }), changed,
      params,
      el(doc, 'div', { className: 'settingsActions' }, [copyConfig, copyLink, resetAll]), link, status, ...report);
    details.addEventListener('toggle', () => { if (details.open) refreshDiagnostics(); });
    // Render before the disclosure opens (toggle fires a task later), so the
    // page does not grow under someone who scrolls right after opening it.
    summary.addEventListener('click', () => refreshDiagnostics(true));

    function refreshDiagnostics(force = false) {
      if (!details.open && !force) return;
      const facts = runtime() || {};
      engine.replaceChildren(...Object.entries(facts).filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [el(doc, 'dt', { text: k }), el(doc, 'dd', { text: String(v) })]));
      const rowsOut = [];
      for (const def of SETTINGS) {
        const x = explainSetting(def.id, store);
        if (x.source === 'default' && !x.pending && !x.rejected && Object.is(x.value, x.default)) continue;
        rowsOut.push(el(doc, 'tr', {}, [
          el(doc, 'th', { scope: 'row', text: def.label }),
          el(doc, 'td', { text: formatValue(def, x.value) }),
          el(doc, 'td', { text: `${SOURCE_LABEL[x.source] || x.source}${x.pending ? ` · waiting (${x.pending})` : ''}${x.disabled ? ' · inactive' : ''}` }),
        ]));
      }
      changed.replaceChildren(el(doc, 'thead', {}, el(doc, 'tr', {}, [el(doc, 'th', { scope: 'col', text: 'Setting' }), el(doc, 'th', { scope: 'col', text: 'Value' }), el(doc, 'th', { scope: 'col', text: 'Source' })])),
        el(doc, 'tbody', {}, rowsOut.length ? rowsOut : el(doc, 'tr', {}, el(doc, 'td', { colspan: 3, text: 'Everything is at its default.' }))));
      const d = store.describe();
      const lines = [
        ...d.settings.filter(s => s.rejected).map(s => `Rejected ?${SETTINGS.find(x => x.id === s.id).url}=${s.rejected.raw}: ${s.rejected.reason}.`),
        ...d.retiredParams.map(p => `Ignored ?${p.param}: ${p.reason}`),
        ...d.unknownParams.map(p => `Unknown ?${p.param} (not read by the app).`),
        ...d.settings.filter(s => s.disabled && s.source !== 'default').map(s => `${SETTINGS.find(x => x.id === s.id).label} is set but inactive: ${s.disabled}`),
      ];
      params.replaceChildren(...lines.map(text => el(doc, 'p', { className: 'hint settingsParamNote', text })));
    }
    return { element: details, refresh: refreshDiagnostics };
  }

  function sync() {
    for (const id of rows.keys()) syncRow(id);
    syncBars();
    diagnostics.refresh();
  }

  const unsubscribe = store.subscribe(sync);
  sync();
  return {
    sync, syncRow, refreshDiagnostics: diagnostics.refresh,
    setOptions(source) {
      for (const { def, control } of rows.values()) {
        if (def.optionsSource !== source || !control.setOptions) continue;
        control.setOptions([{ value: null, label: 'Automatic (the song decides)' }, ...(optionSources[source]?.() || [])]);
        syncRow(def.id);
      }
    },
    destroy: unsubscribe,
  };
}
