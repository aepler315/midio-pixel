import { retainHistorySource } from './HistorySource.js';
const root = new URL('../../', import.meta.url);
const frame = document.getElementById('versionEngine');
const nav = document.getElementById('versionNavigation');
const previous = document.getElementById('versionPrevious');
const next = document.getElementById('versionNext');
const picker = document.getElementById('versionPicker');
const dialog = document.getElementById('versionDialog');
const search = document.getElementById('versionSearch');
const list = document.getElementById('versionList');
const count = document.getElementById('versionCount');
const status = document.getElementById('versionStatus');
const resume = document.getElementById('versionResume');
let manifest, selected, epoch = 0, observer, readyTimer, restoreAction, source = null, intent = null, loading = false;
const controls = [previous, next, picker];
export function validateHistoryManifest(value) {
  if (value?.schema !== 2 || !/^[a-f0-9]{40}$/.test(value.buildSha) || !Array.isArray(value.entries) || !value.entries.length) throw new Error('Invalid full-history catalog.');
  const ids = new Set();
  for (const e of value.entries) {
    if (!/^v-[a-f0-9]{12}$/.test(e.id) || ids.has(e.id) || !/^[a-f0-9]{40}$/.test(e.sourceSha) || typeof e.label !== 'string' || !e.label || typeof e.live !== 'boolean' || e.entryPath !== (e.live ? 'engine/index.html' : `versions/run/${e.id}/`)) throw new Error('Invalid version entry.');
    ids.add(e.id);
  }
  if (value.entries.filter(e => e.live).length !== 1 || value.entries.at(-1).id !== value.liveId || !value.entries.at(-1).live) throw new Error('Latest version is missing.');
  return value;
}
function message(text = '') { status.textContent = text; }
function engineAdapter() { return frame.contentWindow?.__MIDIO_VERSION_ADAPTER; }
function wake() {
  try { (engineAdapter() || frame.contentWindow?.__MIDIO_HISTORY_ENGINE)?.wakeHud(); } catch { /* Older engines have their own timers. */ }
  nav.classList.remove('hud-faded'); nav.inert = false; nav.setAttribute('aria-hidden', 'false');
}
function syncHud() {
  const doc = frame.contentDocument;
  const hud = doc?.getElementById('hudRight') || doc?.getElementById('hud');
  const title = doc?.getElementById('loader');
  const titleVisible = title && !title.classList.contains('hidden') && getComputedStyle(title).display !== 'none';
  const hidden = !dialog.open && !loading && !restoreAction && !status.textContent && !titleVisible && !!hud?.classList.contains('hud-faded') && !nav.contains(nav.getRootNode().activeElement || nav.ownerDocument.activeElement);
  nav.classList.toggle('hud-faded', hidden); nav.inert = hidden; nav.setAttribute('aria-hidden', String(hidden));
  for (const control of controls) control.tabIndex = hidden ? -1 : 0;
}
function renderList() {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const entries = manifest.entries.filter(e => terms.every(term => `${e.label} ${e.sourcePr ? '#' + e.sourcePr : ''} ${e.date} ${e.updated} ${e.sourceSha} ${e.visualSha} ${e.revisions.join(' ')}`.toLowerCase().includes(term)));
  list.replaceChildren();
  // Newest first in the menu; chronological arrows use catalog order.
  for (const e of [...entries].reverse()) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.dataset.versionId = e.id; button.setAttribute('aria-current', String(e.id === selected?.id));
    button.append(document.createTextNode(`${e.label}${e.live ? ' · Latest' : ''}`));
    const detail = document.createElement('span'); detail.className = 'version-detail';
    detail.textContent = `${e.date} · ${e.sourceSha.slice(0, 12)}${e.revisions.length > 1 ? ` · includes ${e.revisions.length - 1} UI/build updates` : ''}`;
    button.append(detail); button.addEventListener('click', () => selectVersion(e.id)); item.append(button); list.append(item);
  }
  count.textContent = `${entries.length} of ${manifest.entries.length} versions`;
  if (!entries.length) { const item = document.createElement('li'); item.textContent = 'No matching versions.'; list.append(item); }
}
function captureIntent() {
  // A destination still restoring our retained source is disposable. Keep
  // the previous playback intent rather than capturing its partial state.
  if (loading || readyTimer) return intent;
  const adapter = engineAdapter(), debug = frame.contentWindow?.__SMW;
  if (adapter) {
    const state = adapter.getState();
    if (state.blockedReason) throw new Error(state.blockedReason);
    if (state.source) source = retainHistorySource(state.source);
    else if (state.phase === 'title') { source = null; intent = null; }
    const { phase, generation, sourceId, positionMs, durationMs, seed, paused, worldId, rangeViewId } = state;
    return state.phase === 'ready' ? { phase, generation, sourceId, positionMs, durationMs, seed, paused, worldId, rangeViewId, lyricsDisabled: frame.contentDocument.getElementById('lyricGroundingBtn')?.getAttribute('aria-pressed') === 'false', settings: { ...state.settings } } : intent;
  }
  const historical = frame.contentWindow?.__MIDIO_HISTORY_ENGINE?.getState();
  if (historical?.blockedReason) throw new Error(historical.blockedReason);
  if (historical?.ready) return { ...intent, ...historical, settings: { ...intent?.settings, ...historical.settings } };
  if (debug?.sim) return { positionMs: debug.audioEngine?.nowMs || 0, paused: debug.audioEngine?.ctx?.state === 'suspended', worldId: debug.worldId, seed: debug.songSeed };
  return intent;
}
async function registerArchiveWorker() {
  if (!navigator.serviceWorker) throw new Error('Historical versions require HTTPS or localhost.');
  await navigator.serviceWorker.register(new URL(`history-worker.js?build=${manifest.buildSha}`, root), { type: 'module', scope: root.pathname, updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
    const changed = () => { if (navigator.serviceWorker.controller) { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); } };
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('The history worker did not activate. Reload to retry.')); }, 15000);
    navigator.serviceWorker.addEventListener('controllerchange', changed); changed();
  });
}
async function selectVersion(id, { history = true, initial = false } = {}) {
  const entry = manifest.entries.find(e => e.id === id);
  if (!entry || (!initial && entry.id === selected?.id)) { dialog.close(); return; }
  try { if (!initial) intent = captureIntent(); } catch (error) { message(error.message); return; }
  const token = ++epoch;
  if (dialog.open) dialog.close();
  // Navigating a fullscreen child can leave the outer iframe fullscreen,
  // which would hide controls adopted back into the host document.
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); }
    catch { message('Exit fullscreen to change versions.'); return; }
    if (token !== epoch) return;
  }
  observer?.disconnect(); clearInterval(readyTimer); readyTimer = null; loading = true; restoreAction = null; resume.hidden = true;
  selected = entry; message(`Loading ${entry.label}…`); wake();
  const index = manifest.entries.indexOf(entry);
  previous.disabled = index === 0; next.disabled = index === manifest.entries.length - 1;
  previous.setAttribute('aria-label', index ? `Previous version: ${manifest.entries[index - 1].label}` : 'No earlier version');
  next.setAttribute('aria-label', index < manifest.entries.length - 1 ? `Next version: ${manifest.entries[index + 1].label}` : 'No later version');
  picker.disabled = false; picker.textContent = `${index + 1} / ${manifest.entries.length} · ${entry.label}${entry.live ? ' · Latest' : ''} ▾`;
  picker.title = `${entry.sourceSha} · ${entry.updated || entry.date}`;
  if (history) {
    const url = new URL(location.href); if (entry.live) url.searchParams.delete('version'); else url.searchParams.set('version', entry.id);
    window.history[initial ? 'replaceState' : 'pushState']({ version: entry.id }, '', url);
  }
  renderList();
  frame.onload = () => { if (token === epoch && new URL(frame.contentDocument?.URL || 'about:blank').pathname === new URL(frame.dataset.versionUrl).pathname) attachEngine(token); };
  const url = new URL(entry.entryPath, root);
  // World/renderer/debug options belong to the engine; the picker owns only
  // its version selection. Existing app links retain their normal behavior.
  for (const [key, value] of new URL(location.href).searchParams) if (key !== 'version') url.searchParams.append(key, value);
  document.body.append(nav, dialog, status, resume);
  frame.dataset.versionUrl = url.href;
  frame.contentWindow.location.replace(url.href);
}
function attachEngine(token) {
  const doc = frame.contentDocument;
  if (!doc?.getElementById('stage')) { loading = false; message('This version could not load. Choose another version or reload to retry.'); return; }
  const hudSpace = doc.createElement('style');
  hudSpace.textContent = '#hud{top:100px!important}#loader.titleScreen{padding-top:100px}@media(max-width:560px){#hud{top:82px!important}#loader.titleScreen{padding-top:82px}}';
  doc.head.append(hudSpace);
  // Keep the version controls in the engine’s fullscreen tree. They retain
  // their controller and isolated styles when adopted back into the host.
  const surfaces = [nav, dialog, status, resume];
  doc.addEventListener('fullscreenchange', () => {
    if (doc.fullscreenElement) {
      const overlay = doc.createElement('div'), shadow = overlay.attachShadow({ mode: 'open' });
      overlay.id = 'historyFullscreenOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      // Native game shortcuts cannot see input controls through a shadow
      // boundary. Let picker keys keep their browser default behavior.
      shadow.addEventListener('keydown', event => event.stopPropagation());
      shadow.addEventListener('keyup', event => event.stopPropagation());
      const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('src/ui/history-picker.css', root).href; shadow.append(css, ...surfaces);
      doc.fullscreenElement.append(overlay);
    } else { document.body.append(...surfaces); doc.getElementById('historyFullscreenOverlay')?.remove(); }
  });
  const retainFiles = files => { if (files?.length) { clearInterval(readyTimer); readyTimer = null; source = retainHistorySource({ kind: 'audio-files', files: [...files] }); intent = null; message(); } };
  doc.addEventListener('change', event => { if (event.target.id === 'fileInput' && !loading) retainFiles(event.target.files); }, true);
  doc.addEventListener('drop', event => { if (!loading) retainFiles(event.dataTransfer?.files); }, true);
  for (const id of ['stopBtn', 'worldSelectBack', 'urlLoadBtn']) doc.getElementById(id)?.addEventListener('click', () => { if (!loading) { source = null; intent = null; } }, true);
  doc.getElementById('demoBtn')?.addEventListener('click', () => { if (!loading) { source = { kind: 'demo' }; intent = null; message(); } }, true);
  doc.addEventListener('pointermove', syncHud, { passive: true });
  doc.addEventListener('pointerdown', () => { message(); syncHud(); }, { passive: true });
  observer = new MutationObserver(syncHud); observer.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  loading = false; message(); frame.focus(); syncHud();
  if (!source) return;
  let attempts = 0;
  const restore = async () => {
    if (token !== epoch) return;
    const adapter = engineAdapter();
    if (adapter && selected.live) {
      loading = true; message('Restoring your song…');
      try {
        const state = intent || {};
        // Apply pause after readiness. Baking it into the original load
        // options makes later background analysis restore that old pause
        // again after the player has resumed.
        await adapter.loadSource(source, { ...state, sourceId: state.sourceId, paused: false });
        if (token !== epoch) return;
        await adapter.setPaused(!!state.paused); message();
      } catch (error) {
        if (token !== epoch) return;
        restoreAction = async () => { if (adapter.getState().phase === 'ready') await adapter.setPaused(!!intent?.paused); else await restore(); };
        resume.hidden = false; message(`Your song is retained. ${error.message}`);
      } finally { if (token === epoch) { loading = false; syncHud(); } }
      return;
    }
    const input = doc.getElementById('fileInput'), demo = doc.getElementById('demoBtn');
    loading = true;
    if (source.kind === 'audio-files' && source.files.length > 1 && !input?.multiple) { loading = false; message('Your stems are retained. This older engine accepts one file at a time.'); return; }
    const world = doc.getElementById('titleWorld');
    const desiredWorld = intent?.worldId === 'custom' ? intent?.settings?.worldBaseId : intent?.worldId;
    if (world && [...world.options].some(option => option.value === desiredWorld)) { world.value = desiredWorld; world.dispatchEvent(new Event('change', { bubbles: true })); }
    const lyrics = doc.getElementById('lyricGroundingBtn');
    if (intent?.lyricsDisabled && lyrics?.getAttribute('aria-pressed') === 'true') lyrics.click();
    const seed = doc.getElementById('seedInput'); if (seed && Number.isFinite(intent?.seed)) seed.value = String(intent.seed);
    if (source.kind === 'audio-files' && input) {
      const files = new DataTransfer(); for (const file of source.files) files.items.add(file);
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (source.kind === 'demo' && demo) demo.click();
    else { loading = false; message('This engine cannot restore this source. Your files are retained for another version.'); return; }
    loading = false;
    // Original menus may ask for a world or lyrics before starting. Restore
    // the position only after their engine owns a ready simulation.
    readyTimer = setInterval(async () => {
      if (token !== epoch) { clearInterval(readyTimer); return; }
      const debug = frame.contentWindow?.__SMW, bridge = frame.contentWindow?.__MIDIO_HISTORY_ENGINE;
      const state = bridge?.getState();
      if (state?.ready || debug?.sim) {
        clearInterval(readyTimer); readyTimer = null;
        if (intent?.paused) { try { await (bridge ? bridge.setPaused(true) : debug?.audioEngine?.ctx?.suspend()); } catch (error) { if (token === epoch) message(error.message); return; } if (token !== epoch) return; }
        const seek = bridge?.seek || debug?.seek;
        if (intent?.positionMs && seek) seek(Math.min(intent.positionMs, state?.durationMs || debug?.durationMs || debug?.conductor?.durationMs || intent.positionMs));
        else if (intent?.positionMs) message('This older engine restarts playback from the beginning.');
        if (intent?.paused) { Promise.resolve(bridge ? bridge.setPaused(true) : debug?.audioEngine?.ctx?.suspend()).catch(error => { if (token === epoch) message(error.message); }); }
        else if ((state?.audioState || debug?.audioEngine?.ctx?.state) === 'suspended') {
          restoreAction = () => bridge ? bridge.setPaused(false) : debug.audioEngine.ctx.resume(); resume.hidden = false; message('Tap Resume song to enable audio.');
        }
        syncHud();
      } else if (++attempts >= 480) { clearInterval(readyTimer); readyTimer = null; message('Your song is retained. Use this version’s start controls to continue.'); }
    }, 250);
  };
  // Module initialization can finish just after the iframe load event.
  setTimeout(restore, 0);
}
previous.addEventListener('click', () => { const i = manifest.entries.indexOf(selected); if (i > 0) selectVersion(manifest.entries[i - 1].id); });
next.addEventListener('click', () => { const i = manifest.entries.indexOf(selected); if (i < manifest.entries.length - 1) selectVersion(manifest.entries[i + 1].id); });
picker.addEventListener('click', () => { if (!manifest) return; wake(); renderList(); dialog.showModal(); search.focus(); });
search.addEventListener('input', renderList);
document.getElementById('versionClose').addEventListener('click', () => dialog.close());
document.getElementById('versionLatest').addEventListener('click', () => selectVersion(manifest.liveId));
dialog.addEventListener('close', () => { picker.focus(); wake(); });
nav.addEventListener('pointerdown', wake); nav.addEventListener('focusin', wake);
nav.addEventListener('focusout', () => setTimeout(syncHud, 0));
resume.addEventListener('click', async () => {
  try { await restoreAction?.(); restoreAction = null; resume.hidden = true; message(); syncHud(); } catch (error) { message(error.message); }
});
window.addEventListener('popstate', () => { if (manifest) selectVersion(new URL(location.href).searchParams.get('version') || manifest.liveId, { history: false }); });
async function start() {
  try {
    const response = await fetch(new URL('versions/manifest.json', root), { cache: 'no-cache' });
    if (!response.ok) throw new Error('Full version catalog missing. Run npm start to build it.');
    manifest = validateHistoryManifest(await response.json());
    await registerArchiveWorker();
    const requested = new URL(location.href).searchParams.get('version');
    const id = manifest.entries.some(e => e.id === requested) ? requested : manifest.liveId;
    await selectVersion(id, { initial: true });
  } catch (error) {
    message(error.message); picker.textContent = 'Reload to retry versions'; picker.disabled = false; picker.onclick = () => location.reload();
    frame.src = new URL('engine/index.html', root).href;
  }
}
start();
