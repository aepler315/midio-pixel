// Tracked graphics ownership (Range v2, plan §7.3). One budget covers every
// decoded image, GPU texture (mips included), mesh buffer, offscreen canvas,
// render target, performer buffer and pending decode/upload that Range
// presentation owns -- the legacy terrain strips included, so a fallback
// never gets a second, independent allowance.
//
// Protocol: reserve() BEFORE creating or decoding anything. A reservation is
// pending bytes; commit() turns it into live ownership without counting it
// twice. A denied reservation (null) means reuse, lower detail, delay or an
// explicit fallback -- never allocate anyway. Pinned keys (the current frame
// and a scheduled transition) are never evicted. Cancelling a generation
// voids its pending work: a late commit disposes its resource immediately
// instead of publishing it. Every resource is released through exactly one
// owner, and release is idempotent.
//
// A reservation carries an opaque identity: commit() and releaseReservation()
// act only on the exact reservation they were handed, so a late commit for a
// key that was released and reserved again disposes its stale resource
// instead of publishing over (or deleting) the newer reservation. retain()
// is a reference-counted hold; named holders allow pressure eviction only
// after all evictable holders have retired; explicit release,
// context loss and generation cancellation still release it.
//
// These are ownership estimates, not browser process memory or exact GPU
// residency; driver overhead needs device observation.

export const MiB = 1024 * 1024;
// Budgets follow reported device memory. The Teton tour needs room for the
// active, next and second-ahead 8-second windows on top of its base scene,
// and the base alone measured ~208 MiB on a 2560x1440 stage served without
// cross-origin isolation (render targets and the worker's own terrain copy
// grow with it), so a fixed 256 MiB left no room for the next window and the
// tour lost its trees. Devices reporting less than 8 GB keep the old ledgers.
export const RESIDENCY_BUDGETS = Object.freeze({ desktop: 512 * MiB, mobile: 320 * MiB });
export const LOW_MEMORY_BUDGETS = Object.freeze({ desktop: 256 * MiB, mobile: 192 * MiB });

/** Pick the budget for this device. Conservative: anything that looks like a
 *  phone/tablet or reports <= 4 GB is mobile. A phone gets the larger ledger
 *  only when it reports >= 8 GB; a desktop unless it reports < 8 GB (Firefox
 *  and Safari report nothing). */
export function residencyBudgetFor(env = globalThis) {
  try {
    const nav = env.navigator || {};
    const mem = Number(nav.deviceMemory);
    const known = Number.isFinite(mem);
    const touch = (nav.maxTouchPoints || 0) > 1;
    const small = Math.min(env.screen?.width || 1920, env.screen?.height || 1080) < 820;
    const name = (known && mem <= 4) || (touch && (small || !known)) ? 'mobile' : 'desktop';
    const roomy = name === 'mobile' ? known && mem >= 8 : !(known && mem < 8);
    return { name, bytes: (roomy ? RESIDENCY_BUDGETS : LOW_MEMORY_BUDGETS)[name] };
  } catch { /* default below */ }
  return { name: 'desktop', bytes: RESIDENCY_BUDGETS.desktop };
}

export class GraphicsResidency {
  constructor({ budgetBytes = RESIDENCY_BUDGETS.desktop, name = 'desktop' } = {}) {
    this.budgetBytes = budgetBytes;
    this.name = name;
    this.entries = new Map(); // key -> entry
    this.pinned = new Set();
    this.cancelled = new Set();
    this.tick = 0;
    this.denials = 0;
    this.nextId = 0;
    this.resetPeak();
  }

  /** Start a new high-water window (a device probe calls this when it
   *  starts recording). */
  resetPeak() {
    this.peakBytes = -1;
    this._notePeak();
  }

  /** Ownership can peak and fall inside one task (a scratch buffer reserved
   *  and released during a bake), so the high-water mark is recorded when
   *  ownership grows, not sampled. The owner breakdown is copied only on a
   *  new peak. */
  _notePeak() {
    const used = this.usedBytes;
    if (used <= this.peakBytes) return;
    this.peakBytes = used;
    const by = {};
    for (const e of this.entries.values()) by[e.owner] = (by[e.owner] || 0) + e.bytes;
    this.peakByOwner = by;
  }

  get pendingBytes() { let s = 0; for (const e of this.entries.values()) if (e.state === 'pending') s += e.bytes; return s; }
  get liveBytes() { let s = 0; for (const e of this.entries.values()) if (e.state === 'live') s += e.bytes; return s; }
  get usedBytes() { return this.pendingBytes + this.liveBytes; }
  has(key) { return this.entries.has(key); }
  get(key) {
    const e = this.entries.get(key);
    if (!e || e.state !== 'live') return undefined;
    e.used = ++this.tick;
    return e.resource;
  }

  /** Bytes eviction could free right now without touching `protect`. */
  _evictable(protect) {
    let s = 0;
    for (const [k, e] of this.entries) if (this._canEvict(k, e, protect)) s += e.bytes;
    return s;
  }

  _canEvict(k, e, protect, visiting = new Set()) {
    if (e.state !== 'live' || !e.evictable || this.pinned.has(k) || protect.has(k) || visiting.has(k)) return false;
    if (!e.retains) return true;
    if (e.holders?.size !== e.retains) return false; // anonymous holds stay protected
    visiting.add(k);
    const available = [...e.holders.values()].every(hold => {
      const holder = this.entries.get(hold.key);
      if (!holder || (hold.id != null && holder.id !== hold.id)) return false;
      hold.id ??= holder.id;
      return this._canEvict(hold.key, holder, protect, visiting);
    });
    visiting.delete(k);
    return available;
  }

  /**
   * Ask for `bytes` of ownership. Returns a Reservation or null. May evict
   * least-recently-used, unpinned, evictable live entries -- but only when
   * that is enough; a denial evicts nothing.
   */
  reserve({ key, bytes, owner, generation = 0, evictable = true, protect = [] }) {
    if (typeof key !== 'string' || !key) throw new Error('reservation key required');
    if (this.entries.has(key)) throw new Error(`reservation ${key} already exists; reuse or release it first`);
    const want = Math.max(0, Math.ceil(Number(bytes) || 0));
    if (this.cancelled.has(generation)) return null;
    const keep = new Set(protect);
    const over = this.usedBytes + want - this.budgetBytes;
    if (over > 0 && this._evictable(keep) < over) { this.denials++; return null; }
    while (this.usedBytes + want > this.budgetBytes) {
      let victim = null;
      for (const [k, e] of this.entries) {
        if (e.retains || !this._canEvict(k, e, keep)) continue;
        if (!victim || e.used < victim[1].used) victim = [k, e];
      }
      this.release(victim[0]);
    }
    const id = ++this.nextId;
    const entry = { key, id, bytes: want, owner: owner || 'unknown', generation, evictable, state: 'pending', used: ++this.tick, resource: null, dispose: null, retains: 0 };
    this.entries.set(key, entry);
    this._notePeak();
    return { key, id, bytes: want, owner: entry.owner, generation };
  }

  /** Whether `bytes` could be reserved now (evicting what may be evicted). */
  canFit(bytes, protect = []) {
    const over = this.usedBytes + Math.max(0, Number(bytes) || 0) - this.budgetBytes;
    return over <= 0 || this._evictable(new Set(protect)) >= over;
  }

  /**
   * Record memory that already exists (the legacy strip bake allocates
   * layer by layer before it can publish). Accounted truthfully even when
   * it exceeds the budget; `overcommits` makes that visible in diagnostics
   * instead of hiding it. New Range v2 code uses reserve()/commit().
   */
  adopt({ key, bytes, owner, generation = 0, resource = null, dispose = null, evictable = false }) {
    this.release(key);
    const want = Math.max(0, Math.ceil(Number(bytes) || 0));
    if (this.usedBytes + want > this.budgetBytes) this.overcommits = (this.overcommits || 0) + 1;
    this.entries.set(key, { key, id: ++this.nextId, bytes: want, owner: owner || 'unknown', generation, evictable: !!evictable, state: 'live', used: ++this.tick, resource, dispose, retains: 0 });
    this._notePeak();
  }

  /** The entry this exact reservation still owns, or undefined. */
  _own(reservation) {
    const e = reservation && this.entries.get(reservation.key);
    return e && (reservation.id === undefined || e.id === reservation.id) ? e : undefined;
  }

  /** Pending -> live. Returns false (and disposes `resource`) when the
   *  reservation was cancelled or released meanwhile -- including when its
   *  key has since been reserved again by someone else, whose reservation
   *  is left untouched. */
  commit(reservation, resource, dispose = null) {
    const e = this._own(reservation);
    if (!e || e.state !== 'pending' || this.cancelled.has(e.generation)) {
      if (e && e.state === 'pending') this.entries.delete(e.key);
      try { dispose?.(resource); } catch { /* disposal must not throw into the caller */ }
      return false;
    }
    e.state = 'live';
    e.resource = resource;
    e.dispose = dispose;
    e.used = ++this.tick;
    return true;
  }

  /** Release what one reservation owns (pending or committed), and nothing
   *  else: a newer reservation of the same key is left alone. Idempotent;
   *  true when something was released. For asynchronous cleanup. */
  releaseReservation(reservation) {
    return this._own(reservation) ? this.release(reservation.key) : false;
  }

  /** Hold `key` against pressure eviction until the returned function is
   *  called (reference counted, independent of pin()). Null when the key is
   *  not live. The release function is idempotent and affects only the
   *  exact entry retained, never a later entry under the same key. */
  retain(key, holderKey = null) {
    const e = this.entries.get(key);
    if (!e || e.state !== 'live') return null;
    e.retains++;
    const hold = holderKey ? { key: holderKey, id: this.entries.get(holderKey)?.id } : null;
    if (hold) { e.holders ||= new Map(); e.holders.set(hold, hold); }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (e.retains > 0) e.retains--;
      if (hold) e.holders.delete(hold);
    };
  }

  /** Drop a charge for temporary bytes that no longer have an owner. */
  shrink(key, bytes) {
    const entry = this.entries.get(key), next = Math.ceil(bytes);
    if (!entry || !Number.isFinite(next) || next < 0 || next > entry.bytes) return false;
    entry.bytes = next;
    return true;
  }

  /** Move a live or pending entry to another generation (a resource the
   *  next song keeps must not fall with the previous song's cancellation). */
  retag(key, generation) {
    const e = this.entries.get(key);
    if (!e) return false;
    e.generation = generation;
    return true;
  }

  /** Replace the pinned set (current frame + scheduled transition). */
  pin(keys) { this.pinned = new Set([...(keys || [])].filter(Boolean)); }

  /** Release one key: pending work is voided, live resources disposed.
   *  Idempotent. */
  release(key) {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.pinned.delete(key);
    if (e.state === 'live' && e.dispose) {
      try { e.dispose(e.resource); } catch (err) { console.warn('[residency] dispose failed', key, err); }
    }
    return true;
  }

  /** Void a generation: its pending reservations free their bytes now (a
   *  later commit disposes instead of publishing) and its unpinned live
   *  resources are released. */
  cancelGeneration(generation) {
    this.cancelled.add(generation);
    for (const [k, e] of [...this.entries]) {
      if (e.generation !== generation) continue;
      if (e.state === 'pending') this.entries.delete(k);
      else if (!this.pinned.has(k)) this.release(k);
    }
  }

  releaseOwner(owner) {
    for (const [k, e] of [...this.entries]) if (e.owner === owner) this.release(k);
  }

  snapshot() {
    const byOwner = {};
    for (const e of this.entries.values()) {
      const o = byOwner[e.owner] || (byOwner[e.owner] = { pending: 0, live: 0, count: 0 });
      o[e.state] += e.bytes;
      o.count++;
    }
    return {
      budget: this.name, budgetBytes: this.budgetBytes,
      pendingBytes: this.pendingBytes, liveBytes: this.liveBytes, denials: this.denials, overcommits: this.overcommits || 0,
      byOwner, pinned: [...this.pinned], cancelledGenerations: [...this.cancelled],
      // Lifecycle evidence: how many entries exist and which generations
      // still own any (a replaced song's generation must not linger).
      peakBytes: this.peakBytes, peakByOwner: { ...this.peakByOwner },
      entryCount: this.entries.size, generations: [...new Set([...this.entries.values()].map((e) => e.generation))].sort((x, y) => x - y),
    };
  }
}

let shared = null;
/** The page's one residency ledger (legacy strips and Range v2 share it). */
export function sharedResidency() {
  if (!shared) {
    const b = residencyBudgetFor();
    shared = new GraphicsResidency({ budgetBytes: b.bytes, name: b.name });
  }
  return shared;
}
