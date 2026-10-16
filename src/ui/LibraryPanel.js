// The library view.
//
// Everything this file decides about *what* to show it asks TrackIndex; what
// is left here is DOM, and the two rules that only matter once a real
// library is loaded:
//
//  - A row is built once and reused. Ten thousand tracks is a normal folder,
//    and rebuilding the list on every keystroke is the difference between a
//    search box that feels instant and one that stutters.
//  - Only a window of rows is ever in the document. Past a few hundred, the
//    browser's layout cost dwarfs anything this code does, and nobody reads
//    row 4,000 -- they type. The count line says plainly how many matched,
//    so a truncated list never masquerades as the whole answer.
import {
  SORTS, sortTracks, filterTracks, folderContents, breadcrumbs,
  displayTitle, displayArtist, displayAlbum, formatDuration, sortByKey,
} from '../library/TrackIndex.js';

/** How many rows reach the document at once. */
const RENDER_LIMIT = 400;

const VIEW_PREF_KEY = 'midio.library.view';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(VIEW_PREF_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  try { localStorage.setItem(VIEW_PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

export class LibraryPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root       the `.panel` element to fill
   * @param {(track) => void} opts.onPlay
   * @param {() => void} opts.onPickFolder
   * @param {() => void} opts.onRescan
   * @param {() => void} opts.onAutoTag
   * @param {() => void} opts.onForget
   * @param {() => void} opts.onClose
   */
  constructor({ root, onPlay, onPickFolder, onRescan, onAutoTag, onForget, onClose }) {
    this.root = root;
    this.onPlay = onPlay;
    this.onPickFolder = onPickFolder;
    this.onRescan = onRescan;
    this.onAutoTag = onAutoTag;
    this.onForget = onForget;
    this.onClose = onClose;

    this.tracks = [];
    this.folderName = 'Library';
    this.busy = false;
    /** A folder being walked right now. A library that is still filling and
     *  one that is finished and small look identical without this. */
    this.scanning = false;
    this.scannedCount = 0;

    const prefs = readPrefs();
    this.query = '';
    this.sortKey = sortByKey(prefs.sortKey).key;
    this.sortDesc = typeof prefs.sortDesc === 'boolean' ? prefs.sortDesc : sortByKey(this.sortKey).defaultDesc;
    this.view = prefs.view === 'folders' ? 'folders' : 'list';
    this.folder = '';

    this._rowPool = [];
    this._build();
  }

  // --- construction -------------------------------------------------------

  _build() {
    const root = this.root;
    root.textContent = '';
    root.classList.add('libraryPanel');

    const inner = el('div', 'libraryInner');

    const header = el('div', 'libraryHeader');
    this.titleEl = el('h2', 'libraryTitle', 'Your library');
    this.subEl = el('p', 'librarySub', '');
    const headings = el('div', 'libraryHeadings');
    headings.append(this.titleEl, this.subEl);

    const headerActions = el('div', 'libraryHeaderActions');
    this.rescanBtn = this._ghost('Rescan', 'Re-read the folder: pick up songs added or removed since the last scan.');
    this.changeBtn = this._ghost('Change folder', 'Choose a different music folder.');
    this.forgetBtn = this._ghost('Forget', 'Remove this folder from the library. Nothing on disk is touched.');
    this.closeBtn = this._ghost('×', 'Close');
    this.closeBtn.classList.add('iconbtn');
    this.closeBtn.setAttribute('aria-label', 'Close library');
    headerActions.append(this.rescanBtn, this.changeBtn, this.forgetBtn, this.closeBtn);
    header.append(headings, headerActions);

    // --- toolbar
    const toolbar = el('div', 'libraryToolbar');

    this.searchEl = document.createElement('input');
    this.searchEl.type = 'search';
    this.searchEl.className = 'librarySearch';
    this.searchEl.placeholder = 'Search — try "artist:radiohead" or a folder name';
    this.searchEl.setAttribute('aria-label', 'Search the library');
    this.searchEl.autocomplete = 'off';

    this.sortEl = document.createElement('select');
    this.sortEl.className = 'librarySort';
    this.sortEl.setAttribute('aria-label', 'Sort by');
    for (const sort of SORTS) {
      const option = document.createElement('option');
      option.value = sort.key;
      option.textContent = sort.label;
      this.sortEl.appendChild(option);
    }
    this.sortEl.value = this.sortKey;

    this.dirBtn = this._ghost('', 'Reverse the sort order');
    this.dirBtn.classList.add('chipbtn', 'libraryDirBtn');

    this.viewBtn = this._ghost('', 'Switch between one flat list and the folders as they are on disk');
    this.viewBtn.classList.add('chipbtn');

    this.autoTagBtn = this._ghost('Auto-tag', 'Look up titles and artists for the tracks that only have a filename, from MusicBrainz. Free, and paced at the one request per second they ask for, so a big folder fills in gradually.');
    this.autoTagBtn.classList.add('chipbtn');

    toolbar.append(this.searchEl, this.sortEl, this.dirBtn, this.viewBtn, this.autoTagBtn);

    this.crumbsEl = el('nav', 'libraryCrumbs');
    this.crumbsEl.setAttribute('aria-label', 'Folder path');

    this.listEl = el('div', 'libraryList');
    this.listEl.setAttribute('role', 'list');

    this.emptyEl = el('p', 'libraryEmpty hidden', '');
    this.statusEl = el('p', 'libraryStatus', '');

    inner.append(header, toolbar, this.crumbsEl, this.listEl, this.emptyEl, this.statusEl);
    root.appendChild(inner);

    this._wire();
    this._syncToggles();
  }

  _ghost(label, title) {
    const button = el('button', 'ghostbtn', label);
    button.type = 'button';
    if (title) button.title = title;
    return button;
  }

  _wire() {
    this.closeBtn.addEventListener('click', () => this.onClose?.());
    this.rescanBtn.addEventListener('click', () => this.onRescan?.());
    this.changeBtn.addEventListener('click', () => this.onPickFolder?.());
    this.forgetBtn.addEventListener('click', () => this.onForget?.());
    this.autoTagBtn.addEventListener('click', () => this.onAutoTag?.());

    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value;
      // Typing while inside a folder is a search of the whole library --
      // the alternative is a search box that silently finds nothing because
      // of where the player happened to be standing.
      this.render();
    });

    this.sortEl.addEventListener('change', () => {
      this.sortKey = this.sortEl.value;
      this.sortDesc = sortByKey(this.sortKey).defaultDesc;
      this._persist();
      this._syncToggles();
      this.render();
    });

    this.dirBtn.addEventListener('click', () => {
      this.sortDesc = !this.sortDesc;
      this._persist();
      this._syncToggles();
      this.render();
    });

    this.viewBtn.addEventListener('click', () => {
      this.view = this.view === 'list' ? 'folders' : 'list';
      this.folder = '';
      this._persist();
      this._syncToggles();
      this.render();
    });

    this.crumbsEl.addEventListener('click', (e) => {
      const crumb = e.target?.closest?.('[data-folder-path]');
      if (!crumb) return;
      this.folder = crumb.dataset.folderPath;
      this.render();
    });

    this.listEl.addEventListener('click', (e) => {
      const row = e.target?.closest?.('.libraryRow');
      if (!row) return;
      if (row.dataset.folderPath != null) {
        this.folder = row.dataset.folderPath;
        this.render();
        return;
      }
      const track = this._rowTracks?.get(row);
      if (track) this.onPlay?.(track);
    });
  }

  _persist() {
    writePrefs({ sortKey: this.sortKey, sortDesc: this.sortDesc, view: this.view });
  }

  _syncToggles() {
    this.dirBtn.textContent = this.sortDesc ? '↓' : '↑';
    this.dirBtn.setAttribute('aria-label', this.sortDesc ? 'Sorted descending' : 'Sorted ascending');
    this.viewBtn.textContent = this.view === 'folders' ? 'Folders' : 'All tracks';
    this.viewBtn.setAttribute('aria-pressed', String(this.view === 'folders'));
    // The sort picks the order WITHIN a folder; the folders themselves are
    // always alphabetical, so offering "date added" next to them would
    // describe something the view does not do.
    this.sortEl.disabled = false;
  }

  // --- public API ---------------------------------------------------------

  setRoot({ name, persistable = true, trackCount = 0 } = {}) {
    this.folderName = name || 'Library';
    this.titleEl.textContent = name ? `Library — ${name}` : 'Your library';
    this.subEl.textContent = persistable
      ? `${trackCount.toLocaleString()} tracks, read straight off your disk. Nothing is uploaded.`
      : `${trackCount.toLocaleString()} tracks remembered. This browser can't reopen the folder on its own — pick it again to play from it.`;
    this.forgetBtn.classList.toggle('hidden', !name);
    this.rescanBtn.classList.toggle('hidden', !name);
  }

  setTracks(tracks) {
    this.tracks = tracks || [];
    this.render();
  }

  /** Say that the folder is still being read, and how far it has got.
   *  Rows keep arriving underneath this, so it is a running commentary on
   *  a list that is already usable, not a spinner in place of one. */
  setScanning(scanning, count = 0) {
    this.scanning = !!scanning;
    this.scannedCount = count || 0;
    // Rescan is the only control a scan makes meaningless; the rest --
    // search, sort, folder view, playing a track that has already appeared
    // -- all work on what has arrived so far.
    this.rescanBtn.disabled = this.scanning || this.busy;
    this.autoTagBtn.disabled = this.scanning || this.busy;
    this.render();
  }

  setBusy(busy, message = '') {
    this.busy = !!busy;
    this.rescanBtn.disabled = this.busy || this.scanning;
    this.autoTagBtn.disabled = this.busy || this.scanning;
    this.changeBtn.disabled = this.busy;
    if (message) this.setStatus(message);
  }

  setStatus(message) {
    this.statusEl.textContent = message || '';
  }

  focusSearch() {
    try { this.searchEl.focus(); } catch { /* not focusable yet */ }
  }

  // --- rendering ----------------------------------------------------------

  render() {
    const matched = filterTracks(this.tracks, this.query);
    const searching = !!this.query.trim();
    // Folder view plus an active search would show a folder tree of results,
    // which is two navigations at once; a search is a request to see the
    // matches, so it flattens.
    const folderView = this.view === 'folders' && !searching;

    this.crumbsEl.classList.toggle('hidden', !folderView);
    if (folderView) this._renderCrumbs();

    const contents = folderView ? folderContents(matched, this.folder) : { folders: [], tracks: matched };
    const ordered = sortTracks(contents.tracks, this.sortKey, this.sortDesc);
    const shown = ordered.slice(0, RENDER_LIMIT);

    this._paint(contents.folders, shown);
    this._renderCount(matched.length, contents.folders.length, ordered.length, shown.length, searching);
  }

  _renderCrumbs() {
    this.crumbsEl.textContent = '';
    const crumbs = breadcrumbs(this.folder, this.folderName);
    crumbs.forEach((crumb, i) => {
      if (i > 0) this.crumbsEl.appendChild(el('span', 'libraryCrumbSep', '/'));
      const isLast = i === crumbs.length - 1;
      const node = el(isLast ? 'span' : 'button', `libraryCrumb${isLast ? ' isCurrent' : ''}`, crumb.name);
      if (!isLast) {
        node.type = 'button';
        node.dataset.folderPath = crumb.path;
      }
      this.crumbsEl.appendChild(node);
    });
  }

  /** Reuse row elements rather than rebuilding them. The pool is the reason
   *  typing in the search box does not stutter on a big library. */
  _paint(folders, tracks) {
    const total = folders.length + tracks.length;
    while (this._rowPool.length < total) {
      const row = el('div', 'libraryRow');
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      row.append(
        el('span', 'libraryRowIcon'),
        el('span', 'libraryRowTitle'),
        el('span', 'libraryRowArtist'),
        el('span', 'libraryRowAlbum'),
        el('span', 'libraryRowTime'),
      );
      // Enter and Space on a focused row do what a click does. A list that
      // can be tabbed into but not activated is worse than one that cannot
      // be tabbed into at all.
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        row.click();
      });
      this._rowPool.push(row);
      this.listEl.appendChild(row);
    }
    for (let i = total; i < this._rowPool.length; i++) this._rowPool[i].classList.add('hidden');

    this._rowTracks = new Map();
    let i = 0;
    for (const folder of folders) {
      const row = this._rowPool[i++];
      row.classList.remove('hidden');
      row.classList.add('isFolder');
      row.dataset.folderPath = folder.path;
      const [icon, title, artist, album, time] = row.children;
      icon.textContent = '\u{1F4C1}';
      title.textContent = folder.name;
      artist.textContent = `${folder.count.toLocaleString()} ${folder.count === 1 ? 'track' : 'tracks'}`;
      album.textContent = '';
      time.textContent = '';
    }
    for (const track of tracks) {
      const row = this._rowPool[i++];
      row.classList.remove('hidden');
      row.classList.remove('isFolder');
      delete row.dataset.folderPath;
      row.classList.toggle('isAutoTagged', track.tagSource === 'auto');
      const [icon, title, artist, album, time] = row.children;
      icon.textContent = '♪';
      title.textContent = displayTitle(track);
      artist.textContent = displayArtist(track);
      // In the flat list the folder is the only clue to where an untagged
      // file lives, so it takes the album column when there is no album.
      album.textContent = track.album ? displayAlbum(track) : (track.folder || '');
      album.classList.toggle('isPath', !track.album);
      time.textContent = formatDuration(track.durationSec);
      row.title = track.path;
      this._rowTracks.set(row, track);
    }
  }

  _renderCount(matchedTotal, folderCount, listedTotal, shownCount, searching) {
    const truncated = shownCount < listedTotal;
    const parts = [];
    if (this.tracks.length === 0) {
      // An empty folder and a folder that has not been read yet are very
      // different things, and only one of them is the player's problem.
      this.emptyEl.textContent = this.scanning
        ? 'Reading the folder… tracks appear here as they are found.'
        : (this.folderName && this.folderName !== 'Library'
          ? 'No playable audio in this folder.'
          : 'No music folder chosen yet.');
      this.emptyEl.classList.remove('hidden');
    } else if (matchedTotal === 0) {
      this.emptyEl.textContent = this.scanning
        ? `Nothing matches “${this.query.trim()}” yet — still reading the folder.`
        : `Nothing matches “${this.query.trim()}”.`;
      this.emptyEl.classList.remove('hidden');
    } else {
      this.emptyEl.classList.add('hidden');
    }

    if (searching) parts.push(`${matchedTotal.toLocaleString()} of ${this.tracks.length.toLocaleString()} tracks match`);
    else if (folderCount) parts.push(`${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}, ${listedTotal.toLocaleString()} ${listedTotal === 1 ? 'track' : 'tracks'} here`);
    else parts.push(`${listedTotal.toLocaleString()} ${listedTotal === 1 ? 'track' : 'tracks'}`);
    // Never let a capped list read as the whole answer.
    if (truncated) parts.push(`showing the first ${shownCount.toLocaleString()} — search to narrow`);
    this.countLine = parts.join(' · ');

    if (this.scanning) {
      // The running total leads: it is the number that is moving, and it is
      // the answer to "is this working". The count line only earns a place
      // beside it when it says something different -- while filtering or
      // inside a folder it does, and otherwise it is the same number twice.
      const found = `Reading ${this.folderName}… ${this.scannedCount.toLocaleString()} found`;
      const sameNumber = !searching && !folderCount && listedTotal === this.scannedCount;
      this.statusEl.textContent = sameNumber ? found : `${found} · ${this.countLine}`;
      this.statusEl.classList.add('isScanning');
      return;
    }
    this.statusEl.classList.remove('isScanning');
    if (!this.busy) this.setStatus(this.countLine);
  }
}
