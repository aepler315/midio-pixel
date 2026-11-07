import { CAMERA_FIELDS, defaultCamera, normalizeCamera } from './CameraEditor.js';

export const STUDIO_STORAGE_KEY = 'midio.terrain-studio.v1';
export const MAX_STUDIO_BYTES = 4 * 1024 * 1024;

const SCHEMA = 'midio.terrain-studio';
const MAX_DRAFTS = 1000;
const MAX_PRESETS = 100;
const MAX_HISTORY = 60;
const LOCK_KEYS = new Set([...CAMERA_FIELDS.map(field => field.key), 'aimMode', 'heightM']);
const safeId = value => typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const signatureValid = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byteLength = value => new TextEncoder().encode(value).byteLength;
const normalizeLocks = value => Array.isArray(value) ? [...new Set(value.filter(key => LOCK_KEYS.has(key)))].sort() : [];

function parseDocument(raw) {
  let json;
  try { json = typeof raw === 'string' ? raw : JSON.stringify(raw); }
  catch { throw new Error('Invalid Terrain Studio project document'); }
  if (typeof json !== 'string') throw new Error('Invalid Terrain Studio project document');
  if (json.length > MAX_STUDIO_BYTES || byteLength(json) > MAX_STUDIO_BYTES) throw new Error('Terrain Studio project exceeds the 4 MB import limit');
  let document;
  try { document = JSON.parse(json); }
  catch { throw new Error('Invalid Terrain Studio project JSON'); }
  if (!object(document) || document.schema !== SCHEMA || document.version !== 1
    || !Array.isArray(document.drafts) || !Array.isArray(document.presets)) throw new Error('Unsupported Terrain Studio project format');
  if (document.drafts.length > MAX_DRAFTS || document.presets.length > MAX_PRESETS) throw new Error('Terrain Studio project contains too many drafts or presets');
  return document;
}

function importedSettings(value, candidate) {
  if (!object(value) || !['heading', 'target'].includes(value.aimMode)) return null;
  if (!CAMERA_FIELDS.every(field => typeof value[field.key] === 'number' && Number.isFinite(value[field.key]))) return null;
  if (value.heightM !== undefined && (typeof value.heightM !== 'number' || !Number.isFinite(value.heightM))) return null;
  return normalizeCamera(value, candidate);
}

/** Camera working copies and personal presets. These documents confer no runtime approval. */
export class StudioProjects {
  constructor({ storage = null, candidates = [] } = {}) {
    this.storage = storage;
    this.warning = '';
    this.byId = new Map();
    for (const candidate of candidates) {
      if (!candidate || !safeId(candidate.id) || !signatureValid(candidate.signature)) continue;
      if (this.byId.has(candidate.id)) throw new Error(`Duplicate Studio candidate ${candidate.id}`);
      this.byId.set(candidate.id, candidate);
    }
    this.drafts = new Map();
    this.savedPresets = new Map();
    this.sequence = 0;
  }

  _candidate(value) {
    const candidate = this.byId.get(typeof value === 'string' ? value : value?.id);
    if (!candidate || (typeof value !== 'string' && value?.signature !== candidate.signature)) throw new Error('Unknown or changed Studio candidate source');
    return candidate;
  }

  _entry(value) {
    const candidate = this._candidate(value);
    let entry = this.drafts.get(candidate.id);
    if (!entry) {
      if (this.drafts.size >= MAX_DRAFTS) throw new Error('Terrain Studio supports at most 1000 working drafts');
      entry = { candidateId: candidate.id, signature: candidate.signature, settings: defaultCamera(candidate), locks: [], undo: [], redo: [], group: null };
      this.drafts.set(candidate.id, entry);
    }
    return entry;
  }

  _change(entry, settings, { coalesce = false, group = null } = {}) {
    if (same(entry.settings, settings)) {
      if (!coalesce) entry.group = null;
      return false;
    }
    if (!coalesce || !group || entry.group !== group || !entry.undo.length) {
      entry.undo.push(copy(entry.settings));
      if (entry.undo.length > MAX_HISTORY) entry.undo.shift();
    }
    entry.settings = copy(settings);
    entry.redo = [];
    entry.group = group;
    return true;
  }

  draft(candidate) { return copy(this._entry(candidate).settings); }

  edit(candidate, patch, { coalesce = false } = {}) {
    if (!object(patch)) throw new Error('Camera edits require an object');
    const source = this._candidate(candidate);
    const entry = this._entry(source);
    const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => LOCK_KEYS.has(key) && !entry.locks.includes(key)));
    const group = Object.keys(allowed).sort().join(',');
    const updated = { ...entry.settings, ...allowed };
    if (Object.hasOwn(allowed, 'aboveGroundM') && !Object.hasOwn(allowed, 'heightM') && !entry.locks.includes('heightM')) delete updated.heightM;
    if (this._change(entry, normalizeCamera(updated, source), { coalesce, group })) this.save();
    return copy(entry.settings);
  }

  canUndo(candidate) { return Boolean(this.drafts.get(this._candidate(candidate).id)?.undo.length); }
  canRedo(candidate) { return Boolean(this.drafts.get(this._candidate(candidate).id)?.redo.length); }

  undo(candidate) {
    const entry = this._entry(candidate);
    if (entry.undo.length) {
      entry.redo.push(copy(entry.settings));
      entry.settings = entry.undo.pop();
      entry.group = null;
      this.save();
    }
    return copy(entry.settings);
  }

  redo(candidate) {
    const entry = this._entry(candidate);
    if (entry.redo.length) {
      entry.undo.push(copy(entry.settings));
      entry.settings = entry.redo.pop();
      entry.group = null;
      this.save();
    }
    return copy(entry.settings);
  }

  locks(candidate) { return [...this._entry(candidate).locks]; }

  toggleLock(candidate, key) {
    if (!LOCK_KEYS.has(key)) throw new Error('Unknown camera lock');
    const entry = this._entry(candidate);
    entry.locks = normalizeLocks(entry.locks.includes(key) ? entry.locks.filter(item => item !== key) : [...entry.locks, key]);
    entry.group = null;
    this.save();
    return [...entry.locks];
  }

  savePreset(candidate, name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give the preset a name');
    if (this.savedPresets.size >= MAX_PRESETS) throw new Error('Terrain Studio supports at most 100 presets; delete a preset first');
    const entry = this._entry(candidate);
    const id = globalThis.crypto?.randomUUID?.() || `preset-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    const preset = { id, name: name.trim().slice(0, 120), candidateId: entry.candidateId, signature: entry.signature,
      settings: copy(entry.settings), locks: [...entry.locks], createdAt: Date.now() };
    this.savedPresets.set(id, preset);
    entry.group = null;
    this.save();
    return copy(preset);
  }

  presets(candidateId = null) {
    const id = object(candidateId) ? candidateId.id : candidateId;
    return [...this.savedPresets.values()].filter(preset => id === null || preset.candidateId === id).map(copy);
  }

  applyPreset(presetId, candidate) {
    const preset = this.savedPresets.get(presetId);
    const source = this._candidate(candidate);
    if (!preset || preset.candidateId !== source.id || preset.signature !== source.signature) throw new Error('Preset does not match this candidate source');
    const entry = this._entry(source);
    this._change(entry, preset.settings);
    entry.group = null;
    entry.locks = [...preset.locks];
    this.save();
    return copy(entry.settings);
  }

  deletePreset(id) {
    const removed = this.savedPresets.delete(id);
    if (removed) this.save();
    return removed;
  }

  snapshot() {
    return { schema: SCHEMA, version: 1,
      drafts: [...this.drafts.values()].map(entry => ({ candidateId: entry.candidateId, signature: entry.signature,
        settings: copy(entry.settings), locks: [...entry.locks] })),
      presets: this.presets() };
  }

  _import(raw) {
    const document = parseDocument(raw);
    const drafts = new Map(this.drafts);
    const presets = new Map(this.savedPresets);
    const seenDrafts = new Set();
    const seenPresets = new Set();
    let accepted = 0;
    let ignored = 0;
    for (const record of document.drafts) {
      const candidate = object(record) ? this.byId.get(record.candidateId) : null;
      const settings = candidate && candidate.signature === record.signature ? importedSettings(record.settings, candidate) : null;
      if (!settings || seenDrafts.has(candidate.id) || !Array.isArray(record.locks)) { ignored++; continue; }
      seenDrafts.add(candidate.id);
      drafts.set(candidate.id, { candidateId: candidate.id, signature: candidate.signature, settings, locks: normalizeLocks(record.locks), undo: [], redo: [], group: null });
      accepted++;
    }
    for (const record of document.presets) {
      const candidate = object(record) ? this.byId.get(record.candidateId) : null;
      const settings = candidate && candidate.signature === record.signature ? importedSettings(record.settings, candidate) : null;
      const existing = object(record) ? presets.get(record.id) : null;
      if (!settings || !safeId(record.id) || seenPresets.has(record.id) || typeof record.name !== 'string' || !record.name.trim()
        || record.name.length > 120 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Array.isArray(record.locks)
        || (existing && (existing.candidateId !== candidate.id || existing.signature !== candidate.signature))) { ignored++; continue; }
      seenPresets.add(record.id);
      presets.set(record.id, { id: record.id, name: record.name.trim(), candidateId: candidate.id, signature: candidate.signature,
        settings, locks: normalizeLocks(record.locks), createdAt: record.createdAt });
      accepted++;
    }
    if (drafts.size > MAX_DRAFTS || presets.size > MAX_PRESETS) throw new Error('Merged Terrain Studio project exceeds the draft or preset limit');
    const merged = { schema: SCHEMA, version: 1,
      drafts: [...drafts.values()].map(({ candidateId, signature, settings, locks }) => ({ candidateId, signature, settings, locks })),
      presets: [...presets.values()] };
    if (byteLength(JSON.stringify(merged)) > MAX_STUDIO_BYTES) throw new Error('Merged Terrain Studio project exceeds the 4 MB limit');
    this.drafts = drafts;
    this.savedPresets = presets;
    return { accepted, ignored };
  }

  import(raw) {
    const report = this._import(raw);
    this.save();
    return report;
  }

  load() {
    if (!this.storage || typeof this.storage.getItem !== 'function') {
      this.warning = 'Local saving is unavailable. Export your project to keep a portable copy.';
      return { accepted: 0, ignored: 0, warning: this.warning };
    }
    try {
      const raw = this.storage.getItem(STUDIO_STORAGE_KEY);
      const report = raw === null ? { accepted: 0, ignored: 0 } : this._import(raw);
      this.warning = '';
      return { ...report, warning: this.warning };
    } catch (error) {
      this.warning = `Could not restore locally saved Terrain Studio work: ${error.message || 'storage unavailable'}. Export your current project to keep it.`;
      return { accepted: 0, ignored: 0, warning: this.warning };
    }
  }

  save() {
    try {
      if (!this.storage || typeof this.storage.setItem !== 'function') throw new Error('local storage is unavailable');
      const json = JSON.stringify(this.snapshot());
      if (byteLength(json) > MAX_STUDIO_BYTES) throw new Error('the project exceeds the 4 MB local saving limit');
      this.storage.setItem(STUDIO_STORAGE_KEY, json);
      this.warning = '';
      return true;
    } catch (error) {
      this.warning = `Could not save Terrain Studio work locally: ${error.message || 'storage unavailable'}. Export your project to keep it.`;
      return false;
    }
  }
}
