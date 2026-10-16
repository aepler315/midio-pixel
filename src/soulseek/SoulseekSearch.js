/**
 * Song search UI for Midio.
 *
 * Free music works with zero setup. Soulseek is optional (username/password).
 * Bundled slskd is auto-detected — API keys stay hidden.
 */

const STORAGE_KEY = 'midio.soulseek.config';
const FETCH_TIMEOUT_MS = 10000;

/** Return only non-secret preferences suitable for persistent browser storage. */
export function configForStorage(cfg = {}) {
  const mode = ['free', 'direct', 'slskd'].includes(cfg.mode) ? cfg.mode : 'free';
  const safe = { mode };
  if (cfg.slskdUrl) {
    try {
      const url = new URL(String(cfg.slskdUrl));
      if (!url.username && !url.password && !url.search && !url.hash) {
        safe.slskdUrl = url.toString().replace(/\/$/, '');
      }
    } catch {
      /* Do not preserve malformed or credential-bearing legacy URLs. */
    }
  }
  return safe;
}

export class SoulseekSearch {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {(files: File[]) => void} opts.onFiles
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor({ root, onFiles, onStatus }) {
    this.root = root;
    this.onFiles = onFiles;
    this.onStatus = onStatus || (() => {});
    this.status = { mode: 'free', connected: true, needsLogin: false, freeSearch: true };
    this.searchId = null;
    this.pollTimer = null;
    this.busy = false;
    // True once refreshStatus() has confirmed the /api/soulseek/* bridge
    // doesn't exist at all (a 404/405, or the fetch itself failing) --
    // the signature of a static host like GitHub Pages, where tools/serve.js
    // never ran. Distinct from the bridge existing but returning an error:
    // that's a real status worth showing; a route that isn't there at all
    // means this whole panel should not be on the page, not announce
    // itself as broken (see _setUnavailable).
    this.unavailable = false;

    this.els = {
      form: root.querySelector('#slskSearchForm'),
      input: root.querySelector('#slskQuery'),
      submit: root.querySelector('#slskSearchBtn'),
      results: root.querySelector('#slskResults'),
      empty: root.querySelector('#slskEmpty'),
      badge: root.querySelector('#slskModeBadge'),
      statusLine: root.querySelector('#slskStatus'),
      settingsBtn: root.querySelector('#slskSettingsBtn'),
      settings: root.querySelector('#slskSettings'),
      modeSelect: root.querySelector('#slskModeSelect'),
      slskdFields: root.querySelector('#slskdFields'),
      slskdUrl: root.querySelector('#slskdUrl'),
      slskdKey: root.querySelector('#slskdKey'),
      slskUser: root.querySelector('#slskUser'),
      slskPass: root.querySelector('#slskPass'),
      saveCfg: root.querySelector('#slskSaveCfg'),
      clearCfg: root.querySelector('#slskClearCfg'),
      legal: root.querySelector('#slskLegal'),
    };

    if (this.els.modeSelect) this.els.modeSelect.value = 'free';
    this._bind();
    this._restoreLocalConfig();
    this.refreshStatus();
  }

  _bind() {
    const e = this.els;
    e.form?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.search(e.input?.value || '');
    });
    e.settingsBtn?.addEventListener('click', () => this.toggleSettings());
    e.saveCfg?.addEventListener('click', () => this.saveConfig());
    e.clearCfg?.addEventListener('click', () => this.clearConfig());
    for (const el of [e.input, e.slskdUrl, e.slskdKey, e.slskUser, e.slskPass]) {
      el?.addEventListener('keydown', (ev) => ev.stopPropagation());
    }
  }

  toggleSettings(force) {
    if (!this.els.settings) return;
    const currentlyHidden = this.els.settings.classList.contains('hidden');
    const open = force ?? currentlyHidden;
    this.els.settings.classList.toggle('hidden', !open);
  }

  _restoreLocalConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const cfg = JSON.parse(raw);
      // Migrate old defaults: demo/direct-without-creds → free
      if (!cfg.mode || cfg.mode === 'demo' || (cfg.mode === 'direct' && !cfg.slskUser)) {
        cfg.mode = 'free';
      }
      if (this.els.modeSelect) this.els.modeSelect.value = cfg.mode || 'free';
      if (this.els.slskdUrl && cfg.slskdUrl) this.els.slskdUrl.value = cfg.slskdUrl;
      // Deliberately do not restore passwords, API keys, or account names.
      // Rewrite old localStorage values immediately so an upgrade removes them.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(configForStorage(cfg)));
    } catch {
      /* ignore */
    }
  }

  async _pushConfig(cfg) {
    const res = await fetch('/api/soulseek/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Config failed (${res.status})`);
    return data;
  }

  async saveConfig() {
    const user = this.els.slskUser?.value?.trim() || '';
    const pass = this.els.slskPass?.value?.trim() || '';
    const advancedMode = this.els.modeSelect?.value || 'free';

    let cfg;
    if (advancedMode === 'slskd') {
      cfg = {
        mode: 'slskd',
        slskdUrl: this.els.slskdUrl?.value?.trim() || 'http://127.0.0.1:5030',
        // blank key → server uses the loopback-only no-key configuration
        slskdKey: this.els.slskdKey?.value?.trim() || '',
      };
    } else if (user && pass) {
      cfg = { mode: 'direct', slskUser: user, slskPass: pass };
    } else if (advancedMode === 'direct' && (!user || !pass)) {
      this._setStatusLine('Enter your Soulseek username and password.');
      this.els.slskUser?.focus();
      return;
    } else {
      cfg = { mode: 'free' };
    }

    try {
      this._setStatusLine(cfg.mode === 'free' ? 'Switching to free music…' : 'Connecting…');
      const data = await this._pushConfig(cfg);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(configForStorage(cfg)));
      this.status = data;
      this._renderBadge();
      this._setStatusLine(data.note || 'Connected.');
      if (data.connected) this.toggleSettings(false);
    } catch (err) {
      this._setStatusLine(err.message || 'Could not save config');
    }
  }

  async clearConfig() {
    try {
      await this._pushConfig({ mode: 'free' });
    } catch {
      try {
        await fetch('/api/soulseek/config', { method: 'DELETE', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch {
        /* ignore */
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'free' }));
    if (this.els.modeSelect) this.els.modeSelect.value = 'free';
    if (this.els.slskUser) this.els.slskUser.value = '';
    if (this.els.slskPass) this.els.slskPass.value = '';
    await this.refreshStatus();
    this.toggleSettings(false);
    this._setStatusLine('Free music ready — search anything.');
  }

  async refreshStatus() {
    try {
      const res = await fetch('/api/soulseek/status', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      // 404/405 is the bridge simply not existing at this origin (a static
      // host) -- not an error condition to report, a feature to hide.
      if (res.status === 404 || res.status === 405) {
        this._setUnavailable();
        return;
      }
      if (!res.ok) throw new Error('status ' + res.status);
      this.status = await res.json();
    } catch {
      // A thrown fetch (connection refused, DNS failure, etc.) reads the
      // same way to a visitor as a 404: there's no server here. Treat it
      // identically rather than surfacing a developer-facing error.
      this._setUnavailable();
      return;
    }
    if (this.els.modeSelect && this.status.mode && this.status.mode !== 'offline') {
      // Map demo → free in the advanced select
      const m = this.status.mode === 'demo' ? 'free' : this.status.mode;
      if ([...this.els.modeSelect.options].some((o) => o.value === m)) {
        this.els.modeSelect.value = m;
      }
    }
    this._renderBadge();
    // Never force the settings panel open — free search works without it
    if (this.els.settingsBtn) {
      const soulseekOn =
        (this.status.mode === 'direct' || this.status.mode === 'slskd') && this.status.connected;
      this.els.settingsBtn.textContent = soulseekOn ? 'Soulseek ✓' : 'Soulseek';
    }
    if (this.els.legal) {
      this.els.legal.textContent =
        this.status.mode === 'free' || this.status.mode === 'demo'
          ? 'Free results are open / demo audio. Optional Soulseek: only download files you have the right to use.'
          : 'Only download files you have the right to use. Duplicates collapsed — remixes & instrumentals kept once each.';
    }
    if (!this.busy) {
      this._setStatusLine(this.status.note || '');
    }
  }

  /** The bridge doesn't exist at this origin -- hide the whole panel
   *  (and the "or load your own file" divider above the dropzone) rather
   *  than rendering an "offline"/"unreachable" message a non-technical
   *  visitor has no way to act on. The dropzone and demo button, which
   *  actually work with zero setup, become the top of the card. */
  _setUnavailable() {
    this.unavailable = true;
    this.status = { mode: 'offline', connected: false, needsLogin: false, note: '' };
    this.root?.classList.add('hidden');
    this.root?.parentElement?.querySelector('.slskDivider')?.classList.add('hidden');
  }

  _renderBadge() {
    const b = this.els.badge;
    if (!b) return;
    let mode = this.status.mode || 'free';
    if (mode === 'demo') mode = 'free';
    b.dataset.mode = mode;
    b.textContent =
      mode === 'slskd'
        ? this.status.slskdLoggedIn
          ? 'Soulseek'
          : 'slskd'
        : mode === 'direct'
          ? 'Soulseek'
          : mode === 'offline'
            ? 'offline'
            : 'free music';
    b.title = this.status.note || '';
  }

  _setStatusLine(msg) {
    if (this.els.statusLine) this.els.statusLine.textContent = msg || '';
    this.onStatus(msg || '');
  }

  _stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async search(query) {
    if (this.unavailable) return; // no bridge at this origin -- see _setUnavailable
    const q = String(query || '').trim();
    if (!q) {
      this._setStatusLine('Type a song, artist, or album.');
      return;
    }
    // Free search always allowed — no login wall
    if (this.busy) return;
    this.busy = true;
    this._stopPoll();
    this._renderResults([]);
    const mode = this.status.mode || 'free';
    this._setStatusLine(
      mode === 'direct' || mode === 'slskd'
        ? `Searching Soulseek for “${q}”…`
        : `Searching free music for “${q}”…`,
    );
    if (this.els.submit) this.els.submit.disabled = true;

    try {
      const res = await fetch('/api/soulseek/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
      this.searchId = data.id;
      await this._pollOnce();
      this.pollTimer = setInterval(() => this._pollOnce(), 900);
    } catch (err) {
      this._setStatusLine(err.message || 'Search failed');
      this.busy = false;
      if (this.els.submit) this.els.submit.disabled = false;
    }
  }

  async _pollOnce() {
    if (!this.searchId) return;
    try {
      const res = await fetch(`/api/soulseek/search/${encodeURIComponent(this.searchId)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Poll failed');
      this._renderResults(data.results || []);
      if (data.status === 'completed') {
        this._stopPoll();
        this.busy = false;
        if (this.els.submit) this.els.submit.disabled = false;
        const n = data.resultCount ?? (data.results || []).length;
        const src =
          data.mode === 'free' || data.mode === 'demo'
            ? 'free music'
            : data.mode === 'slskd' || data.mode === 'direct'
              ? 'Soulseek'
              : data.mode || 'search';
        this._setStatusLine(
          n ? `${n} unique version${n === 1 ? '' : 's'} · ${src}` : 'No matches — try another query.',
        );
      } else if (data.status === 'error') {
        this._stopPoll();
        this.busy = false;
        if (this.els.submit) this.els.submit.disabled = false;
        this._setStatusLine(data.error || 'Search error');
      } else {
        const n = (data.results || []).length;
        this._setStatusLine(n ? `Listening… ${n} unique so far` : 'Searching…');
      }
    } catch (err) {
      this._stopPoll();
      this.busy = false;
      if (this.els.submit) this.els.submit.disabled = false;
      this._setStatusLine(err.message || 'Search failed');
    }
  }

  _renderResults(results) {
    const list = this.els.results;
    if (!list) return;
    list.innerHTML = '';
    if (this.els.empty) {
      this.els.empty.classList.toggle('hidden', results.length > 0);
    }
    for (const item of results) {
      list.appendChild(this._resultRow(item));
    }
  }

  _resultRow(item) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slskResult';
    row.title = item.filename || '';

    const title = item.title || basename(item.filename) || 'Untitled';
    const artist = item.artist || 'Unknown artist';
    const album = item.album || '—';
    const length =
      item.lengthLabel || (item.lengthSec ? formatLength(item.lengthSec) : '—');

    row.innerHTML = `
      <span class="slskResultIcon" aria-hidden="true">${item.ext === 'mid' || item.ext === 'midi' ? '🎹' : '♪'}</span>
      <span class="slskResultBody">
        <span class="slskResultTitle"></span>
        <span class="slskResultFields">
          <span class="slskFieldLine"><span class="slskFieldLabel">Artist</span><span class="slskFieldValue slskArtist"></span></span>
          <span class="slskFieldLine"><span class="slskFieldLabel">Album</span><span class="slskFieldValue slskAlbum"></span></span>
          <span class="slskFieldLine"><span class="slskFieldLabel">Length</span><span class="slskFieldValue slskLength"></span></span>
        </span>
        <span class="slskResultMeta"></span>
      </span>
      <span class="slskResultPlay">Play</span>
    `;
    row.querySelector('.slskResultTitle').textContent = title;
    row.querySelector('.slskArtist').textContent = artist;
    row.querySelector('.slskAlbum').textContent = album;
    row.querySelector('.slskLength').textContent = length;

    const bits = [];
    if (item.source === 'archive') bits.push('Archive.org');
    else if (item.source === 'free' || item.source === 'demo') bits.push('free');
    else if (item.user) bits.push(item.user);
    if (item.bitrate) bits.push(`${item.bitrate} kbps`);
    if (item.ext) bits.push(String(item.ext).toUpperCase());
    if (item.sizeLabel) bits.push(item.sizeLabel);
    row.querySelector('.slskResultMeta').textContent = bits.join(' · ');

    row.addEventListener('click', () => this.play(item, row));
    return row;
  }

  async play(item, rowEl) {
    if (this.busy) return;
    this.busy = true;
    if (rowEl) rowEl.classList.add('slskResultLoading');
    this._setStatusLine(`Loading “${item.title || item.filename}”…`);
    try {
      const res = await fetch('/api/soulseek/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Download failed (${res.status})`);
      }
      const buf = await res.arrayBuffer();
      const name =
        decodeURIComponent(res.headers.get('X-Filename') || '') ||
        basename(item.filename) ||
        'track.mp3';
      const type = res.headers.get('Content-Type') || 'audio/mpeg';
      const file = new File([buf], name, { type });
      this._setStatusLine(`Loaded ${name}`);
      this.onFiles([file]);
    } catch (err) {
      this._setStatusLine(err.message || 'Download failed');
      this.busy = false;
    } finally {
      if (rowEl) rowEl.classList.remove('slskResultLoading');
    }
  }

  resetBusy() {
    this.busy = false;
    if (this.els.submit) this.els.submit.disabled = false;
  }
}

function basename(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function formatLength(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
