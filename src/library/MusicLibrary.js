// The library, as one object the rest of the app can talk to.
//
// LibraryDB knows how to store, LibraryScanner knows how to read a folder,
// AutoTag knows how to ask MusicBrainz, TrackIndex knows how to order the
// result -- this is the part that sequences them and owns the one piece of
// state none of them can: which folder is open right now, and how to get
// from a stored path back to a playable File.
//
// Nothing here touches the DOM. The panel subscribes and repaints.
import {
  addRoot, listRoots, listTracks, removeRoot, beginRootScan, putScanTracks, pruneScanTracks, recordPlay, updateTracks, carryForward,
  libraryDbSupported, directoryHandlesSupported,
} from './LibraryDB.js';
import { scanDirectory, scanFileList, resolveFile, ensureReadPermission } from './LibraryScanner.js';
import { createTagQueue } from './AutoTag.js';
import { untaggedTracks } from './TrackIndex.js';

let sessionRootSequence = 0;

function sessionRootId(name) {
  sessionRootSequence += 1;
  return `session:${String(name || 'music').toLowerCase()}:${Date.now().toString(36)}:${sessionRootSequence}`;
}

export class MusicLibrary {
  constructor({ scope = globalThis, fetchFn = (typeof fetch !== 'undefined' ? fetch : null) } = {}) {
    this.scope = scope;
    this.fetchFn = fetchFn;
    this.root = null;      // the stored root record
    this.handle = null;    // its live directory handle, when there is one
    this.tracks = [];
    /** Files from a `webkitdirectory` pick, which are playable now but
     *  cannot be stored. Empty on the handle path, where files are found
     *  again by walking the directory instead. */
    this.sessionFiles = new Map();
    this.listeners = new Set();
    /** True while a folder is being walked. The view uses it to say so --
     *  a library that is still filling and one that is finished and small
     *  look identical otherwise. */
    this.scanning = false;
    this.scannedCount = 0;
    this.scanResult = null;
    this._abort = null;
    /** Bumped per scan so a scan that has been superseded cannot write its
     *  results over the newer one's when it finally unwinds. */
    this._scanGen = 0;
    /** Failed saves keep usable session edits. Track the affected fields
     *  separately so a committed play cannot claim failed tags were saved.
     *  `track.unsaved` is view state only, never a database field. */
    this._unsavedFields = new Map();
  }

  get supported() { return libraryDbSupported(this.scope); }

  /** Can the chosen folder be reopened after a reload without asking again? */
  get persistable() { return directoryHandlesSupported(this.scope); }

  /** Is the open root one we can actually read files from right now? A
   *  remembered-but-unreadable library still lists; it just cannot play. */
  get playable() { return !!this.handle || this.sessionFiles.size > 0; }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(this); } catch (err) { console.warn('[library] listener failed', err); }
    }
  }

  /** Load whatever was remembered. Never prompts: there is no user gesture
   *  on page load, so a lapsed permission is reported, not re-requested. */
  async init() {
    if (!this.supported) return this;
    const gen = this._scanGen;
    const roots = await listRoots(this.scope);
    const root = roots[0] || null;
    const tracks = root ? await listTracks(root.id, this.scope) : [];
    const readable = root?.handle && await ensureReadPermission(root.handle);
    if (gen !== this._scanGen) return this;
    this.root = root;
    this.tracks = tracks;
    this.handle = readable ? root.handle : null;
    this._emit();
    return this;
  }

  /** Re-ask for the folder permission. Must be called from a click. */
  async grantAccess() {
    const root = this.root;
    const gen = this._scanGen;
    if (!root?.handle) return false;
    if (!await ensureReadPermission(root.handle, { interactive: true })) return false;
    if (gen !== this._scanGen || this.root !== root) return false;
    this.handle = root.handle;
    this._emit();
    return true;
  }

  /**
   * Choose a folder and scan it.
   *
   * Two paths in, because two classes of browser exist: one that hands back
   * a handle we can keep, and one that hands back a list of Files we cannot.
   * Both produce the same track records, so everything downstream is
   * identical -- the difference shows up once, at the next reload.
   */
  async pickFolder({ onProgress = null, onRootChosen = null } = {}) {
    if (!this.persistable) return null;
    // Claim the selection before the picker or identity comparison awaits.
    // A late picker must not become a newer selection merely by resolving last.
    const signal = this._beginWork();
    const gen = this._scanGen;
    try {
      const handle = await this.scope.showDirectoryPicker({ id: 'midio-music', mode: 'read' });
      if (gen !== this._scanGen) return null;
      const persisted = await addRoot({ name: handle.name, handle }, this.scope, { signal });
      if (gen !== this._scanGen) return null;
      this.root = persisted || {
        id: sessionRootId(handle.name), name: handle.name, handle, persistable: false,
      };
      this.handle = handle;
      this.sessionFiles.clear();
      this.tracks = this.tracks.filter(track => track.rootId === this.root.id);
      this._emit();
      onRootChosen?.(this.root);
      if (gen !== this._scanGen) return this.tracks;
      return await this._scanRoot({ signal, gen, directory: handle, onProgress });
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    } finally {
      if (gen === this._scanGen) this._endWork();
    }
  }

  /** The `<input type="file" webkitdirectory>` path. File lists cannot
   *  prove physical folder identity, so each import reserves its own root. */
  async adoptFileList(files, { name = 'Music', onProgress = null, onRootChosen = null } = {}) {
    const list = [...(files || [])];
    if (!list.length) return null;
    const signal = this._beginWork();
    const gen = this._scanGen;
    try {
      const first = list[0]?.webkitRelativePath || '';
      const folderName = first.includes('/') ? first.slice(0, first.indexOf('/')) : name;
      const root = await addRoot({ name: folderName, handle: null, persistable: false }, this.scope, { signal });
      if (gen !== this._scanGen) return null;
      this.root = root || {
        id: sessionRootId(folderName), name: folderName, handle: null, persistable: false,
      };
      this.handle = null;
      this.tracks = this.tracks.filter(track => track.rootId === this.root.id);
      this.sessionFiles = new Map();
      onRootChosen?.(this.root);
      if (gen !== this._scanGen) return this.tracks;
      return await this._scanRoot({ signal, gen, files: list, onProgress });
    } finally {
      if (gen === this._scanGen) this._endWork();
    }
  }

  /** Refresh filesystem fields, retaining earned metadata. Only a fully
   *  readable, durably committed scan is allowed to remove missing paths. */
  async rescan({ onProgress = null } = {}) {
    if (!this.root || !this.handle) return this.tracks;
    const signal = this._beginWork();
    return this._scanRoot({ signal, gen: this._scanGen, directory: this.handle, onProgress });
  }

  async _scanRoot({ signal, gen, directory = null, files = null, onProgress }) {
    const expectedRoot = this.root;
    const rootId = expectedRoot.id;
    const mine = () => gen === this._scanGen;
    const priorTracks = new Map(this.tracks.map(track => [track.key, track]));
    const positions = new Map(this.tracks.map((track, index) => [track.key, index]));
    const result = { complete: false, stored: false, stale: false, issues: [] };
    this.scanResult = result;
    this.scanning = true;
    this.scannedCount = 0;
    this._emit();
    let allStored;
    let token = null;
    try {
      const ownership = rootId.startsWith('session:')
        ? { status: 'unavailable' }
        : await beginRootScan(rootId, this.scope, { signal, expectedRoot });
      if (!mine()) return this.tracks;
      if (ownership.status === 'missing' || ownership.status === 'stale') {
        result.stale = true;
        return this.tracks;
      }
      token = ownership.token || null;
      allStored = !!token;
      const options = {
        signal,
        onIssue: issue => { result.issues.push(issue); },
        onProgress: (count, path) => {
          if (!mine()) return;
          this.scannedCount = count;
          onProgress?.(count, path);
        },
        onBatch: async (batch, batchFiles) => {
          if (!mine() || result.stale) return;
          const saved = token
            ? await putScanTracks(token, batch, this.scope, { signal })
            : { status: 'unavailable' };
          if (!mine()) return;
          if (saved.status === 'stale') {
            result.stale = true;
            this._abort?.abort();
            return;
          }
          if (saved.status !== 'committed') allStored = false;
          // Files are installed before the corresponding rows become visible.
          if (batchFiles) for (const [path, file] of batchFiles) this.sessionFiles.set(path, file);
          this._publishScanBatch(batch, saved.tracks || null, priorTracks, positions);
          this._emit();
        },
      };
      const scanned = files
        ? (await scanFileList(rootId, files, options)).tracks
        : await scanDirectory(rootId, directory, options);
      if (!mine()) return this.tracks;
      result.complete = !signal.aborted && !result.stale && result.issues.length === 0;
      result.stored = allStored;
      if (result.complete && allStored) {
        const pruned = await pruneScanTracks(token, scanned.map(track => track.path), this.scope, { signal });
        if (!mine()) return this.tracks;
        if (pruned.status === 'stale') result.stale = true;
        if (pruned.status !== 'committed') result.stored = false;
      }
      // Incomplete scans still reload the union of old and committed rows.
      // A failed store leaves the conservative session listing in place.
      if (result.stale || result.stored) {
        const rows = await listTracks(rootId, this.scope);
        if (!mine()) return this.tracks;
        if (rows.length || result.stale || (result.complete && result.stored && !scanned.length)) this.tracks = rows;
      }
      if (result.stale) result.complete = false;
      return this.tracks;
    } finally {
      if (mine()) {
        this.scanning = false;
        this._endWork();
        this._emit();
      }
    }
  }

  async forget() {
    // Invalidate first. A scan already reading a file will flush its last
    // batch after the root is gone, and without a new generation that batch
    // still looks current -- it would write orphan rows back under the
    // deleted root and repopulate `tracks` from them.
    this.cancel();
    if (this.root) await removeRoot(this.root.id, this.scope);
    this.root = null;
    this.handle = null;
    this.tracks = [];
    this.sessionFiles.clear();
    this._unsavedFields.clear();
    this._emit();
  }

  /** Back from a stored track to a playable File, or null if it has moved. */
  async openFile(track) {
    if (!track) return null;
    const fromSession = this.sessionFiles.get(track.path);
    if (fromSession) return fromSession;
    if (!this.handle) return null;
    return resolveFile(this.handle, track.path);
  }

  /**
   * Record that a track was played, and its real duration now that
   * something has decoded it.
   *
   * Duration is the one field a scan cannot know, and it is what makes
   * "sort by length" and the auto-tag's length check work at all -- so it
   * is written back the first time a song is heard and kept from then on.
   */
  async notePlayed(track, durationSec = null) {
    if (!track?.key) return false;
    const committed = await recordPlay(track.key, durationSec, this.scope);
    const current = this.tracks.find(row => row.key === track.key) || track;
    const patch = {
      playCount: committed?.playCount ?? (Math.max(track.playCount || 0, current.playCount || 0) + 1),
      lastPlayedMs: committed?.lastPlayedMs ?? Date.now(),
    };
    if (Number.isFinite(durationSec) && durationSec > 0) patch.durationSec = durationSec;
    this._publishTrackPatch(track, patch, !!committed);
    this._emit();
    return !!committed;
  }

  /**
   * Fill in the tracks that only have a filename.
   *
   * Runs at MusicBrainz's one-per-second and writes results as they land,
   * so a folder of two hundred fills in over four minutes while the player
   * browses rather than blocking on a batch. Returns how many were tagged.
   */
  async autoTag({ onProgress = null, signal = null } = {}) {
    const pending = untaggedTracks(this.tracks);
    if (!pending.length) return 0;
    const patches = [];
    const queue = createTagQueue({ fetchFn: this.fetchFn });
    const tagged = await queue.run(pending, {
      signal,
      onProgress,
      onResult: (track, patch) => {
        if (!patch) return;
        const fields = {
          title: patch.title || track.title,
          artist: patch.artist || track.artist,
          album: patch.album || track.album,
          year: patch.year ?? track.year ?? null,
          tagSource: 'auto',
        };
        this._publishTrackPatch(track, fields, false);
        patches.push({ key: track.key, ...fields });
        // Repaint per result: watching the list fill in is the only thing
        // that makes a four-minute job feel like progress instead of a hang.
        this._emit();
      },
    });
    if (patches.length) {
      const saved = await updateTracks(patches, this.scope);
      if (saved === new Set(patches.map(patch => patch.key)).size) {
        const originals = new Map(pending.map(track => [track.key, track]));
        const currentRows = new Map(this.tracks.map(track => [track.key, track]));
        for (const { key, ...fields } of patches) {
          this._publishTrackPatch(originals.get(key), fields, true, currentRows.get(key) || null);
        }
      }
      this._emit();
    }
    return tagged;
  }

  /** Successful saves publish committed fields. Failed saves retain their
   *  session values with an explicit marker until those fields commit or a
   *  later successful scan reloads durable state. No retry is implied. */
  _publishTrackPatch(track, fields, saved, current = this.tracks.find(row => row.key === track.key)) {
    const pending = this._unsavedFields.get(track.key) || new Set();
    for (const field of Object.keys(fields)) {
      if (saved) pending.delete(field);
      else pending.add(field);
    }
    if (pending.size) this._unsavedFields.set(track.key, pending);
    else this._unsavedFields.delete(track.key);
    // A play/tag can finish after a scan replaced its row object. Reconcile
    // the currently displayed row as well as the original caller's row.
    for (const row of new Set([track, current].filter(Boolean))) {
      Object.assign(row, fields);
      if (pending.size) row.unsaved = true;
      else delete row.unsaved;
    }
  }

  _publishScanBatch(batch, merged, priorTracks, positions) {
    const rows = new Map();
    for (const fresh of merged || batch) {
      const prior = rows.get(fresh.key) || priorTracks.get(fresh.key);
      const row = !merged && prior ? carryForward(prior, fresh) : fresh;
      rows.set(row.key, row);
    }
    for (const row of rows.values()) {
      // These are new streamed rows. Avoid searching the growing listing
      // per row, which would make a large folder quadratic to publish.
      this._publishTrackPatch(row, { ...row }, !!merged, row);
      const index = positions.get(row.key);
      if (index === undefined) {
        positions.set(row.key, this.tracks.length);
        this.tracks.push(row);
      } else this.tracks[index] = row;
    }
  }

  /** One scan or tag run at a time; starting another abandons the first. */
  _beginWork() {
    this._scanGen++;
    this._abort?.abort?.();
    this.scanning = false;
    this._abort = typeof AbortController !== 'undefined' ? new AbortController() : { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
    return this._abort.signal;
  }

  _endWork() {
    this._abort = null;
  }

  /** Stop any scan in flight -- closing the panel over a ten-thousand-track
   *  drive should actually stop reading it. */
  cancel() {
    // The generation moves too, not just the signal. `signal.aborted` is
    // only read between files, so a flush already under way finishes -- and
    // it must not be allowed to look like the current scan when it does.
    this._scanGen++;
    this._abort?.abort?.();
    this._abort = null;
    if (this.scanning) {
      this.scanning = false;
      this._emit();
    }
  }
}
