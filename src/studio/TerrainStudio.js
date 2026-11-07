import { ReviewSession, PreviewCache, previewUrl, previewForMode, candidateKindLabel, candidateBiome } from '../dev/view-discovery/review-state.js';
import { CAMERA_FIELDS, CAMERA_PRESETS, defaultCamera, randomizeCamera, improveCamera, analyzeCamera } from './CameraEditor.js';
import { StudioProjects } from './StudioProjects.js';

const REVIEW_KEY = 'midio.view-discovery.review.v1';
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const CATALOG_URL = new URL('../assets/view-discovery/catalog.json', import.meta.url);
let activeStudio = null;
let openingStudio = null;

const icons = {
  mountain: '<svg viewBox="0 0 32 26" fill="none" aria-hidden="true"><path d="m2 23 9-16 5 8 5-12 9 20H2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m8 12 3 3 3-3m4-2 3 3 3-3" stroke="currentColor" stroke-width="1.3"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5"/></svg>',
  shuffle: '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2 4h2c4 0 6 10 10 10h2m-3-3 3 3-3 3M2 14h2c1.5 0 3-2 4-4m2-3c1-2 2.5-3 4-3h2m-3-3 3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function styleOnce() {
  if (document.querySelector('link[data-terrain-studio]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('./studio.css', import.meta.url).href;
  link.dataset.terrainStudio = ''; document.head.append(link);
}

function download(value, filename) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function messageOf(value) {
  return typeof value === 'string' ? value : value?.message || value?.summary || value?.label || '';
}

/** The authoring surface is lazy-loaded; opening it never changes playback. */
export async function openTerrainStudio(options = {}) {
  if (activeStudio) { activeStudio.focus(); return activeStudio; }
  if (openingStudio) return openingStudio;
  openingStudio = createStudio(options);
  try { return await openingStudio; } finally { openingStudio = null; }
}

async function createStudio({ onUse = async () => {}, onClose = () => {} } = {}) {
  styleOnce();
  const response = await fetch(CATALOG_URL, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Terrain collection could not load (HTTP ${response.status}).`);
  const catalog = await response.json();
  let storedReview = null, storage = null;
  try { storage = localStorage; storedReview = storage.getItem(REVIEW_KEY); } catch { /* Export remains available. */ }
  const session = new ReviewSession(catalog, storedReview);
  const projects = new StudioProjects({ storage, candidates: session.candidates });
  projects.load();
  const cache = new PreviewCache();
  const priorFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog';
  dialog.setAttribute('aria-labelledby', 'studio-title');
  dialog.setAttribute('aria-describedby', 'studio-description');
  dialog.innerHTML = `
    <div class="studio-shell">
      <header class="studio-header">
        <div class="studio-brand"><span class="studio-mark">${icons.mountain}</span><div><h1 id="studio-title">Terrain <strong>Studio</strong><span class="studio-lab">LAB</span></h1><p id="studio-description">Find a place. Make it move.</p></div></div>
        <div class="studio-header-actions"><span class="studio-save-state" data-el="save-state">Saved locally</span><button type="button" class="studio-button studio-quiet" data-action="compact" aria-pressed="false" title="Larger viewport with compact controls">Compact view</button><button type="button" class="studio-icon-button studio-close" data-action="close" aria-label="Close Terrain Studio">${icons.close}</button></div>
      </header>
      <nav class="studio-mobile-tabs" aria-label="Studio panels"><button type="button" data-panel="explore" aria-pressed="true">Explore</button><button type="button" data-panel="camera" aria-pressed="false">Camera</button><button type="button" data-panel="review" aria-pressed="false">Review</button></nav>
      <div class="studio-workspace" data-mobile-panel="explore">
        <aside class="studio-explorer" aria-label="Discover terrain views">
          <div class="studio-panel-heading"><h2>Discover</h2><span class="studio-count" data-el="total-count"></span></div>
          <label class="studio-search"><span class="studio-sr-only">Search views, regions or landmarks</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5"/></svg><input data-el="search" type="search" maxlength="300" placeholder="Search places…" autocomplete="off"></label>
          <div class="studio-filter-row"><label><span class="studio-sr-only">Region</span><select data-el="region"><option value="">All regions</option></select></label><label><span class="studio-sr-only">Review status</span><select data-el="status"><option value="all">All views</option><option value="unreviewed">Unreviewed</option><option value="keep">Kept</option><option value="maybe">Maybe</option><option value="pass">Passed</option></select></label></div>
          <div class="studio-list-meta"><span data-el="selection-count"></span><button type="button" data-action="surprise" class="studio-text-button">${icons.shuffle} Surprise me</button></div>
          <div class="studio-candidate-list" data-el="candidate-list" aria-label="Views in selection"></div>
          <p class="studio-list-note" data-el="list-note"></p>
          <div class="studio-library-footer"><span class="studio-dot"></span><span data-el="review-count"></span><button type="button" class="studio-text-button" data-action="review-undo" title="Undo last review decision">Undo</button></div>
        </aside>
        <main class="studio-main">
          <div class="studio-view-heading"><div class="studio-view-copy"><p class="studio-eyebrow" data-el="view-kind">LANDSCAPE EXPLORER</p><h2 data-el="view-name">Loading terrain…</h2><p data-el="view-region" class="studio-location"></p></div><div class="studio-view-navigation"><button type="button" class="studio-icon-button studio-prev" data-action="previous" aria-label="Previous view">${icons.chevron}</button><span data-el="position"></span><button type="button" class="studio-icon-button" data-action="next" aria-label="Next view">${icons.chevron}</button></div></div>
          <div class="studio-viewport" data-el="viewport" aria-busy="false">
            <img data-el="still" class="studio-still" alt="" hidden>
            <canvas data-el="canvas" class="studio-canvas" width="640" height="360" aria-label="Interactive terrain camera preview" hidden></canvas>
            <div class="studio-preview-empty" data-el="empty"><span>${icons.mountain}</span><p data-el="preview-message">Loading the original landscape…</p></div>
            <div class="studio-viewport-top"><span class="studio-preview-badge" data-el="preview-badge">ORIGINAL STILL</span><div class="studio-segmented" aria-label="Terrain display"><button type="button" data-mode="landscape" aria-pressed="true">Landscape</button><button type="button" data-mode="shape" aria-pressed="false">Shape</button></div></div>
            <div class="studio-viewport-bottom"><span data-el="terrain-detail">Real terrain · coarse preview</span><button type="button" data-action="compare" class="studio-compare" aria-pressed="false">Compare original</button></div>
          </div>
          <div class="studio-live-strip"><div><span class="studio-status-light" data-el="live-light"></span><span data-el="live-status">Original camera still. Enable live terrain to see your edits.</span></div><button type="button" data-action="enable-live" class="studio-button studio-live-button">Enable live terrain <span aria-hidden="true">↗</span></button></div>
          <div class="studio-transport"><button type="button" class="studio-icon-button studio-play-motion" data-action="motion" aria-label="Play camera motion" disabled>▶</button><div class="studio-timeline"><label class="studio-sr-only" for="studio-progress">Camera move progress</label><input id="studio-progress" type="range" min="0" max="1000" value="0" step="1" data-el="timeline"><div><span data-el="time">0:00</span><span data-el="move-label">CAMERA MOVE</span><span data-el="duration">0:20</span></div></div><button type="button" class="studio-text-button" data-action="rewind" title="Return to start of camera move">↺</button></div>
          <section class="studio-analysis" aria-labelledby="studio-analysis-title"><div class="studio-analysis-heading"><span class="studio-analysis-icon" aria-hidden="true">✦</span><h3 id="studio-analysis-title">Camera intelligence</h3><span class="studio-score" data-el="score">READY</span></div><p data-el="analysis-summary">Explore a view, then shape your camera. Suggestions respect your locked controls.</p><ul data-el="warnings" class="studio-warnings" hidden></ul><p class="studio-change-summary" data-el="changes" hidden></p></section>
          <section class="studio-review" aria-labelledby="studio-review-title"><div class="studio-review-heading"><div><h3 id="studio-review-title">Your shortlist</h3><p>Keep the places you want to come back to.</p></div><div class="studio-verdicts"><button type="button" data-verdict="keep" aria-pressed="false"><span aria-hidden="true">♡</span> Keep</button><button type="button" data-verdict="maybe" aria-pressed="false">Maybe</button><button type="button" data-verdict="pass" aria-pressed="false">Pass</button></div></div><label class="studio-sr-only" for="studio-notes">Notes for this view</label><textarea id="studio-notes" data-el="notes" rows="2" maxlength="2000" placeholder="A thought for later: framing, a slower reveal, a different angle…"></textarea><p class="studio-review-disclaimer">Shortlist decisions describe the original view; camera drafts are saved separately.</p></section>
        </main>
        <aside class="studio-editor" aria-label="Camera editing controls">
          <div class="studio-panel-heading"><h2>Camera</h2><div class="studio-history"><button type="button" data-action="undo" class="studio-icon-button" aria-label="Undo camera edit" title="Undo camera edit (Ctrl or ⌘ Z)">↶</button><button type="button" data-action="redo" class="studio-icon-button" aria-label="Redo camera edit" title="Redo camera edit (Ctrl or ⌘ Shift Z)">↷</button></div></div>
          <div class="studio-camera-scroll">
            <section class="studio-assist"><div class="studio-assist-heading"><span>✦ Shape the shot</span><button type="button" class="studio-text-button" data-action="reset">Reset</button></div><div class="studio-preset-chips" data-el="preset-chips"></div><div class="studio-assist-actions"><button type="button" class="studio-button studio-randomize" data-action="randomize">${icons.shuffle} Randomize</button><button type="button" class="studio-button" data-action="improve">✦ Improve</button></div><label class="studio-strength"><span>Variation <output data-el="strength-label">30%</output></span><input data-el="strength" type="range" min="0.05" max="1" step="0.05" value="0.3"></label><label class="studio-seed"><span>Seed</span><input type="text" data-el="seed" value="terrain-01" maxlength="128" spellcheck="false"><button type="button" class="studio-text-button" data-action="new-seed" title="Choose a new random seed">↻</button></label><p>Lock a control to keep it during suggestions.</p></section>
            <div class="studio-aim-control"><div class="studio-field-label"><label for="studio-aim-mode">Aim mode</label><label class="studio-lock"><input type="checkbox" data-el="aim-lock" aria-label="Lock aim mode"><span>Lock</span></label></div><select id="studio-aim-mode" data-el="aim-mode"><option value="heading">Compass heading</option><option value="target">Track geographic target</option></select><p data-el="aim-description">Heading and pitch set the camera direction.</p><p class="studio-altitude-note" data-el="altitude-note" hidden></p></div>
            <div class="studio-camera-fields" data-el="camera-fields"></div>
            <section class="studio-saved-presets"><div class="studio-section-heading"><h3>Saved presets</h3><span data-el="preset-count">0</span></div><div class="studio-save-preset"><label class="studio-sr-only" for="studio-preset-name">New preset name</label><input id="studio-preset-name" data-el="preset-name" maxlength="80" placeholder="Name this camera…"><button type="button" data-action="save-preset" class="studio-button">Save</button></div><div class="studio-preset-picker"><label class="studio-sr-only" for="studio-preset-picker">Saved camera presets</label><select id="studio-preset-picker" data-el="preset-picker"><option value="">Choose a preset</option></select><button type="button" data-action="load-preset" class="studio-text-button">Load</button><button type="button" data-action="delete-preset" class="studio-icon-button" aria-label="Delete selected preset">×</button></div></section>
          </div>
          <div class="studio-editor-footer"><button type="button" data-action="use" class="studio-use-button" disabled>Play this view <span aria-hidden="true">→</span></button><p data-el="use-hint">Enable live terrain to play your camera.</p><div class="studio-project-actions"><button type="button" data-action="export" class="studio-text-button">Export project</button><span>·</span><button type="button" data-action="import" class="studio-text-button">Import project</button><input data-el="import-file" type="file" accept="application/json,.json" hidden></div></div>
        </aside>
      </div>
      <footer class="studio-footer"><span class="studio-footer-label">MIDIO PIXEL <span>/</span> TERRAIN STUDIO</span><span data-el="announcement" role="status" aria-live="polite">Local drafts. Real places. Your point of view.</span><span class="studio-shortcuts">← → explore <span>·</span> K keep <span>·</span> Esc close</span></footer>
    </div>`;
  document.body.append(dialog);

  const el = key => dialog.querySelector(`[data-el="${key}"]`);
  const action = key => dialog.querySelector(`[data-action="${key}"]`);
  let preview = null, liveWanted = false, liveReadyId = null, liveLoading = false;
  let generation = 0, imageGeneration = 0, imageAbort = null;
  let visibleId = null, compared = false, closed = false, using = false;
  let progress = 0, playing = false, frame = 0, lastTime = 0;
  const fieldInputs = new Map();

  const announce = message => { el('announcement').textContent = message; };
  function save() {
    let warning = '';
    try { storage?.setItem(REVIEW_KEY, JSON.stringify(session.snapshot())); if (!storage) warning = 'Storage unavailable'; }
    catch { warning = 'Export to keep your work'; }
    projects.save();
    warning ||= projects.warning || '';
    el('save-state').textContent = warning ? 'Export to keep your work' : 'Saved locally';
    el('save-state').classList.toggle('studio-unsaved', Boolean(warning));
  }

  function settings() { return session.current ? projects.draft(session.current) : null; }
  function duration() { return Math.max(1, Number(settings()?.durationSec) || 20); }
  function clock(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
  function syncTimeline() {
    el('timeline').value = String(Math.round(progress * 1000));
    el('timeline').disabled = compared || !session.current?.camera;
    action('rewind').disabled = compared || !session.current?.camera;
    el('time').textContent = clock(progress * duration());
    el('duration').textContent = clock(duration());
    action('motion').textContent = playing ? 'Ⅱ' : '▶';
    action('motion').setAttribute('aria-label', playing ? 'Pause camera motion' : 'Play camera motion');
    action('motion').disabled = !liveReadyId || liveReadyId !== session.current?.id || compared;
  }
  function stopMotion() { playing = false; cancelAnimationFrame(frame); frame = 0; lastTime = 0; syncTimeline(); }
  function tick(now) {
    if (!playing || closed) return;
    if (lastTime) progress = (progress + Math.min(0.1, (now - lastTime) / 1000) / duration()) % 1;
    lastTime = now; preview?.setProgress(progress); syncTimeline(); frame = requestAnimationFrame(tick);
  }
  function toggleMotion() {
    if (action('motion').disabled) return;
    if (playing) stopMotion();
    else { playing = true; lastTime = 0; frame = requestAnimationFrame(tick); syncTimeline(); }
  }

  function reportCamera(report = analyzeCamera(settings(), preview?.grid || null)) {
    if (!session.current) return;
    const score = Number(report?.score);
    el('score').textContent = Number.isFinite(score) ? `${Math.round(score)} / 100` : 'DRAFT';
    el('analysis-summary').textContent = messageOf(report?.summary) || 'Camera framing checked. Enable live terrain for ground clearance and coverage checks.';
    const warnings = Array.isArray(report?.warnings) ? report.warnings.map(messageOf).filter(Boolean) : [];
    el('warnings').replaceChildren(...warnings.slice(0, 3).map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
    el('warnings').hidden = warnings.length === 0;
    const changes = Array.isArray(report?.changes) ? report.changes.map(messageOf).filter(Boolean) : [];
    el('changes').textContent = changes.length ? changes.slice(0, 3).join(' · ') : '';
    el('changes').hidden = changes.length === 0;
  }

  function cameraChanged({ report, updateInputs = true } = {}) {
    if (!session.current) return;
    if (updateInputs) syncFields();
    if (!compared && liveReadyId === session.current.id) preview?.setCamera(settings());
    reportCamera(report);
    syncTimeline(); syncHistory(); save();
  }
  function edit(patch, options) { if (session.current) { projects.edit(session.current, patch, options); cameraChanged(); } }

  function buildFields() {
    const groups = new Map();
    for (const field of CAMERA_FIELDS) {
      const group = field.group || 'Camera';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(field);
    }
    let groupIndex = 0;
    for (const [group, fields] of groups) {
      const details = document.createElement('details'); details.className = 'studio-field-group'; details.open = groupIndex++ < 2;
      const summary = document.createElement('summary'); summary.textContent = group; details.append(summary);
      for (const field of fields) {
        const row = document.createElement('div'); row.className = 'studio-field';
        const heading = document.createElement('div'); heading.className = 'studio-field-label';
        const label = document.createElement('label'); label.htmlFor = `studio-field-${field.key}`; label.textContent = field.label;
        const lockLabel = document.createElement('label'); lockLabel.className = 'studio-lock'; lockLabel.title = `Keep ${field.label.toLowerCase()} during randomize and improve`;
        const lock = document.createElement('input'); lock.type = 'checkbox'; lock.setAttribute('aria-label', `Lock ${field.label.toLowerCase()}`);
        const lockText = document.createElement('span'); lockText.textContent = 'Lock'; lockLabel.append(lock, lockText); heading.append(label, lockLabel);
        const controls = document.createElement('div'); controls.className = 'studio-field-controls';
        const range = document.createElement('input'); range.type = 'range'; range.min = field.min; range.max = field.max; range.step = field.step; range.setAttribute('aria-label', field.label);
        const numberWrap = document.createElement('div'); numberWrap.className = 'studio-number';
        const number = document.createElement('input'); number.type = 'number'; number.id = label.htmlFor; number.min = field.min; number.max = field.max; number.step = field.step; number.inputMode = 'decimal';
        const unit = document.createElement('span'); unit.textContent = field.unit || '';
        numberWrap.append(number, unit); controls.append(range, numberWrap); row.append(heading, controls); details.append(row);
        const update = (input, coalesce) => {
          if (!Number.isFinite(input.valueAsNumber)) return;
          const value = Math.min(field.max, Math.max(field.min, input.valueAsNumber));
          const patch = { [field.key]: value };
          if (field.key === 'aboveGroundM') patch.heightM = null;
          projects.edit(session.current, patch, { coalesce });
          const normalized = settings()[field.key]; range.value = normalized; number.value = normalized;
          cameraChanged({ updateInputs: false });
        };
        range.addEventListener('input', () => update(range, true));
        range.addEventListener('change', () => update(range, false));
        number.addEventListener('change', () => update(number, false));
        lock.addEventListener('change', () => { if (session.current) { projects.toggleLock(session.current, field.key); syncFields(); save(); } });
        fieldInputs.set(field.key, { range, number, lock, row });
      }
      el('camera-fields').append(details);
    }
  }

  function syncFields() {
    const current = session.current, value = settings(), locks = current ? projects.locks(current) : {};
    const isLocked = key => locks instanceof Set ? locks.has(key) : Array.isArray(locks) ? locks.includes(key) : Boolean(locks[key]);
    for (const [key, field] of fieldInputs) {
      const inactive = value?.aimMode === 'target' ? ['headingDeg', 'pitchDeg'].includes(key) : ['targetLon', 'targetLat', 'targetHeightM'].includes(key);
      field.range.disabled = field.number.disabled = !current?.camera || isLocked(key) || inactive;
      field.lock.disabled = !current?.camera;
      field.range.value = value?.[key] ?? 0; field.number.value = value?.[key] ?? '';
      field.lock.checked = isLocked(key);
      field.row.classList.toggle('is-locked', field.lock.checked);
      field.row.classList.toggle('is-inactive', inactive);
      field.row.title = inactive ? value?.aimMode === 'target' ? 'Direction is calculated from your geographic target.' : 'Choose Track geographic target to use this control.' : '';
    }
    el('aim-mode').value = value?.aimMode || 'heading';
    el('aim-mode').disabled = !current?.camera || isLocked('aimMode');
    el('aim-lock').disabled = !current?.camera; el('aim-lock').checked = isLocked('aimMode');
    el('aim-description').textContent = value?.aimMode === 'target' ? 'The camera tracks your target. Heading and pitch are calculated.' : 'Heading and pitch set direction. Orbit distance sets the move’s pivot.';
    el('altitude-note').hidden = !Number.isFinite(value?.heightM);
    el('altitude-note').textContent = Number.isFinite(value?.heightM) ? `Authored altitude: ${Math.round(value.heightM).toLocaleString()} m. Editing Above ground switches to terrain following.` : '';
    for (const name of ['randomize', 'improve', 'reset', 'save-preset']) action(name).disabled = !current?.camera;
    for (const button of el('preset-chips').children) button.disabled = !current?.camera;
    syncHistory(); syncTimeline();
  }

  function syncHistory() {
    action('undo').disabled = !session.current || !projects.canUndo(session.current);
    action('redo').disabled = !session.current || !projects.canRedo(session.current);
  }

  function renderPresets() {
    const picker = el('preset-picker'), selected = picker.value, presets = session.current ? projects.presets(session.current.id) : [];
    picker.replaceChildren(new Option('Choose a preset', ''));
    for (const preset of presets) picker.append(new Option(preset.name, preset.id));
    picker.value = presets.some(p => p.id === selected) ? selected : '';
    el('preset-count').textContent = String(presets.length);
    action('load-preset').disabled = !picker.value || !session.current?.camera;
    action('delete-preset').disabled = !picker.value;
  }

  function renderList() {
    const queue = session.queue, current = session.current;
    const visible = queue.slice(0, 100);
    if (current && !visible.includes(current)) visible.push(current);
    const nodes = visible.map(candidate => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'studio-candidate';
      button.dataset.candidateId = candidate.id;
      button.setAttribute('aria-current', String(candidate.id === current?.id));
      const mark = document.createElement('span'); mark.className = 'studio-candidate-mark'; mark.innerHTML = icons.mountain;
      const copy = document.createElement('span'); copy.className = 'studio-candidate-copy';
      const name = document.createElement('strong'); name.textContent = candidate.name;
      const region = document.createElement('span'); region.textContent = candidate.region;
      copy.append(name, region);
      const verdict = session.decision(candidate.id)?.verdict;
      const status = document.createElement('span'); status.className = `studio-candidate-status${verdict ? ` is-${verdict}` : ''}`;
      status.textContent = verdict === 'keep' ? '♥' : verdict === 'maybe' ? '•' : verdict === 'pass' ? '−' : icons.chevron ? '›' : '';
      status.setAttribute('aria-label', verdict || 'Unreviewed');
      button.append(mark, copy, status); return button;
    });
    if (!nodes.length) {
      const empty = document.createElement('p'); empty.className = 'studio-list-empty'; empty.textContent = 'No places match. Try another region or clear your search.'; nodes.push(empty);
    }
    el('candidate-list').replaceChildren(...nodes);
    el('list-note').textContent = queue.length > 100 ? `First 100 of ${queue.length} matches. Search to narrow the collection.` : '';
    el('selection-count').textContent = `${queue.length} ${queue.length === 1 ? 'view' : 'views'}`;
  }

  function syncLive() {
    const ready = liveReadyId === session.current?.id && Boolean(preview?.grid) && preview.ready;
    el('canvas').hidden = !ready;
    if (ready) { el('still').hidden = true; el('empty').hidden = true; }
    el('preview-badge').textContent = ready ? compared ? 'LIVE · ORIGINAL CAMERA' : 'LIVE · YOUR CAMERA' : 'ORIGINAL STILL';
    el('preview-badge').classList.toggle('is-live', ready);
    el('live-light').classList.toggle('is-live', ready);
    action('enable-live').hidden = ready;
    action('enable-live').disabled = liveLoading || !session.current?.camera;
    action('enable-live').textContent = liveLoading ? 'Loading terrain…' : liveWanted ? 'Retry live terrain ↗' : 'Enable live terrain ↗';
    action('use').disabled = using || !ready || !session.current?.camera;
    el('use-hint').textContent = ready ? 'Play this camera on coarse real terrain.' : 'Enable live terrain to play your camera.';
    action('compare').setAttribute('aria-pressed', String(compared));
    action('compare').textContent = compared ? 'Back to your camera' : 'Compare original';
    action('compare').disabled = !ready;
    syncTimeline();
  }

  async function showStill() {
    const token = ++imageGeneration, candidate = session.current;
    imageAbort?.abort(); imageAbort = new AbortController();
    const selected = previewForMode(candidate, session.displayMode);
    const url = selected && previewUrl({ preview: selected }, CATALOG_URL);
    const img = el('still'); img.hidden = true; img.removeAttribute('src');
    el('empty').hidden = false;
    el('preview-message').textContent = !candidate ? 'No views in this selection. Change a filter to keep exploring.' : url ? 'Loading original landscape…' : 'No saved still for this view. Try live terrain.';
    el('viewport').setAttribute('aria-busy', String(Boolean(url)));
    img.alt = candidate ? `Original ${session.displayMode === 'shape' ? 'terrain shape' : 'landscape'} camera preview of ${candidate.name}, ${candidate.region}` : '';
    if (!url) { el('viewport').setAttribute('aria-busy', 'false'); return; }
    try {
      const dataUrl = await cache.load(url, { signal: imageAbort.signal, width: selected.width, height: selected.height, sha256: selected.sha256 });
      if (closed || token !== imageGeneration) return;
      img.onload = () => {
        if (closed || token !== imageGeneration) return;
        if (liveReadyId !== session.current?.id) { img.hidden = false; el('empty').hidden = true; }
        el('viewport').setAttribute('aria-busy', 'false');
      };
      img.onerror = () => { if (token === imageGeneration) el('preview-message').textContent = 'The original still could not display. Try live terrain.'; };
      img.src = dataUrl;
    } catch (error) {
      if (closed || imageAbort.signal.aborted || token !== imageGeneration) return;
      el('viewport').setAttribute('aria-busy', 'false'); el('preview-message').textContent = 'The original still could not load. Your drafts are safe.';
    }
  }

  async function loadLive() {
    const candidate = session.current;
    if (!candidate?.camera || closed) return;
    const token = ++generation;
    compared = false; stopMotion();
    liveWanted = true; liveLoading = true; liveReadyId = null;
    el('live-status').textContent = 'Loading real terrain for this view…'; syncLive();
    try {
      if (!preview) {
        const { TerrainPreview } = await import('./TerrainPreview.js');
        if (closed || token !== generation) return;
        preview = new TerrainPreview({ canvas: el('canvas'), onStatus: status => {
          if (closed || !preview) return;
          if (preview.ready && preview.grid) {
            liveReadyId = session.current?.id; liveLoading = false;
            el('live-status').textContent = 'Live camera · coarse terrain. Fine detail and production lighting may differ.';
            el('terrain-detail').textContent = `${Math.round(preview.grid.cellM || 250)} m terrain · interactive camera`;
            syncLive();
          } else {
            const wasLive = Boolean(liveReadyId);
            liveReadyId = null; liveLoading = /loading|preparing/i.test(status);
            if (wasLive) { stopMotion(); showStill(); }
            el('live-status').textContent = liveLoading ? status : `${status} Original still shown; edits are saved.`;
            syncLive();
          }
        } });
      }
      const pending = preview.select(candidate);
      preview.setCamera(settings()); preview.setMode(session.displayMode); preview.setProgress(progress);
      await pending;
      if (closed || token !== generation || candidate.id !== session.current?.id) return;
      preview.setMode(session.displayMode); preview.setCamera(settings()); preview.setProgress(progress);
      if (!preview.grid) throw new Error('The terrain did not become ready.');
      liveReadyId = candidate.id; liveLoading = false;
      el('live-status').textContent = 'Live camera · coarse terrain. Fine detail and production lighting may differ.';
      el('terrain-detail').textContent = `${Math.round(preview.grid.cellM || 250)} m terrain · interactive camera`;
      el('viewport').setAttribute('aria-busy', 'false'); syncLive(); reportCamera();
      announce(`Live terrain ready for ${candidate.name}. Your camera controls are active.`);
    } catch (error) {
      if (closed || token !== generation) return;
      liveLoading = false; liveReadyId = null;
      el('live-status').textContent = `${error.message || 'Live terrain is unavailable.'} Original still shown; edits are saved.`;
      syncLive(); showStill(); announce('Live terrain could not load. The image is the original, unedited view.');
    }
  }

  function render({ refresh = false } = {}) {
    const current = session.current, queue = session.queue, index = queue.findIndex(c => c.id === current?.id), counts = session.counts;
    const changed = visibleId !== current?.id;
    if (changed) {
      visibleId = current?.id || null; compared = false; stopMotion(); progress = 0;
      generation++; liveReadyId = null; liveLoading = false; el('canvas').hidden = true;
    }
    el('view-kind').textContent = current ? candidateKindLabel(current).toUpperCase() : 'YOUR NEXT POINT OF VIEW';
    el('view-name').textContent = current?.name || 'Room for another view';
    const biome = candidateBiome(current).replaceAll('_', ' ').toLowerCase();
    el('view-region').textContent = current ? `${current.region}${biome ? ` · ${biome}` : ''}` : 'Change a filter to explore the collection.';
    el('position').textContent = index < 0 ? '0 / 0' : `${index + 1} / ${queue.length}`;
    action('previous').disabled = index <= 0; action('next').disabled = index < 0 || index >= queue.length - 1;
    action('surprise').disabled = queue.length === 0;
    el('review-count').textContent = `${counts.keep} kept · ${counts.reviewed} reviewed`;
    action('review-undo').disabled = !session.history.length;
    for (const button of dialog.querySelectorAll('[data-verdict]')) {
      button.disabled = !current; button.setAttribute('aria-pressed', String(session.decision(current?.id)?.verdict === button.dataset.verdict));
    }
    el('notes').disabled = !current;
    if (document.activeElement !== el('notes')) el('notes').value = session.decision(current?.id)?.note || '';
    el('search').value = session.filters.search; el('region').value = session.filters.region; el('status').value = session.filters.status;
    for (const button of dialog.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(session.displayMode === button.dataset.mode));
    if (changed || refresh) {
      el('terrain-detail').textContent = `${Math.round(current?.preview?.cellM || 250)} m terrain · original camera`;
      el('live-status').textContent = 'Original camera still. Enable live terrain to see your edits.';
      showStill(); if (liveWanted && current?.camera) loadLive();
    }
    renderList(); syncFields(); syncLive(); renderPresets();
    if (current?.camera) reportCamera();
    else { el('analysis-summary').textContent = 'Pick a view from the collection to start shaping your camera.'; el('warnings').hidden = true; el('changes').hidden = true; }
  }

  function navigate(direction) { session.move(direction); render(); save(); }
  function decide(verdict) {
    if (!session.current) return;
    const name = session.current.name; session.decide(verdict); render(); save(); announce(`${name}: ${verdict === 'keep' ? 'kept' : verdict === 'pass' ? 'passed' : 'maybe'}.`);
  }

  function close() {
    if (closed) return;
    closed = true; generation++; imageGeneration++; imageAbort?.abort(); stopMotion(); preview?.dispose();
    save(); if (dialog.open) dialog.close(); dialog.remove();
    document.body.classList.remove('terrain-studio-open');
    if (activeStudio === controller) activeStudio = null;
    if (priorFocus?.isConnected) priorFocus.focus();
    onClose();
  }
  const controller = { close, focus() { dialog.focus(); }, get currentCandidate() { return session.current; }, get currentSettings() { return settings(); } };
  activeStudio = controller;

  for (const region of [...new Set(session.candidates.map(c => c.region))].sort()) el('region').append(new Option(region, region));
  el('total-count').textContent = String(session.candidates.length);
  for (const [key, label] of [['wide', 'Wide'], ['intimate', 'Intimate'], ['aerial', 'Aerial'], ['calm', 'Calm']]) {
    if (!CAMERA_PRESETS[key]) continue;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => { edit({ ...CAMERA_PRESETS[key], aimMode: 'heading', heightM: null }); announce(`${label} camera applied. Your previous camera is available in Undo.`); });
    el('preset-chips').append(button);
  }
  buildFields();

  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  action('close').addEventListener('click', close);
  action('compact').addEventListener('click', () => {
    const compact = dialog.classList.toggle('studio-compact'); action('compact').setAttribute('aria-pressed', String(compact));
    action('compact').textContent = compact ? 'Full studio' : 'Compact view';
  });
  for (const button of dialog.querySelectorAll('[data-panel]')) button.addEventListener('click', () => {
    dialog.querySelector('.studio-workspace').dataset.mobilePanel = button.dataset.panel;
    for (const other of dialog.querySelectorAll('[data-panel]')) other.setAttribute('aria-pressed', String(other === button));
  });
  el('candidate-list').addEventListener('click', event => {
    const button = event.target.closest('[data-candidate-id]');
    if (!button) return;
    session.currentId = button.dataset.candidateId; render(); save();
  });
  action('previous').addEventListener('click', () => navigate(-1)); action('next').addEventListener('click', () => navigate(1));
  action('surprise').addEventListener('click', () => {
    const queue = session.queue, alternatives = queue.filter(c => c.id !== session.currentId);
    if (!queue.length) return;
    session.currentId = (alternatives.length ? alternatives : queue)[Math.floor(Math.random() * (alternatives.length || queue.length))].id;
    render(); save(); announce(`Exploring ${session.current.name}.`);
  });
  for (const [key, event] of [['search', 'input'], ['region', 'change'], ['status', 'change']]) el(key).addEventListener(event, () => {
    session.filter({ [key]: el(key).value }); render(); save();
  });
  for (const button of dialog.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
    session.setDisplayMode(button.dataset.mode); preview?.setMode(session.displayMode);
    for (const other of dialog.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed', String(other === button));
    if (liveReadyId !== session.current?.id) showStill(); save();
  });
  action('enable-live').addEventListener('click', loadLive);
  action('compare').addEventListener('click', () => {
    if (action('compare').disabled) return;
    stopMotion(); compared = !compared; preview?.setCamera(compared ? defaultCamera(session.current) : settings()); preview?.setProgress(compared ? 0 : progress); syncLive();
  });
  action('motion').addEventListener('click', toggleMotion);
  el('timeline').addEventListener('input', () => { progress = el('timeline').valueAsNumber / 1000; preview?.setProgress(progress); syncTimeline(); });
  action('rewind').addEventListener('click', () => { progress = 0; lastTime = 0; preview?.setProgress(0); syncTimeline(); });
  for (const button of dialog.querySelectorAll('[data-verdict]')) button.addEventListener('click', () => decide(button.dataset.verdict));
  el('notes').addEventListener('input', () => { session.note(el('notes').value); save(); });
  action('review-undo').addEventListener('click', () => { if (session.undo()) { render(); save(); announce('Last shortlist decision undone.'); } });
  for (const operation of ['undo', 'redo']) action(operation).addEventListener('click', () => {
    if (!session.current) return;
    projects[operation](session.current); cameraChanged(); announce(operation === 'undo' ? 'Camera edit undone.' : 'Camera edit restored.');
  });
  action('reset').addEventListener('click', () => { const original = defaultCamera(session.current); edit({ ...original, heightM: original.heightM ?? null }); announce('Original camera restored for unlocked controls. Undo brings back your draft.'); });
  el('aim-mode').addEventListener('change', () => edit({ aimMode: el('aim-mode').value }));
  el('aim-lock').addEventListener('change', () => { if (session.current) { projects.toggleLock(session.current, 'aimMode'); syncFields(); save(); } });
  el('strength').addEventListener('input', () => { el('strength-label').value = `${Math.round(el('strength').valueAsNumber * 100)}%`; });
  action('new-seed').addEventListener('click', () => { el('seed').value = `terrain-${Math.random().toString(36).slice(2, 9)}`; });
  for (const operation of ['randomize', 'improve']) action(operation).addEventListener('click', () => {
    const candidate = session.current; if (!candidate?.camera) return;
    const options = { candidate, grid: preview?.grid || null, locks: projects.locks(candidate), seed: el('seed').value || 'terrain', strength: el('strength').valueAsNumber };
    const result = operation === 'randomize' ? randomizeCamera(settings(), options) : improveCamera(settings(), options);
    projects.edit(candidate, { ...result.settings, heightM: result.settings.heightM ?? null }); cameraChanged({ report: result.report });
    announce(operation === 'randomize' ? `Variation created with seed ${options.seed}. Locked controls were respected.` : 'Camera suggestions applied. Undo restores your previous shot.');
  });
  action('save-preset').addEventListener('click', () => {
    const name = el('preset-name').value.trim();
    if (!name) { el('preset-name').focus(); announce('Give your camera preset a name.'); return; }
    try { projects.savePreset(session.current, name); el('preset-name').value = ''; renderPresets(); save(); announce(`Camera preset “${name}” saved.`); }
    catch (error) { announce(error.message); }
  });
  el('preset-picker').addEventListener('change', renderPresets);
  action('load-preset').addEventListener('click', () => {
    try { projects.applyPreset(el('preset-picker').value, session.current); cameraChanged(); announce('Saved camera preset applied.'); }
    catch (error) { announce(error.message); }
  });
  action('delete-preset').addEventListener('click', () => { projects.deletePreset(el('preset-picker').value); renderPresets(); save(); announce('Camera preset deleted. Current camera kept.'); });
  action('export').addEventListener('click', () => {
    download({ schema: 'midio.terrain-studio-project', version: 1, project: projects.snapshot(), review: session.snapshot() }, 'midio-terrain-studio.json'); announce('Studio project exported with camera drafts, presets and shortlist notes.');
  });
  action('import').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('Project is too large (16 MB maximum).');
      const raw = await file.text(), value = JSON.parse(raw);
      if (value.review) { const check = new ReviewSession(catalog); check.import(value.review); }
      projects.import(value.project || value);
      if (value.review) session.import(value.review);
      render({ refresh: true }); save(); announce('Studio project imported. Matching camera drafts and presets are ready.');
    } catch (error) { announce(`Import failed: ${error.message}`); }
    event.target.value = '';
  });
  action('use').addEventListener('click', async () => {
    if (action('use').disabled || !session.current?.camera || !preview?.grid) return;
    using = true; syncLive(); action('use').textContent = 'Opening view…';
    try { await onUse({ candidate: session.current, settings: settings(), grid: preview.grid }); close(); }
    catch (error) { announce(`Could not play this camera: ${error.message}`); }
    finally { using = false; if (!closed) { action('use').innerHTML = 'Play this view <span aria-hidden="true">→</span>'; syncLive(); } }
  });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    const editing = event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !editing) {
      event.preventDefault(); action(event.shiftKey ? 'redo' : 'undo').click(); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || editing) return;
    const operation = { ArrowLeft: () => navigate(-1), ArrowRight: () => navigate(1), k: () => decide('keep'), m: () => decide('maybe'), p: () => decide('pass'), ' ': toggleMotion }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (operation) { event.preventDefault(); operation(); }
  });
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) dialog.addEventListener(type, event => { event.stopPropagation(); event.preventDefault(); });
  document.body.classList.add('terrain-studio-open'); dialog.showModal();
  render({ refresh: true }); save();
  action('close').focus();
  if (session.restoreWarning) announce(`Some shortlist data could not be restored: ${session.restoreWarning}`);
  else if (projects.warning) announce(projects.warning);
  return controller;
}
