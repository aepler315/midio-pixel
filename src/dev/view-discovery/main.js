import { ReviewSession, PreviewCache, previewUrl, previewForMode, candidateKindLabel, candidateBiome, MAX_REVIEW_BYTES } from './review-state.js';

const STORAGE_KEY = 'midio.view-discovery.review.v1';
const catalogUrl = new URL('../../assets/view-discovery/catalog.json', import.meta.url);
const byId = id => document.getElementById(id);
let session, comparison = false, visibleId = null, storageWorking = true;
const previewCache = new PreviewCache();
let previewGeneration = 0, previewController = null;

function announce(message) { byId('announcement').textContent = message; }

function save() {
  if (!session) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session.snapshot()));
    storageWorking = true;
    byId('storage-state').textContent = 'Saved in this browser. Export to keep a portable copy.';
  } catch {
    storageWorking = false;
    byId('storage-state').textContent = 'Browser storage is unavailable. Export your review before leaving.';
  }
  byId('storage-state').classList.toggle('unsaved', !storageWorking);
}

function download(value, filename) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showPreview(candidate, reference) {
  const generation = ++previewGeneration;
  previewController?.abort();
  previewController = new AbortController();
  const signal = previewController.signal;
  const shown = comparison ? reference : candidate;
  const selectedPreview = previewForMode(shown, session.displayMode);
  const appearance = session.displayMode === 'landscape' && selectedPreview?.appearance === 'landscape-study';
  const img = byId('preview'), empty = byId('preview-empty'), stage = byId('image-stage');
  img.hidden = true;
  img.removeAttribute('src');
  empty.hidden = false;
  const url = selectedPreview && previewUrl({ preview: selectedPreview }, catalogUrl);
  stage.setAttribute('aria-busy', String(Boolean(url)));
  byId('preview-message').textContent = !candidate ? 'You’ve reached the end of this selection. Change a filter to explore more.'
    : url ? 'Loading preview…' : 'Preview unavailable. This candidate stays in the collection for another look.';
  byId('preview-label').textContent = appearance ? 'Landscape appearance preview' : 'Terrain shape';
  img.alt = shown ? `${appearance ? 'Landscape appearance' : 'Terrain shape'} preview of ${shown.name}, ${shown.region}` : '';
  const failed = () => {
    if (generation !== previewGeneration) return;
    img.hidden = true; empty.hidden = false; stage.setAttribute('aria-busy', 'false');
    byId('preview-message').textContent = 'This preview could not load. Your review progress is safe.';
  };
  img.onload = () => { if (generation === previewGeneration) { img.hidden = false; empty.hidden = true; stage.setAttribute('aria-busy', 'false'); } };
  img.onerror = failed;
  byId('compare').hidden = !reference;
  byId('compare').setAttribute('aria-pressed', String(comparison));
  byId('compare').textContent = comparison ? 'Return to candidate' : 'Compare with existing scene';
  const originalWarning = typeof selectedPreview?.warning === 'string' ? selectedPreview.warning : '';
  const cameraCaveat = 'Saved above-ground height is reapplied to the coarse terrain; original camera height is retained in provenance.';
  const hasCameraCaveat = originalWarning.includes(cameraCaveat);
  const otherWarning = originalWarning.replace(cameraCaveat, '').trim();
  byId('preview-warning').hidden = !originalWarning;
  byId('preview-warning').classList.toggle('informational', hasCameraCaveat && !otherWarning);
  byId('preview-warning').textContent = [otherWarning, hasCameraCaveat ? 'Camera follows the coarse ground; the source camera is retained in the shortlist.' : ''].filter(Boolean).join(' ');
  const spacing = Number.isFinite(selectedPreview?.cellM) ? `${Math.round(selectedPreview.cellM)} m terrain preview` : 'Coarse terrain preview';
  byId('preview-detail').textContent = comparison ? `${reference.name} — ${candidateKindLabel(reference).toLocaleLowerCase()}. Return to the candidate to rate it.`
    : candidate ? (appearance ? 'Current landscape colors and lighting on coarse terrain. Fine detail, water, trees and motion can differ.' : `${spacing} · terrain shape and camera framing only.`) : 'Every decision is still available through the review filters.';
  if (url) {
    try {
      const dataUrl = await previewCache.load(url, { signal, width: selectedPreview.width, height: selectedPreview.height, sha256: selectedPreview.sha256 });
      if (generation === previewGeneration && !signal.aborted) img.src = dataUrl;
    } catch { if (!signal.aborted) failed(); }
  }
}

function render({ reloadPreview = false } = {}) {
  const c = session.current, queue = session.queue, index = queue.findIndex(v => v.id === c?.id), counts = session.counts;
  if (visibleId !== c?.id) { comparison = false; visibleId = c?.id; reloadPreview = true; }
  const reference = c?.referenceId && c.referenceId !== c.id ? session.byId.get(c.referenceId) : null;
  if (!reference) comparison = false;
  byId('view-name').textContent = c?.name || (counts.reviewed === counts.total ? 'That’s the collection.' : 'No views in this selection.');
  byId('view-kind').textContent = c ? candidateKindLabel(c).toLocaleUpperCase() : 'ROOM FOR ANOTHER LOOK';
  const biome = candidateBiome(c);
  byId('view-region').textContent = c ? `${c.region}${c.landmark ? ` · ${c.landmark}` : ''}${biome ? ` · ${biome.replaceAll('_', ' ').toLocaleLowerCase()}` : ''}` : 'Your shortlist is ready whenever you are.';
  byId('progress').textContent = `${counts.reviewed} / ${counts.total} reviewed · ${counts.keep} kept · ${counts.maybe} maybe`;
  byId('position').textContent = c ? `${index + 1} / ${queue.length} in selection` : '0 in selection';
  const decision = c && session.decision(c.id);
  byId('verdict').hidden = !decision?.verdict;
  byId('verdict').textContent = decision?.verdict ? ({ keep: 'Kept', maybe: 'Maybe', pass: 'Passed' }[decision.verdict]) : '';
  byId('previous').disabled = index <= 0;
  byId('next').disabled = index < 0 || index >= queue.length - 1;
  for (const verdict of ['keep', 'maybe', 'pass']) byId(verdict).disabled = !c || comparison;
  byId('undo').disabled = !session.history.length;
  byId('notes').disabled = !c;
  if (document.activeElement !== byId('notes')) byId('notes').value = decision?.note || '';
  byId('status-filter').value = session.filters.status;
  byId('region-filter').value = session.filters.region;
  byId('search').value = session.filters.search;
  byId('shortlist').disabled = counts.keep + counts.maybe === 0;
  byId('mode-landscape').setAttribute('aria-pressed', String(session.displayMode === 'landscape'));
  byId('mode-shape').setAttribute('aria-pressed', String(session.displayMode === 'shape'));
  if (reloadPreview) showPreview(c, reference);
}

function navigate(direction) { session.move(direction); render(); save(); }
function decide(verdict) {
  if (!session.current || comparison) return;
  const name = session.current.name;
  session.decide(verdict); render(); save();
  announce(`${name}: ${verdict === 'keep' ? 'kept' : verdict === 'pass' ? 'passed' : 'maybe'}.`);
}

async function boot() {
  const response = await fetch(catalogUrl);
  if (!response.ok) throw new Error(`The collection could not load (HTTP ${response.status}).`);
  const catalog = await response.json();
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { storageWorking = false; }
  session = new ReviewSession(catalog, stored);
  for (const region of [...new Set(session.candidates.map(c => c.region))].sort()) {
    const option = document.createElement('option'); option.value = region; option.textContent = region; byId('region-filter').append(option);
  }
  byId('previous').addEventListener('click', () => navigate(-1));
  byId('next').addEventListener('click', () => navigate(1));
  for (const verdict of ['keep', 'maybe', 'pass']) byId(verdict).addEventListener('click', () => decide(verdict));
  byId('compare').addEventListener('click', () => { comparison = !comparison; render({ reloadPreview: true }); });
  for (const mode of ['landscape', 'shape']) byId(`mode-${mode}`).addEventListener('click', () => { session.setDisplayMode(mode); render({ reloadPreview: true }); save(); });
  byId('undo').addEventListener('click', () => { if (session.undo()) { render(); save(); announce('Last decision undone.'); } });
  byId('notes').addEventListener('input', () => { session.note(byId('notes').value); save(); });
  for (const [id, key, event] of [['status-filter', 'status', 'change'], ['region-filter', 'region', 'change'], ['search', 'search', 'input']]) {
    byId(id).addEventListener(event, () => { session.filter({ [key]: byId(id).value }); render(); save(); });
  }
  byId('export').addEventListener('click', () => { download(session.snapshot(), 'midio-view-review.json'); announce('Review exported with decisions, notes and your place in the queue.'); });
  byId('shortlist').addEventListener('click', () => { download(session.shortlist(), 'midio-view-shortlist.json'); announce('Shortlist exported with exact cameras for kept and maybe views.'); });
  byId('import').addEventListener('click', () => byId('import-file').click());
  byId('import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_REVIEW_BYTES) throw new Error('Review file is too large (16 MB maximum).');
      const result = session.import(await file.text());
      render({ reloadPreview: true }); save();
      announce(`Imported ${result.accepted} matching decisions. ${result.outdated} outdated entries kept as inactive export backups; ${result.ignored - result.outdated} other invalid or unknown entries ignored.`);
    } catch (error) { announce(`Import failed: ${error.message}`); }
    event.target.value = '';
  });
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const action = { ArrowLeft: () => navigate(-1), ArrowRight: () => navigate(1), k: () => decide('keep'), m: () => decide('maybe'), p: () => decide('pass') }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (action) { event.preventDefault(); action(); }
  });
  render();
  save();
  if (session.restoreWarning) announce(`Saved review could not be restored: ${session.restoreWarning}. Import an exported copy if you have one.`);
  else if (session.restoreReport?.outdated) announce(`${session.restoreReport.outdated} outdated review entries no longer match these previews. Matching reviews were kept; old entries remain in your export as inactive backups.`);
}

export const ready = boot().catch(error => {
  byId('view-name').textContent = 'The collection is unavailable.';
  byId('preview-message').textContent = error.message;
  byId('progress').textContent = 'Please reload to try again.';
  byId('image-stage').setAttribute('aria-busy', 'false');
  for (const button of document.querySelectorAll('button')) button.disabled = true;
});
