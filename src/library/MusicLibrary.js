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
  addRoot, listRoots, listTracks, removeRoot, putTracks, pruneTracks, recordPlay, updateTracks, carryForward,
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
    const roots = await listRoots(this.scope);
    this.root = roots[0] || null;
    if (this.root) {
      this.tracks = await listTracks(this.root.id, this.scope);
      if (this.root.handle && await ensureReadPermission(this.root.handle)) {
        this.handle = this.root.handle;
      }
    }
    this._emit();
    return this;
  }

  /** Re-ask for the folder permission. Must be called from a click. */
  async grantAccess() {
    if (!this.root?.handle) return false;
    if (!await ensureReadPermission(this.root.handle, { interactive: true })) return false;
    this.handle = this.root.handle;
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
    let handle;
    try {
      handle = await this.scope.showDirectoryPicker({ id: 'midio-music', mode: 'read' });
    } catch (err) {
      // Only a cancellation is silent. Anything else -- a lost user
      // gesture, a blocked API, a folder the browser refuses -- used to
      // come back here as null and look exactly like "the button did
      // nothing", which is the worst possible way to report a failure.
      if (err?.name === 'AbortError') return null;
      throw err;
    }
    const persisted = await addRoot({ name: handle.name, handle }, this.scope);
    // A usable directory handle is still a library for this session when
    // IndexedDB is blocked, full, or aborts its transaction. Persistence is
    // a durability enhancement, not permission to discard the user's pick.
    this.root = persisted || {
      id: sessionRootId(handle.name), name: handle.name, handle, persistable: false,
    };
    this.handle = handle;
    this.sessionFiles.clear();
    this.tracks = this.tracks.filter(track => track.rootId === this.root.id);
    this._emit();
    // Before the walk starts, not after it finishes: the caller opens the
    // library on this, so the folder's contents appear as they are read
    // instead of minutes later in one go.
    onRootChosen?.(this.root);
    return this.rescan({ onProgress });
  }

  /** The `<input type="file" webkitdirectory>` path: the caller owns the
   *  element and hands the files here. */
  async adoptFileList(files, { name = 'Music', onProgress = null, onRootChosen = null } = {}) {
    const list = [...(files || [])];
    if (!list.length) return null;
    // webkitRelativePath leads with the folder the player actually chose,
    // which is a better label than the input element could give us.
    const first = list[0]?.webkitRelativePath || '';
    const folderName = first.includes('/') ? first.slice(0, first.indexOf('/')) : name;
    const root = await addRoot({ name: folderName, handle: null, persistable: false }, this.scope);
    this.root = root || {
      id: sessionRootId(folderName), name: folderName, handle: null, persistable: false,
    };
    this.handle = null;
    const rootId = this.root.id;

    const signal = this._beginWork();
    const gen = this._scanGen;
    const mine = () => gen === this._scanGen;
    let allStored = true;
    const priorTracks = new Map(this.tracks.map(track => [track.key, track]));
    this.tracks = [];
    this.sessionFiles = new Map();
    this.scanning = true;
    this.scannedCount = 0;
    this._emit();
    onRootChosen?.(this.root);

    try {
      const { tracks } = await scanFileList(rootId, list, {
        signal,
        onProgress: (count, path) => {
          if (!mine()) return;
          this.scannedCount = count;
          onProgress?.(count, path);
        },
        onBatch: async (batch, batchFiles) => {
          if (!mine()) return;
          // Before the rows are published, not after the whole scan: this
          // is the only path where the File is already in hand, and a row
          // on screen that cannot be played is worse than one that is not
          // on screen yet.
          for (const [path, file] of batchFiles) this.sessionFiles.set(path, file);
          const merged = await putTracks(batch, this.scope);
          if (!mine()) return;
          if (!merged) allStored = false;
          this._publishScanBatch(batch, merged, priorTracks);
          this._emit();
        },
      });

      if (!mine()) return this.tracks;
      if (!signal.aborted && allStored) await pruneTracks(rootId, tracks.map((t) => t.path), this.scope);
      if (!mine()) return this.tracks;
      // The streamed scan rows and Files are the usable session library.
      // If persistence was unavailable or any batch failed, an empty/stale
      // database read must not replace them.
      if (!allStored) return this.tracks;
      const rows = await listTracks(rootId, this.scope);
      if (!mine()) return this.tracks;
      this.tracks = rows;
      return this.tracks;
    } finally {
      if (mine()) {
        this.scanning = false;
        this._endWork();
        this._emit();
      }
    }
  }

  /** Re-read the open folder. What the player earned is carried across by
   *  LibraryDB, so this is cheap to do often and safe to do at all.
   *
   *  Results arrive in batches while the walk runs, so the view fills in
   *  rather than sitting empty until the last file is read. */
  async rescan({ onProgress = null } = {}) {
    if (!this.root || !this.handle) return this.tracks;
    const signal = this._beginWork();
    const gen = this._scanGen;
    const rootId = this.root.id;
    const mine = () => gen === this._scanGen;
    /** Cleared by any batch the store refused. A scan that did not manage
     *  to write everything it found has no business deciding what is
     *  missing from disk. */
    let allStored = true;
    const priorTracks = new Map(this.tracks.map(track => [track.key, track]));

    this.tracks = [];
    this.scanning = true;
    this.scannedCount = 0;
    this._emit();

    try {
      const scanned = await scanDirectory(rootId, this.handle, {
        signal,
        onProgress: (count, path) => {
          if (!mine()) return;
          this.scannedCount = count;
          onProgress?.(count, path);
        },
        onBatch: async (batch) => {
          if (!mine()) return;
          // Persisted as they are found, so a scan abandoned half way
          // leaves a half-populated library rather than nothing -- and the
          // MERGED rows are what gets published, because a raw scan record
          // carries playCount 0 and playing a track off one would write 1
          // over a stored 7.
          const merged = await putTracks(batch, this.scope);
          if (!mine()) return;
          if (!merged) allStored = false;
          this._publishScanBatch(batch, merged, priorTracks);
          this._emit();
        },
      });

      // Re-checked after every await below. A newer scan starting during
      // the prune or the reload would otherwise be clobbered by this one
      // finishing -- including its abort controller, via _endWork.
      if (!mine()) return this.tracks;
      // Only a COMPLETED walk knows the full set of paths, so only a
      // completed walk may delete what is missing from it -- and only one
      // whose writes all landed.
      if (!signal.aborted && allStored) await pruneTracks(rootId, scanned.map((t) => t.path), this.scope);
      if (!mine()) return this.tracks;
      if (!allStored) return this.tracks;
      // Re-read rather than keeping the scan records: what the view should
      // show is the merged row, with the play counts and auto-tags that
      // carryForward preserved.
      const rows = await listTracks(rootId, this.scope);
      if (!mine()) return this.tracks;
      this.tracks = rows;
      return this.tracks;
    } finally {
      // A rejecting directory iterator -- access revoked mid-walk -- would
      // otherwise leave the panel labelled as reading forever, with Rescan
      // and Auto-tag disabled and no scan left to re-enable them.
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

  _publishScanBatch(batch, merged, priorTracks) {
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
      this.tracks.push(row);
    }
  }

  /** One scan or tag run at a time; starting another abandons the first. */
  _beginWork() {
    this._scanGen++;
    this._abort?.abort?.();
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
