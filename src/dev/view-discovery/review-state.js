// Discovery decisions are a personal shortlist, never production approval.
// Kept apart from the renderer so reviewing hundreds of stills needs no GPU.
export const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_RECORDS = 10000;
const VERDICTS = new Set(['keep', 'maybe', 'pass']);
const STATUSES = new Set(['all', 'unreviewed', ...VERDICTS]);
const DISPLAY_MODES = new Set(['landscape', 'shape']);
const SCHEMA = 'midio.view-discovery-review';
const text = (v, max) => typeof v === 'string' && v.length <= max;
const safeId = v => text(v, 160) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v);
const signature = v => text(v, 128) && v.length > 0;

export function candidateKindLabel(candidate) {
  if (candidate.kind === 'reference' || candidate.sourceViewId) {
    if (candidate.provenance?.sourceStatus === 'rejected') return 'Historical candidate';
    if (candidate.provenance?.sourceStatus === 'approved' || candidate.provenance?.sourceExperimental === true) return 'Existing scene reference';
    return 'Authored candidate';
  }
  return candidate.kind === 'computed' ? 'Calculated viewpoint' : 'Broad exploration';
}

export function candidateBiome(candidate) {
  const resolved = candidate?.provenance?.style?.styleBiome;
  return typeof resolved === 'string' ? resolved : typeof candidate?.biome === 'string' ? candidate.biome : '';
}

export function validateCatalog(catalog) {
  if (catalog?.schema !== 'midio.view-discovery' || catalog.version !== 1
    || !Array.isArray(catalog.candidates) || catalog.candidates.length > MAX_RECORDS) throw new Error('Unsupported discovery catalog');
  const seen = new Set();
  for (const c of catalog.candidates) {
    if (!c || !safeId(c.id) || !signature(c.signature) || !text(c.name, 300) || !text(c.region, 300)
      || !['reference', 'computed', 'explore'].includes(c.kind)) throw new Error('Invalid discovery candidate');
    if (seen.has(c.id)) throw new Error(`Catalog has duplicate candidate ${c.id}`);
    seen.add(c.id);
    // A failed source fetch can leave a reference's camera unresolved. Keep
    // that honest unavailable card in the queue instead of losing all views.
    if (c.preview?.status === 'unavailable') continue;
    const p = c.camera, e = p?.eye;
    if (!e || !Number.isFinite(e.lon) || Math.abs(e.lon) > 180 || !Number.isFinite(e.lat) || Math.abs(e.lat) > 90
      || !Number.isFinite(p.headingDeg) || !Number.isFinite(p.pitchDeg) || !Number.isFinite(p.hfovDeg)
      || p.hfovDeg <= 0 || p.hfovDeg >= 180
      || !(Number.isFinite(e.heightM) || Number.isFinite(e.aboveGroundM))) throw new Error(`Invalid camera for ${c.id}`);
  }
  return catalog.candidates;
}

/** A generated preview is a local content-addressed PNG record. */
export function previewUrl(candidate, catalogUrl) {
  const p = candidate?.preview;
  if (p?.status !== 'ready' || p.encoding !== 'png-base64' || typeof p.url !== 'string'
    || !/^previews\/[a-zA-Z0-9][a-zA-Z0-9._-]*-[a-f0-9]{12}\.json$/.test(p.url)) return null;
  const base = new URL('.', catalogUrl), url = new URL(p.url, base);
  return url.origin === base.origin && url.pathname.startsWith(`${base.pathname}previews/`) ? url.href : null;
}

export function previewForMode(candidate, mode = 'landscape') {
  return mode === 'shape' ? candidate?.preview?.shape || null : candidate?.preview || null;
}

function throwIfAborted(signal) { if (signal?.aborted) throw new DOMException('Preview request aborted', 'AbortError'); }

async function boundedPreviewText(response, signal) {
  if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
  const length = Number(response.headers?.get('content-length'));
  if (length > MAX_PREVIEW_BYTES) throw new Error('Preview response is too large');
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (raw.length > MAX_PREVIEW_BYTES || new TextEncoder().encode(raw).length > MAX_PREVIEW_BYTES) throw new Error('Preview response is too large');
    throwIfAborted(signal);
    return raw;
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PREVIEW_BYTES) throw new Error('Preview response is too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  throwIfAborted(signal);
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function decodePngPreview(raw, width, height) {
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error('Preview record is not JSON'); }
  const encoded = record?.png;
  if (typeof encoded !== 'string' || encoded.length > MAX_PREVIEW_BYTES || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid PNG preview encoding');
  let binary;
  try { binary = atob(encoded); } catch { throw new Error('Invalid PNG preview encoding'); }
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
    || ![73, 72, 68, 82].every((b, i) => bytes[i + 12] === b)) throw new Error('Invalid PNG preview signature');
  const view = new DataView(bytes.buffer), w = view.getUint32(16), h = view.getUint32(20);
  if (view.getUint32(8) !== 13 || !w || !h || w > 1024 || h > 1024 || w * h > 1024 * 1024
    || (Number.isFinite(width) && w !== width) || (Number.isFinite(height) && h !== height)) throw new Error('Invalid PNG preview dimensions');
  return { dataUrl: `data:image/png;base64,${encoded}`, bytes };
}

/** Only completed active previews enter a small LRU; no speculative fetches. */
export class PreviewCache {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), maxEntries = 8 } = {}) {
    this.fetchImpl = fetchImpl;
    this.limit = Math.max(1, Math.min(16, Math.floor(maxEntries) || 8));
    this.entries = new Map();
  }
  get size() { return this.entries.size; }
  async load(url, { signal, width, height, sha256 } = {}) {
    throwIfAborted(signal);
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) throw new Error('Invalid PNG preview hash');
    const expectedHash = sha256?.toLowerCase();
    const key = `${url}|${width || ''}x${height || ''}|${expectedHash || ''}`;
    if (this.entries.has(key)) {
      const value = this.entries.get(key);
      this.entries.delete(key); this.entries.set(key, value);
      return value;
    }
    const response = await this.fetchImpl(url, { signal, credentials: 'same-origin' });
    const decoded = decodePngPreview(await boundedPreviewText(response, signal), width, height);
    if (expectedHash) {
      if (!globalThis.crypto?.subtle) throw new Error('PNG preview hash verification is unavailable');
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', decoded.bytes));
      const actual = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
      if (actual !== expectedHash) throw new Error('PNG preview hash mismatch');
    }
    throwIfAborted(signal);
    const value = decoded.dataUrl;
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return value;
  }
}

export function parseReview(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_REVIEW_BYTES || new TextEncoder().encode(raw).length > MAX_REVIEW_BYTES) throw new Error('Review file is too large (16 MB maximum)');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Review file is not valid JSON'); }
  return reviewEnvelope(value);
}

function reviewEnvelope(value) {
  if (value?.schema !== SCHEMA || value.version !== 1 || !Array.isArray(value.decisions)
    || value.decisions.length > MAX_RECORDS || (value.outdatedDecisions !== undefined
      && (!Array.isArray(value.outdatedDecisions) || value.outdatedDecisions.length > MAX_RECORDS))) throw new Error('Unsupported review file format');
  return value;
}

function recordValid(r) {
  return r && safeId(r.id) && signature(r.signature) && (r.verdict === null || VERDICTS.has(r.verdict))
    && text(r.note, 2000);
}

function cleanFilter(value = {}) {
  return { status: STATUSES.has(value.status) ? value.status : 'unreviewed', region: text(value.region, 300) ? value.region : '', search: text(value.search, 300) ? value.search : '' };
}

export class ReviewSession {
  constructor(catalog, stored = null) {
    this.candidates = validateCatalog(catalog);
    this.byId = new Map(this.candidates.map(c => [c.id, c]));
    this.records = new Map();
    // Preserve the latest old judgment per candidate for portable recovery;
    // it never participates in filtering, counts or the active shortlist.
    this.outdatedRecords = new Map();
    this.filters = cleanFilter();
    this.displayMode = 'landscape';
    this.currentId = null;
    this.history = [];
    this.restoreWarning = '';
    this.restoreReport = null;
    if (stored) {
      try {
        const saved = typeof stored === 'string' ? parseReview(stored) : reviewEnvelope(stored);
        this.restoreReport = this.import(saved);
      } catch (error) { this.restoreWarning = error.message; }
    }
    this.reconcile();
  }

  decision(id) { return this.records.get(id) || null; }
  get current() { return this.byId.get(this.currentId) || null; }
  get queue() {
    const { status, region, search } = this.filters, needle = search.trim().toLocaleLowerCase();
    return this.candidates.filter(c => {
      const verdict = this.decision(c.id)?.verdict || 'unreviewed';
      return (status === 'all' || status === verdict) && (!region || region === c.region)
        && (!needle || `${c.name} ${c.region} ${candidateBiome(c)} ${c.landmark || ''} ${c.sourceRangeId || ''} ${c.sourceViewId || ''}`.toLocaleLowerCase().includes(needle));
    });
  }
  get counts() {
    const counts = { total: this.candidates.length, reviewed: 0, keep: 0, maybe: 0, pass: 0 };
    for (const r of this.records.values()) if (VERDICTS.has(r.verdict)) { counts[r.verdict]++; counts.reviewed++; }
    return counts;
  }
  reconcile() {
    const q = this.queue;
    if (!q.some(c => c.id === this.currentId)) this.currentId = q[0]?.id || null;
  }
  filter(patch) { this.filters = cleanFilter({ ...this.filters, ...patch }); this.reconcile(); }
  setDisplayMode(mode) { if (DISPLAY_MODES.has(mode)) this.displayMode = mode; }
  move(direction) {
    const q = this.queue, index = q.findIndex(c => c.id === this.currentId);
    this.currentId = q[Math.max(0, Math.min(q.length - 1, index + Math.sign(direction)))]?.id || null;
  }
  note(value) {
    const c = this.current;
    if (!c || typeof value !== 'string') return;
    this.records.set(c.id, { id: c.id, signature: c.signature, verdict: this.decision(c.id)?.verdict || null, note: value.slice(0, 2000) });
  }
  decide(verdict) {
    const c = this.current;
    if (!c || !VERDICTS.has(verdict)) return;
    const oldQueue = this.queue, oldIndex = oldQueue.findIndex(v => v.id === c.id);
    this.history.push({ id: c.id, prior: this.decision(c.id) ? { ...this.decision(c.id) } : null, filters: { ...this.filters } });
    if (this.history.length > 100) this.history.shift();
    this.records.set(c.id, { id: c.id, signature: c.signature, verdict, note: this.decision(c.id)?.note || '' });
    const eligible = new Set(this.queue.map(v => v.id));
    const next = oldQueue.slice(oldIndex + 1).find(v => eligible.has(v.id));
    this.currentId = next?.id || (eligible.has(c.id) ? c.id : oldQueue.slice(0, oldIndex).reverse().find(v => eligible.has(v.id))?.id) || null;
  }
  undo() {
    const change = this.history.pop();
    if (!change) return false;
    if (change.prior) this.records.set(change.id, change.prior); else this.records.delete(change.id);
    this.filters = change.filters;
    this.currentId = change.id;
    this.reconcile();
    return true;
  }
  import(value) {
    const saved = typeof value === 'string' ? parseReview(value) : reviewEnvelope(value);
    const seen = new Set();
    let accepted = 0, ignored = 0, outdated = 0;
    for (const r of saved.outdatedDecisions || []) {
      if (recordValid(r) && this.byId.has(r.id) && this.byId.get(r.id).signature !== r.signature) this.outdatedRecords.set(r.id, { id: r.id, signature: r.signature, verdict: r.verdict, note: r.note });
    }
    for (const r of saved.decisions) {
      const c = r && this.byId.get(r.id);
      if (recordValid(r) && c && c.signature !== r.signature) {
        this.outdatedRecords.set(r.id, { id: r.id, signature: r.signature, verdict: r.verdict, note: r.note });
        ignored++; outdated++; continue;
      }
      if (!recordValid(r) || !c || c.signature !== r.signature || seen.has(r.id)) { ignored++; continue; }
      seen.add(r.id);
      this.records.set(r.id, { id: r.id, signature: r.signature, verdict: r.verdict, note: r.note });
      accepted++;
    }
    this.setDisplayMode(saved.displayMode);
    this.history = [];
    if (saved.filters && typeof saved.filters === 'object') {
      this.filters = cleanFilter(saved.filters);
      if (this.filters.region && !this.candidates.some(c => c.region === this.filters.region)) this.filters.region = '';
    }
    if (safeId(saved.currentId) && this.byId.has(saved.currentId)) this.currentId = saved.currentId;
    this.reconcile();
    return { accepted, ignored, outdated };
  }
  snapshot() {
    return { schema: SCHEMA, version: 1, currentId: this.currentId, filters: { ...this.filters }, displayMode: this.displayMode,
      decisions: [...this.records.values()].map(r => ({ ...r })), outdatedDecisions: [...this.outdatedRecords.values()].map(r => ({ ...r })) };
  }
  shortlist() {
    return { schema: 'midio.view-discovery-shortlist', version: 1, purpose: 'Candidate camera selections for further terrain and rendering review; no production approval.', candidates: this.candidates.filter(c => ['keep', 'maybe'].includes(this.decision(c.id)?.verdict)).map(c => ({ ...c, camera: structuredClone(c.camera), review: { ...this.decision(c.id) } })) };
  }
}
