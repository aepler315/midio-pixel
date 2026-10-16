// Summit labels. Candidates are local maxima found in the terrain tiles on
// screen plus the known summits of the ranges; each is projected, tested
// for line of sight with a terrain ray, decluttered (higher peaks win) and
// pinned with a leader line. Selection refreshes a few times a second;
// positions update every frame.
import * as THREE from 'three';
import { lonLatToEcef, distance } from '../core/geo.js';

const MAX = 16;

export class Labels {
  constructor(root, engine, known = []) {
    this.engine = engine;
    // Named summits bucketed by 1-degree cell.
    this.grid = new Map();
    for (const k of known) {
      const key = `${Math.floor(k.lon)},${Math.floor(k.lat)}`;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(k);
    }
    this.el = document.createElement('div');
    this.el.className = 'labels';
    root.appendChild(this.el);
    this.pool = [];
    for (let i = 0; i < MAX; i++) {
      const d = document.createElement('div');
      d.className = 'peak';
      d.innerHTML = '<span class="peak-name"></span><span class="peak-elev"></span><i></i>';
      d.style.display = 'none';
      this.el.appendChild(d);
      this.pool.push(d);
    }
    this.active = [];
    this.enabled = true;
    this.next = 0;
    this._v = new THREE.Vector3();
  }

  setEnabled(on) { this.enabled = on; this.el.style.display = on ? '' : 'none'; }

  /** Named summits within ~1.5 degrees of a point. */
  near(lon, lat, r = 1) {
    const out = [];
    for (let y = Math.floor(lat) - r; y <= Math.floor(lat) + r; y++) {
      for (let x = Math.floor(lon) - r - 1; x <= Math.floor(lon) + r + 1; x++) {
        const b = this.grid.get(`${x},${y}`);
        if (b) out.push(...b);
      }
    }
    return out;
  }

  _candidates() {
    const e = this.engine, { lon, lat, h } = e.rig.lonLatH;
    if (h > 400000) return [];
    const out = [];
    for (const p of e.tiles.peaks()) out.push({ lon: p.lon, lat: p.lat, h: p.h, name: null });
    const known = this.near(lon, lat);
    this.known = known;
    for (const k of known) if (distance(lon, lat, k.lon, k.lat) < 90000) out.push({ ...k });
    // Merge near-duplicates; names and higher points win.
    out.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0) || b.h - a.h);
    const merged = [];
    for (const c of out) {
      const twin = merged.find((m) => distance(m.lon, m.lat, c.lon, c.lat) < 700);
      if (twin) { if (!twin.name && c.name) twin.name = c.name; continue; }
      merged.push(c);
    }
    // Snap names onto detected maxima.
    for (const m of merged) {
      if (m.name) continue;
      const k = this.known.find((q) => distance(q.lon, q.lat, m.lon, m.lat) < 900);
      if (k) m.name = k.name;
    }
    return merged;
  }

  _project(c) {
    const e = this.engine, cam = e.rig.pos;
    const p = lonLatToEcef(c.lon, c.lat, c.h + 4);
    this._v.set(p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]);
    const dist = this._v.length();
    this._v.project(e.camera);
    if (this._v.z > 1 || this._v.z < -1) return null;
    const x = (this._v.x * 0.5 + 0.5) * e.width, y = (-this._v.y * 0.5 + 0.5) * e.height;
    if (x < -40 || x > e.width + 40 || y < -20 || y > e.height + 20) return null;
    return { x, y, dist, p };
  }

  _visible(c, s) {
    const e = this.engine, cam = e.rig.pos;
    const d = [0, 1, 2].map((i) => (s.p[i] - cam[i]) / s.dist);
    const t = e.tiles.raycast(cam, d, s.dist + 50);
    return t === null || t > s.dist - Math.max(40, s.dist * 0.012);
  }

  /** Re-pick which summits to show. */
  refresh() {
    const e = this.engine;
    if (!this.enabled || e.looks.style === 'pixel') { this.active = []; return; }
    const cands = this._candidates()
      .map((c) => ({ c, s: this._project(c) }))
      .filter((x) => x.s && x.s.dist < 120000 && x.s.dist > 150);
    cands.sort((a, b) => (b.c.name ? 1 : 0) - (a.c.name ? 1 : 0) || b.c.h - a.c.h);
    const placed = [];
    let rays = 0;
    for (const x of cands) {
      if (placed.length >= MAX || rays > 28) break;
      if (placed.some((p) => Math.abs(p.s.x - x.s.x) < 110 && Math.abs(p.s.y - x.s.y) < 30)) continue;
      rays++;
      if (!this._visible(x.c, x.s)) continue;
      placed.push(x);
    }
    this.active = placed.map((x) => x.c);
  }

  update(now) {
    if (now > this.next) { this.refresh(); this.next = now + 300; }
    for (let i = 0; i < MAX; i++) {
      const d = this.pool[i], c = this.active[i];
      const s = c && this._project(c);
      if (!s) { d.style.display = 'none'; continue; }
      d.style.display = '';
      d.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      d.classList.toggle('named', !!c.name);
      const nm = d.firstChild, el = nm.nextSibling;
      const name = c.name ?? '';
      if (nm.textContent !== name) nm.textContent = name;
      const elev = `${Math.round(c.h).toLocaleString('en-US')} m`;
      if (el.textContent !== elev) el.textContent = elev;
    }
  }
}
