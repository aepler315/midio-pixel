// The DOM interface. It only renders state and forwards intent to the app
// through callbacks; it never touches the engine directly.
import { LIGHTS, WEATHERS, STYLES, OVERLAYS } from '../scene/Looks.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const BIOME_LABEL = {
  conifer: 'Conifer forest', taiga: 'Boreal forest', tundra: 'Tundra', ice: 'Rock & ice', broadleaf: 'Broadleaf forest',
  desert: 'Desert', steppe: 'Shrub steppe', chaparral: 'Chaparral', 'pine-oak': 'Pine-oak forest',
};

export class Ui {
  constructor(root, ranges, cb) {
    this.root = root;
    this.ranges = ranges;
    this.cb = cb;
    root.innerHTML = `
      <div class="brand">RIDGEVIEW</div>
      <header class="title" id="title" aria-live="polite">
        <div class="eyebrow"></div>
        <h1></h1>
        <div class="sub"></div>
        <div class="viewinfo"></div>
      </header>
      <div class="caption" id="caption" aria-hidden="true"></div>
      <div class="toolbar">
        <button class="tb" data-act="labels" title="Peak labels (L)" aria-pressed="true">⛰ Labels</button>
        <select class="tb" data-act="quality" title="Detail level" aria-label="Detail level">
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option>
        </select>
        <button class="tb" data-act="share" title="Copy a link to this view (C)">Share</button>
        <button class="tb" data-act="help" title="Controls (?)">?</button>
        <button class="tb" data-act="fullscreen" title="Fullscreen (F)">⤢</button>
      </div>
      <aside class="dock" id="dock">
        <button class="dock-toggle" data-act="dock" aria-expanded="true">Looks</button>
        <div class="dock-body">
          ${group('Light', 'light', LIGHTS.map((l) => ({ id: l.id, label: l.label, hint: l.key })))}
          ${group('Weather', 'weather', WEATHERS.map((w, i) => ({ id: w.id, label: w.label, hint: `⇧${i + 1}` })))}
          ${group('Style', 'style', STYLES.map((s) => ({ id: s.id, label: s.label })), 'T')}
          ${group('Overlay', 'overlay', OVERLAYS.map((o) => ({ id: o.id, label: o.label })), 'O')}
        </div>
      </aside>
      <nav class="nav" aria-label="Mountain ranges">
        <button class="navbtn" data-act="prev" title="Previous range ( [ )" aria-label="Previous range">‹</button>
        <button class="rangebtn" data-act="list" title="All ranges">
          <span class="rname"></span><span class="rcount"></span>
        </button>
        <button class="navbtn" data-act="next" title="Next range ( ] )" aria-label="Next range">›</button>
        <button class="navbtn surprise" data-act="surprise" title="Surprise me (Space)" aria-label="Random range">⤨</button>
        <div class="pips" role="group" aria-label="Viewpoints"></div>
        <button class="navbtn home" data-act="home" title="Back to the viewpoint (H)" aria-label="Back to the viewpoint">⌂</button>
      </nav>
      <div class="status"><span class="coords"></span><span class="alt"></span><span class="load"></span></div>
      <section class="panel list" id="list" hidden>
        <div class="panel-head"><input type="search" placeholder="Search ranges, peaks, places…" aria-label="Search ranges"><button data-act="close-list" aria-label="Close">✕</button></div>
        <ol class="ranges"></ol>
      </section>
      <section class="panel help" id="help" hidden>
        <div class="panel-head"><h2>Controls</h2><button data-act="close-help" aria-label="Close">✕</button></div>
        <dl>
          <dt>Scroll</dt><dd>Fly toward the point under the cursor (out: back away)</dd>
          <dt>Drag</dt><dd>Look around</dd>
          <dt>Right-drag / Ctrl-drag</dt><dd>Orbit the point you grab</dd>
          <dt>Shift-drag / middle-drag</dt><dd>Drag the ground</dd>
          <dt>Double-click</dt><dd>Glide toward a spot</dd>
          <dt>Shift + scroll</dt><dd>Move the sun</dd>
          <dt>W A S D · Q E · arrows</dt><dd>Fly and look</dd>
          <dt>[ ] · Space</dt><dd>Previous / next range · surprise jump</dd>
          <dt>V · H</dt><dd>Next viewpoint · back to the viewpoint</dd>
          <dt>1–7</dt><dd>Light: alpenglow, golden, midday, raking, backlit, blue hour, moonlight</dd>
          <dt>Shift + 1–5</dt><dd>Weather: summer, autumn, winter, storm, cloud sea</dd>
          <dt>T · O · L</dt><dd>Next style · next overlay · labels</dd>
          <dt>F · C</dt><dd>Fullscreen · copy a link to this exact view</dd>
        </dl>
        <p class="credits">Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> on AWS (USGS 3DEP, SRTM, GMTED2010, ETOPO1, Canada CDEM and others; <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">attribution</a>). Summits: GeoNames (CC BY 4.0). Ecoregions: RESOLVE 2017 (CC BY 4.0). Viewpoints computed by Ridgeview from the elevation data.</p>
      </section>
    `;
    this.$ = (s) => root.querySelector(s);
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act],[data-group]');
      if (!b) return;
      if (b.dataset.group) { cb.look(b.dataset.group, b.dataset.id); return; }
      const act = b.dataset.act;
      if (act === 'list') this.toggleList();
      else if (act === 'close-list') this.toggleList(false);
      else if (act === 'help') this.toggleHelp();
      else if (act === 'close-help') this.toggleHelp(false);
      else if (act === 'dock') this.toggleDock();
      else if (act === 'view') cb.view(Number(b.dataset.i));
      else if (act === 'range') { cb.range(b.dataset.id); this.toggleList(false); }
      else if (act !== 'quality') cb[act]?.();
    });
    this.$('select[data-act=quality]').addEventListener('change', (e) => cb.quality(e.target.value));
    const search = this.$('#list input');
    search.addEventListener('input', () => this._renderList(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = this.$('#list .ranges button'); if (first) first.click(); }
      if (e.key === 'Escape') this.toggleList(false);
    });
    this._renderList('');
    this.idle = 0;
    window.addEventListener('pointermove', () => this.wake());
    window.addEventListener('keydown', () => this.wake());
  }

  wake() { this.idle = 0; this.root.classList.remove('idle'); }
  tick(dt) {
    this.idle += dt;
    const panelOpen = !this.$('#list').hidden || !this.$('#help').hidden;
    if (this.idle > 5 && !panelOpen) this.root.classList.add('idle');
  }

  toggleList(force) {
    const el = this.$('#list');
    el.hidden = force === undefined ? !el.hidden : !force;
    if (!el.hidden) { const i = el.querySelector('input'); i.value = ''; this._renderList(''); setTimeout(() => i.focus(), 0); }
  }
  toggleHelp(force) { const el = this.$('#help'); el.hidden = force === undefined ? !el.hidden : !force; }
  toggleDock() {
    const d = this.$('#dock');
    d.classList.toggle('collapsed');
    d.querySelector('.dock-toggle').setAttribute('aria-expanded', String(!d.classList.contains('collapsed')));
  }

  _renderList(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = this.ranges.filter((r) => {
      const hay = `${r.name} ${r.region} ${r.summit?.name ?? ''} ${r.landmark ?? ''} ${r.biome}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    this.$('#list .ranges').innerHTML = items.map((r) => `
      <li><button data-act="range" data-id="${esc(r.id)}" class="${r.id === this.current?.id ? 'current' : ''}">
        <span class="n">${esc(r.name)}</span>
        <span class="m">${esc(r.summit?.name ?? r.landmark ?? '')}${r.summit ? ` · ${fmt(r.summit.elevationM)} m` : ''}</span>
        <span class="r">${esc(r.region)} · ${esc(BIOME_LABEL[r.biome] ?? r.biome)}</span>
      </button></li>`).join('') || '<li class="empty">No range matches.</li>';
  }

  setRange(range, viewIndex, index, total) {
    this.current = range;
    const t = this.$('#title');
    t.classList.remove('compact', 'show');
    void t.offsetWidth; // restart the reveal animation
    t.querySelector('.eyebrow').textContent = range.region;
    t.querySelector('h1').textContent = range.name;
    const s = range.summit;
    const peak = s?.name ?? range.landmark;
    t.querySelector('.sub').textContent = [peak, s ? `${fmt(s.elevationM)} m · ${fmt(s.elevationM * 3.28084)} ft` : null, BIOME_LABEL[range.biome]].filter(Boolean).join('  ·  ');
    this.setView(range, viewIndex);
    t.classList.add('show');
    clearTimeout(this._compactT);
    this._compactT = setTimeout(() => t.classList.add('compact'), 6500);
    this.$('.rname').textContent = range.name;
    this.$('.rcount').textContent = `${index + 1} / ${total}`;
  }

  setView(range, i) {
    const v = range.views[i];
    const where = v.eye.agl <= 5 ? 'standing' : `${fmt(v.eye.agl)} m above ground`;
    this.$('#title .viewinfo').textContent = `Viewpoint ${i + 1} of ${range.views.length} · ${(v.features.distanceM / 1000).toFixed(1)} km from the crest · ${where}`;
    this.$('.pips').innerHTML = range.views.map((_, k) => `<button data-act="view" data-i="${k}" class="${k === i ? 'on' : ''}" aria-label="Viewpoint ${k + 1}" title="Viewpoint ${k + 1} (V)">${k + 1}</button>`).join('');
  }

  setLook(groupName, id) {
    for (const b of this.root.querySelectorAll(`[data-group="${groupName}"]`)) {
      const on = b.dataset.id === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  setLabels(on) { const b = this.$('[data-act=labels]'); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); }
  setQuality(q) { this.$('select[data-act=quality]').value = q; }

  /** Big, letter-spaced caption that announces a change. */
  caption(text, sub = '') {
    const c = this.$('#caption');
    c.innerHTML = `<div>${esc(text)}</div>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    c.classList.remove('go');
    void c.offsetWidth;
    c.classList.add('go');
  }

  status({ lon, lat, h, agl, heading, loading }) {
    const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
    this.$('.coords').textContent = `${Math.abs(lat).toFixed(4)}° ${ns}  ${Math.abs(lon).toFixed(4)}° ${ew}  ·  ${String(Math.round(heading)).padStart(3, '0')}°`;
    this.$('.alt').textContent = h > 200000 ? `${fmt(h / 1000)} km up` : `${fmt(h)} m  ·  ${fmt(Math.max(0, agl))} m above ground`;
    this.$('.load').textContent = loading ? `streaming terrain · ${loading}` : '';
    this.$('.load').classList.toggle('busy', !!loading);
  }
}

function group(title, name, items, hint = '') {
  return `<div class="group"><h3>${title}${hint ? ` <kbd>${hint}</kbd>` : ''}</h3><div class="chips">${items.map((it) =>
    `<button class="chip" data-group="${name}" data-id="${it.id}" aria-pressed="false">${esc(it.label)}${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</button>`).join('')}</div></div>`;
}
