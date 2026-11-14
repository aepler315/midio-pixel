// The page's settings store: the effective value of every definition in
// settingsRegistry.js, why it was chosen, and which changes are still
// waiting for their lifecycle boundary. One instance per page, created on
// first use from the page URL and localStorage, so modules that read a
// setting at import time see the same answer as the settings panel.
//
// Reading is a property lookup on a plain object (safe in frame loops);
// nothing here parses the URL or touches storage after construction except
// an explicit set/reset/save.
import {
  SETTINGS, LIFECYCLES, settingDefinition, resolveSettings, normalizeValue, writeSaved, defaultValue,
  formatUrlValue, disabledReason, shareUrl, withParam, urlSettingValue, CAMERA_STUDIO_FIELDS,
} from './settingsRegistry.js';

/** Lifecycles that never wait: the change is applied by its listener. */
const IMMEDIATE = new Set(['live', 'next-landscape']);

function pageStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
function pageHistory() {
  const loc = globalThis.location;
  if (!loc?.href || !/^https?:|^file:/.test(loc.href)) return null;
  return {
    href: () => globalThis.location.href,
    replace: href => { try { globalThis.history?.replaceState(globalThis.history.state, '', href); } catch { /* sandboxed */ } },
  };
}

export class SettingsStore {
  constructor({ search = '', storage = null, env = {}, history = null } = {}) {
    this.storage = storage;
    this.env = env;
    this.history = history;
    const { entries, unknown, retired } = resolveSettings({ search, storage, env });
    this.entries = entries;
    this.unknown = unknown;
    this.retired = retired;
    /** Effective values by id: the hot-path read. */
    this.values = Object.fromEntries(Object.values(entries).map(e => [e.id, e.value]));
    /** The values the running page was started with, for "pending" reports. */
    this.initial = { ...this.values };
    this.pending = new Map();
    this.context = { playing: false };
    this._listeners = new Set();
    this._guards = new Set();
  }

  get(id) {
    if (!(id in this.values)) settingDefinition(id);
    return this.values[id];
  }

  entry(id) { return this.entries[settingDefinition(id).id]; }

  /** `playing` (a boolean or a function returning one) says whether a song
   *  is running; it decides whether a scene/renderer/next-song change is
   *  pending or simply ahead. */
  setContext(context) { Object.assign(this.context, context); }

  get playing() { return typeof this.context.playing === 'function' ? !!this.context.playing() : !!this.context.playing; }

  /** `guard(id, value)` returns a reason to refuse a change, or null. */
  addGuard(guard) { this._guards.add(guard); return () => this._guards.delete(guard); }

  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }

  disabledReason(id) { return disabledReason(settingDefinition(id), this.values); }

  /**
   * Change one setting as the user (or a test) asks. Validates, persists by
   * the definition's policy, drops a URL override it supersedes, records a
   * pending change when the lifecycle cannot apply now, and notifies.
   * Returns { ok, changed, value, lifecycle, reason }.
   */
  set(id, value, { origin = 'user', persist = true } = {}) {
    const def = settingDefinition(id);
    const normalized = normalizeValue(def, value);
    if (normalized === undefined) return { ok: false, changed: false, reason: `invalid value for ${def.label}` };
    const reason = this._guardReason(id, normalized);
    if (reason) return { ok: false, changed: false, reason };
    return this._commit(def, normalized, { origin, persist });
  }

  _guardReason(id, value) {
    for (const guard of this._guards) {
      const reason = guard(id, value);
      if (reason) return reason;
    }
    return null;
  }

  /** Commit only after validation/guards (or reset-all preflight) succeeded. */
  _commit(def, normalized, { origin, persist }) {
    const id = def.id;
    const entry = this.entries[id];
    const previous = this.values[id];
    const changed = !Object.is(previous, normalized);
    entry.value = normalized;
    entry.rejected = null;
    this.values[id] = normalized;
    if (persist) this._persist(def, normalized);
    entry.source = origin === 'default' ? 'default' : def.persist === 'url' ? (Object.is(normalized, entry.default) ? 'default' : 'url')
      : def.persist === 'saved' && persist ? 'saved' : 'session';
    const changes = [];
    if (changed) { this._track(def, normalized); changes.push({ id, value: normalized, previous, lifecycle: def.lifecycle, origin }); }
    // Coupled settings change in the same notification, after the primary.
    if (changed && def.couples) {
      for (const [otherId, otherValue] of Object.entries(def.couples(normalized))) {
        const other = settingDefinition(otherId);
        const before = this.values[otherId];
        if (Object.is(before, otherValue)) continue;
        this.values[otherId] = otherValue;
        Object.assign(this.entries[otherId], { value: otherValue, rejected: null, source: persist && other.persist === 'saved' ? 'saved' : 'session' });
        if (persist) this._persist(other, otherValue);
        this._track(other, otherValue);
        changes.push({ id: otherId, value: otherValue, previous: before, lifecycle: other.lifecycle, origin });
      }
    }
    if (changes.length) this._emit(changes);
    return { ok: true, changed, value: normalized, lifecycle: def.lifecycle };
  }

  /** Back to the default: refuse a guarded change before touching any
   * saved preference, URL parameter, source metadata or live consumer. */
  reset(id) {
    const def = settingDefinition(id);
    const reason = this._guardReason(id, defaultValue(def, this.env));
    if (reason) return { ok: false, changed: false, reason };
    return this._reset(def);
  }

  _reset(def) {
    try { def.storage?.clear?.(this.storage); } catch { /* blocked storage */ }
    this._dropUrl(def);
    return this._commit(def, defaultValue(def, this.env), { origin: 'default', persist: !def.storage?.clear });
  }

  resetAll({ includeDeveloper = true } = {}) {
    const eligible = SETTINGS.filter(def => def.ui && (includeDeveloper || !['developer', 'experimental'].includes(def.tier)));
    // Preflight the whole reset before any mutation. Include default-valued
    // definitions because resetting a coupled setting can change them too.
    for (const def of eligible) {
      const reason = this._guardReason(def.id, defaultValue(def, this.env));
      if (reason) return { ok: false, changed: false, reason };
    }
    const ids = [];
    for (const def of eligible) {
      if (this.entries[def.id].rejected || this.entries[def.id].source !== 'default' || !Object.is(this.values[def.id], this.entries[def.id].default)) {
        this._reset(def);
        ids.push(def.id);
      }
    }
    return { ok: true, changed: ids.length > 0, ids };
  }

  /** Make every saved-policy URL override a saved preference, and clear it
   *  from the address bar. Temporary overrides are never saved implicitly. */
  saveUrlOverrides() {
    const saved = [];
    for (const def of SETTINGS) {
      const entry = this.entries[def.id];
      if (entry.source !== 'url' || def.persist !== 'saved') continue;
      if (this._guardReason(def.id, entry.value) || !writeSaved(def, this.storage, entry.value)) continue;
      entry.source = 'saved';
      saved.push(def.id);
      this._dropUrl(def);
    }
    return saved;
  }

  /** Clear the pending marks of changes the app has now applied. */
  markApplied(lifecycles) {
    const set = new Set(lifecycles);
    let changed = false;
    for (const [id, p] of this.pending) if (set.has(p.lifecycle)) { this.pending.delete(id); changed = true; }
    if (changed) this._emit([]);
  }

  overrides() {
    return Object.values(this.entries).filter(e => e.source === 'url').map(e => e.id);
  }

  shareUrl(href = this.history?.href?.() || 'http://localhost/') {
    return shareUrl(href, this.values, { env: this.env });
  }

  /** A JSON-able account of the requested and effective configuration. No
   *  credentials, filenames or library data are registered settings. */
  describe() {
    return {
      settings: Object.values(this.entries).map(e => ({
        id: e.id, value: e.value, default: e.default, source: e.source,
        ...(e.requested != null ? { requested: e.requested } : {}),
        ...(e.rejected ? { rejected: e.rejected } : {}),
        ...(this.disabledReason(e.id) ? { disabled: this.disabledReason(e.id) } : {}),
      })),
      pending: [...this.pending].map(([id, p]) => ({ id, lifecycle: p.lifecycle, value: this.values[id], startedWith: this.initial[id] })),
      unknownParams: this.unknown,
      retiredParams: this.retired,
    };
  }

  _persist(def, value) {
    if (def.persist === 'saved') {
      writeSaved(def, this.storage, value);
      this._dropUrl(def);
    } else if (def.persist === 'url' && this.history && def.url) {
      const isDefault = Object.is(value, defaultValue(def, this.env)) || value == null;
      this.history.replace(withParam(this.history.href(), def.url, isDefault ? undefined : formatUrlValue(def, value)));
    }
  }

  _dropUrl(def) {
    delete this.entries[def.id].requested;
    this.entries[def.id].rejected = null;
    if (!this.history || !def.url) return;
    const href = this.history.href();
    if (new URL(href).searchParams.has(def.url)) this.history.replace(withParam(href, def.url, undefined));
  }

  _track(def, value) {
    const lc = def.lifecycle;
    if (IMMEDIATE.has(lc)) return;
    const waiting = lc === 'reload' ? !Object.is(value, this.initial[def.id]) : this.playing;
    if (waiting) this.pending.set(def.id, { lifecycle: lc, since: Date.now() });
    else this.pending.delete(def.id);
  }

  _emit(changes) {
    for (const listener of this._listeners) {
      try { listener({ changes, store: this }); } catch (err) { console.warn('[settings] listener failed', err); }
    }
  }
}

let instance = null;

/** The page's store, resolved on first use. */
export function appSettings() {
  return instance ??= new SettingsStore({
    search: globalThis.location?.search || '', storage: pageStorage(), history: pageHistory(),
  });
}

/** Replace the page store (tests and tools). */
export function configureSettings(options = {}) {
  instance = new SettingsStore(options);
  return instance;
}

/**
 * The value a subsystem should use. With no `search`, the page store's
 * effective value (URL, then saved, then default). With an explicit search
 * string, that string alone decides, as the historical parsers did.
 */
export function settingValue(id, search) {
  return search === undefined ? appSettings().get(id) : urlSettingValue(id, search);
}

/** The resolution entry ({ value, source, requested, rejected, ... }) for
 *  the page store, or for an explicit search string alone. */
export function settingEntry(id, search) {
  return search === undefined ? appSettings().entry(id) : resolveSettings({ search, ids: [id] }).entries[id];
}

/** Everything a diagnostic needs to know about one setting's value. */
export function explainSetting(id, store = appSettings()) {
  const def = settingDefinition(id);
  const e = store.entry(id);
  const pending = store.pending.get(id);
  return {
    id, label: def.label, value: e.value, default: e.default, source: e.source,
    requested: e.requested, rejected: e.rejected, disabled: store.disabledReason(id),
    lifecycle: LIFECYCLES[def.lifecycle].label, pending: pending ? LIFECYCLES[pending.lifecycle].short : null,
  };
}

/** The immutable composition consumed by live playback and export snapshots. */
export function cameraStudioPreferences(store = appSettings()) {
  return Object.freeze(Object.fromEntries(CAMERA_STUDIO_FIELDS.map(def => [def.field, store.get(def.id)])));
}

/** Dedicated Camera Studio controls use the same validated store as Settings. */
export function setCameraStudioPreferences(preferences, store = appSettings()) {
  const results = [];
  for (const def of CAMERA_STUDIO_FIELDS) {
    if (Object.hasOwn(preferences, def.field) && !Object.is(store.get(def.id), preferences[def.field])) {
      results.push(store.set(def.id, preferences[def.field], { origin: 'cameraStudio' }));
    }
  }
  return results.every(result => result.ok);
}
