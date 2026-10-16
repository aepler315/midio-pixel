/** Public catalog UI. Audio selection and its cancellation belong to main. */
export class PlexLibraryPanel {
  constructor({ root, source, onSelectTrack, onUnlockAudio, onCancelLoad }) {
    this.root = root; this.source = source;
    this.onSelectTrack = onSelectTrack; this.onUnlockAudio = onUnlockAudio; this.onCancelLoad = onCancelLoad;
    this.serial = 0; this.items = []; this.trail = []; this.kind = 'artist'; this.libraryId = null;
    const el = (tag, cls, text = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
    const button = (text, action) => { const node = el('button', 'ghostbtn plexButton', text); node.type = 'button'; node.addEventListener('click', action); return node; };
    const head = el('div', 'plexHead');
    const heading = el('h2', '', 'Plex library'); heading.id = 'plexLibraryTitle';
    head.append(heading, button('Close', () => this.close()));
    const label = el('label', 'plexSearchLabel', 'Search music'); label.htmlFor = 'plexSearch';
    this.searchInput = el('input', 'plexSearch'); this.searchInput.id = 'plexSearch'; this.searchInput.type = 'search';
    this.searchInput.placeholder = 'Artists, albums, or tracks'; this.searchInput.maxLength = 200;
    this.searchInput.addEventListener('input', () => {
      clearTimeout(this.debounce); this.controller?.abort(); this.serial++;
      this.debounce = setTimeout(() => { const q = this.searchInput.value.trim(); if (q.length >= 2) this.search(q); else this.browse(); }, 250);
    });
    this.libraries = el('select', 'plexLibraries'); this.libraries.setAttribute('aria-label', 'Music library');
    this.libraries.addEventListener('change', () => { this.libraryId = this.libraries.value; this.trail = []; this.searchInput.value = ''; this.browse(); });
    this.tabs = el('nav', 'plexTabs'); this.tabs.setAttribute('aria-label', 'Browse music');
    for (const [kind, name] of [['artist', 'Artists'], ['album', 'Albums'], ['track', 'Tracks']]) {
      const btn = button(name, () => { this.kind = kind; this.trail = []; this.searchInput.value = ''; this.browse(); }); btn.dataset.kind = kind; this.tabs.append(btn);
    }
    this.crumbs = el('nav', 'plexCrumbs'); this.crumbs.setAttribute('aria-label', 'Music location');
    this.status = el('p', 'plexStatus'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.list = el('ul', 'plexList'); this.list.setAttribute('aria-label', 'Music results');
    this.more = button('Show more', () => this.browse(this.nextOffset, true)); this.more.hidden = true;
    this.previous = button('Previous page', () => this.browse(Math.max(0, this.offset - 50))); this.previous.hidden = true;
    this.retry = button('Retry', () => this.lastAction?.()); this.retry.hidden = true;
    this.download = el('p', 'plexDownload'); this.download.setAttribute('role', 'status'); this.download.setAttribute('aria-live', 'polite');
    this.cancel = button('Cancel load', () => this.onCancelLoad?.()); this.cancel.hidden = true;
    const foot = el('div', 'plexFoot'); foot.append(this.previous, this.more, this.retry);
    root.replaceChildren(head, label, this.searchInput, this.libraries, this.tabs, this.crumbs, this.status, this.list, foot, this.download, this.cancel);
    root.setAttribute('aria-labelledby', 'plexLibraryTitle');
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...root.querySelectorAll('button, input, select')].filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    root.addEventListener('close', () => { clearTimeout(this.debounce); this.controller?.abort(); this.serial++; this.opener?.focus({ preventScroll: true }); });
  }
  open(opener = document.activeElement) {
    this.opener = opener;
    if (!this.root.open) this.root.showModal();
    this.searchInput.focus();
    if (!this.libraryId) this.initialize();
    else if (this.searchInput.value.trim().length >= 2) this.search(this.searchInput.value.trim());
    else this.browse();
  }
  close() { if (this.root.open) this.root.close(); }
  async request(action, done) {
    this.controller?.abort(); this.controller = new AbortController();
    const serial = ++this.serial, signal = this.controller.signal;
    this.retry.hidden = true; this.status.textContent = 'Loading music…';
    try {
      const result = await action(signal);
      if (signal.aborted || serial !== this.serial || !this.root.open) return;
      done(result); this.retry.hidden = true;
    } catch (error) {
      if (signal.aborted || serial !== this.serial || !this.root.open) return;
      this.status.textContent = error.status === 503 ? 'Plex library unavailable' : 'Plex library unavailable. Please try again.';
      this.retry.hidden = false;
    }
  }
  initialize() {
    this.lastAction = () => this.initialize();
    return this.request(async signal => {
      const status = await this.source.status({ signal });
      if (!status.enabled || !status.available) throw new Error('Unavailable');
      return this.source.listLibraries({ signal });
    }, result => {
      this.libraries.replaceChildren();
      for (const library of result.items) { const option = document.createElement('option'); option.value = library.id; option.textContent = library.title; this.libraries.append(option); }
      this.libraries.hidden = result.items.length < 2;
      this.libraryId = result.items[0]?.id || null;
      if (this.libraryId) this.browse(); else this.status.textContent = 'No music libraries are available.';
    });
  }
  renderCrumbs() {
    this.crumbs.replaceChildren();
    const home = document.createElement('button'); home.type = 'button'; home.className = 'ghostbtn plexButton'; home.textContent = 'All music';
    home.addEventListener('click', () => { this.trail = []; this.kind = 'artist'; this.searchInput.value = ''; this.browse(); }); this.crumbs.append(home);
    this.trail.forEach((item, index) => {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghostbtn plexButton'; btn.textContent = item.title || 'Unknown';
      btn.addEventListener('click', () => { this.trail = this.trail.slice(0, index + 1); this.kind = item.type === 'artist' ? 'album' : 'track'; this.searchInput.value = ''; this.browse(); }); this.crumbs.append(btn);
    });
    for (const btn of this.tabs.children) btn.setAttribute('aria-pressed', String(btn.dataset.kind === this.kind));
  }
  browse(offset = 0, append = false) {
    if (!this.libraryId) return;
    this.lastAction = () => this.browse(offset, append);
    this.renderCrumbs();
    return this.request(signal => this.source.listItems({ libraryId: this.libraryId, kind: this.kind, parentId: this.trail.at(-1)?.ratingKey || null, offset, limit: 50, signal }), result => {
      const seen = new Set(append ? this.items.map(item => item.id) : []);
      this.items = append ? this.items : [];
      for (const item of result.items) if (!seen.has(item.id)) { this.items.push({ ...item, type: item.type || this.kind }); seen.add(item.id); }
      this.items = this.items.slice(-500); this.offset = offset; this.nextOffset = result.nextOffset;
      this.renderItems(this.items);
      this.more.hidden = result.nextOffset == null; this.previous.hidden = offset === 0;
      this.status.textContent = this.items.length ? `${this.items.length} shown${result.total == null ? '' : ` · ${result.total} total`}` : 'No music here.';
    });
  }
  search(query) {
    if (!this.libraryId) return;
    this.lastAction = () => this.search(query);
    return this.request(signal => this.source.search({ libraryId: this.libraryId, query, signal }), result => {
      this.list.replaceChildren();
      for (const [key, kind, label] of [['artists','artist','Artists'],['albums','album','Albums'],['tracks','track','Tracks']]) {
        if (!result[key]?.length) continue;
        const heading = document.createElement('li'); heading.className = 'plexGroup'; heading.textContent = label; this.list.append(heading);
        this.appendItems(result[key].map(item => ({ ...item, type: kind })));
      }
      this.more.hidden = true; this.previous.hidden = true;
      this.status.textContent = result.truncated ? 'Refine your search for more results' : (this.list.children.length ? 'Search results' : 'No matching music.');
    });
  }
  renderItems(items) { this.list.replaceChildren(); this.appendItems(items); }
  appendItems(items) {
    for (const item of items) {
      const row = document.createElement('li'), btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'plexItem'; btn.dataset.ratingKey = item.ratingKey;
      const cover = document.createElement('span'); cover.className = 'plexCover'; cover.textContent = '♫'; cover.setAttribute('aria-hidden', 'true');
      try {
        const url = this.source.artworkUrl(item.artworkPath);
        if (url) { const img = document.createElement('img'); img.src = url; img.loading = 'lazy'; img.alt = ''; img.addEventListener('error', () => img.remove(), { once: true }); cover.append(img); }
      } catch { /* missing or unsafe artwork never blocks playback */ }
      const text = document.createElement('span'); text.className = 'plexItemText';
      const title = document.createElement('strong'); title.textContent = item.title || 'Unknown title';
      const detail = document.createElement('span'); detail.textContent = [item.artist, item.album].filter(Boolean).join(' · ') || (item.type === 'track' ? 'Unknown artist' : item.type === 'album' ? 'Album' : 'Artist');
      text.append(title, detail); btn.append(cover, text);
      if (item.loadability?.allowed === false) { btn.disabled = true; detail.textContent += ` · ${item.loadability.reason || 'Unavailable recording'}`; }
      btn.addEventListener('click', () => {
        if (item.type === 'track') { this.onUnlockAudio?.(); this.onSelectTrack?.(item.ratingKey); }
        else { this.trail.push(item); this.kind = item.type === 'artist' ? 'album' : 'track'; this.searchInput.value = ''; this.browse(); }
      });
      row.append(btn); this.list.append(row);
    }
  }
  setLoading(text, cancelable = true) { this.download.textContent = text; this.cancel.hidden = !cancelable; }
}
