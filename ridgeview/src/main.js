// Ridgeview: jump between mountain ranges and look at their crests from
// viewpoints calculated to show them well.
import { Engine } from './engine/Engine.js';
import { resolveQuality } from './engine/TerrainTiles.js';
import { Controls } from './scene/Controls.js';
import { Flight } from './scene/Flight.js';
import { LIGHTS, WEATHERS, STYLES, OVERLAYS } from './scene/Looks.js';
import { Ui } from './ui/Ui.js';
import { Labels } from './ui/Labels.js';
import { DEG, clamp, distance, lonLatToEcef } from './core/geo.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
if (!document.createElement('canvas').getContext('webgl2')) {
  document.getElementById('ui').innerHTML = '<div class="panel" style="padding:24px;text-align:center"><h2 style="font:400 26px/1.2 var(--serif);margin:0 0 8px">Ridgeview needs WebGL 2</h2><p style="margin:0;color:var(--ink-dim)">Try a current version of Chrome, Edge, Firefox or Safari, with hardware acceleration on.</p></div>';
  throw new Error('WebGL2 unavailable');
}
const coarse = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const storedQuality = store.get('rv-quality');
let quality = resolveQuality(params.has('quality') ? params.get('quality') : storedQuality ?? (coarse ? 'medium' : 'high'));
const userPickedQuality = params.has('quality') || storedQuality !== null;
const engine = new Engine(canvas, { proxy: params.get('proxy') === '1', quality, preserve: params.has('test') });

const [data, peakData] = await Promise.all([
  fetch('data/viewpoints.json').then((r) => r.json()),
  fetch('data/peaks.json').then((r) => r.json()).catch(() => ({ peaks: [] })),
]);
const all = data.ranges.filter((r) => !r.rejected && r.views.length);
const ranges = tourOrder(all, 'tetons');
const known = peakData.peaks.map(([name, lon, lat, h]) => ({ name, lon, lat, h }));
// Name each range's measured summit after the nearest named peak.
for (const r of all) {
  if (r.summit?.name) continue;
  let best = null, bd = 1500;
  for (const k of known) {
    if (Math.abs(k.lat - r.summit.lat) > 0.02 || Math.abs(k.lon - r.summit.lon) > 0.03) continue;
    const d = distance(k.lon, k.lat, r.summit.lon, r.summit.lat);
    if (d < bd) { bd = d; best = k; }
  }
  if (best) r.summit.name = best.name;
}

/** Nearest-neighbour tour so [ and ] step to a nearby range. */
function tourOrder(list, startId) {
  const left = [...list], out = [];
  let cur = left.find((r) => r.id === startId) ?? left[0];
  while (cur) {
    out.push(cur);
    left.splice(left.indexOf(cur), 1);
    let best = null, bd = Infinity;
    for (const r of left) { const d = distance(cur.crest.lon, cur.crest.lat, r.crest.lon, r.crest.lat); if (d < bd) { bd = d; best = r; } }
    cur = best;
  }
  return out;
}

const state = { index: 0, view: 0, flight: null, free: false, pendingTitle: null, labels: true };
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const compass = (az) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

const ui = new Ui(document.getElementById('ui'), ranges, {
  prev: () => jump(-1),
  next: () => jump(1),
  surprise: () => surprise(),
  home: () => goTo(state.index, state.view),
  view: (i) => goTo(state.index, i),
  range: (id) => goTo(ranges.findIndex((r) => r.id === id), 0),
  look: (group, id) => setLook(group, id),
  labels: () => setLabels(!state.labels),
  quality: (q) => setQuality(q, true),
  fullscreen: () => toggleFullscreen(),
  share: () => shareLink(),
});
const labels = new Labels(document.getElementById('ui'), engine, known);
const controls = new Controls(canvas, engine, {
  onUserMove: () => {
    if (state.flight) { state.flight = null; engine.flightSpeed = 0; }
    state.free = true;
  },
});
controls.onScrub = (notches) => {
  const L = engine.looks;
  L.tweens = [];
  L.cur.sunAz += notches * 4;
  L.cur.sunEl = clamp(L.cur.sunEl - notches * 0.6, -20, 80);
};
ui.setQuality(quality);

// --- Viewpoints -------------------------------------------------------------

function vfovFor(hfov) {
  const aspect = engine.camera.aspect;
  const ref = (2 * Math.atan(Math.tan((hfov * DEG) / 2) / (16 / 9))) / DEG;
  const fit = (2 * Math.atan(Math.tan((hfov * DEG) / 2) / aspect)) / DEG;
  return clamp(Math.max(ref, fit), 20, 72);
}

function viewTarget(range, i) {
  const v = range.views[i];
  const g = engine.groundAt(v.eye.lon, v.eye.lat);
  const h = Number.isFinite(g) ? Math.max(v.eye.h, g + v.eye.agl) : v.eye.h;
  return { lon: v.eye.lon, lat: v.eye.lat, h, heading: v.heading, pitch: v.pitch, fov: vfovFor(v.hfov), lookDist: v.features.distanceM };
}

function lookContext(range, i) {
  const v = range.views[i];
  return { lon: v.eye.lon, lat: v.eye.lat, heading: v.heading, ground: v.eye.h - v.eye.agl, summit: range.summit.elevationM };
}

function goTo(index, view = 0, { instant = false } = {}) {
  if (index < 0) return;
  const range = ranges[index];
  view = clamp(view, 0, range.views.length - 1);
  const changed = index !== state.index || !state.started;
  state.index = index;
  state.view = view;
  state.free = false;
  state.started = true;
  const target = viewTarget(range, view);
  const ctx = lookContext(range, view);
  if (instant) {
    engine.rig.fov = target.fov;
    engine.rig.set(target.lon, target.lat, target.h, target.heading, target.pitch);
    engine.looks.setBiome(range.biome);
    engine.looks.setContext(ctx);
    ui.setRange(range, view, index, ranges.length);
    state.flight = null;
    return;
  }
  const f = new Flight(engine.rig, target, { heightAt: (lon, lat) => engine.groundAt(lon, lat) });
  state.flight = f;
  engine.looks.setBiome(range.biome, f.duration * 0.8);
  engine.looks.setContext(ctx, Math.max(2.4, f.duration * 0.9));
  engine.prefetchTarget = target;
  if (changed) state.pendingTitle = { range, view, at: 0.62 };
  else ui.setView(range, view);
  ui._renderList('');
}

function jump(step) {
  if (state.flight && state.flight.t < state.flight.duration * 0.5 && state.lastStep === step) { state.flight.skip(); return; }
  state.lastStep = step;
  goTo((state.index + step + ranges.length) % ranges.length, 0);
}

function surprise() {
  // A far jump: prefer ranges well away from here.
  const here = ranges[state.index];
  const far = ranges.filter((r) => r !== here && distance(r.crest.lon, r.crest.lat, here.crest.lon, here.crest.lat) > 1200000);
  const pool = far.length ? far : ranges.filter((r) => r !== here);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  goTo(ranges.indexOf(pick), Math.floor(Math.random() * pick.views.length));
}

// --- Looks ------------------------------------------------------------------

function lightCaption(id) {
  const c = engine.looks._target();
  const el = c.sunEl, az = c.sunAz;
  switch (id) {
    case 'alpenglow': return `Sun ${Math.abs(el).toFixed(1)}° below the horizon · only the summits still lit`;
    case 'golden': return `Sun ${el.toFixed(1)}° above the ${compass(az)} horizon`;
    case 'midday': return `Sun ${el.toFixed(0)}° high`;
    case 'raking': return `Light raking across the face from the ${compass(az)}`;
    case 'backlit': return `Sun behind the crest, ${el.toFixed(1)}° high in the ${compass(az)}`;
    case 'bluehour': return `Sun ${Math.abs(el).toFixed(1)}° below the horizon`;
    case 'moonlight': return `Moon ${c.moonEl.toFixed(0)}° high in the ${compass(c.moonAz)}`;
    default: return '';
  }
}

function weatherCaption(id) {
  const c = engine.looks._target();
  switch (id) {
    case 'summer': return 'Snow only where it lasts all year';
    case 'autumn': return 'Turning colour, first snow on the peaks';
    case 'winter': return 'Snow down to the valley floors';
    case 'storm': return 'Weather closing in over the range';
    case 'cloudsea': return `Inversion · cloud tops at ${fmt(c.cloudTop)} m`;
    default: return '';
  }
}

function setLook(group, id, { quiet = false } = {}) {
  const L = engine.looks;
  let changed = false;
  if (group === 'light') changed = L.setLight(id);
  else if (group === 'weather') {
    changed = L.setWeather(id);
    if (changed && id === 'cloudsea') liftAboveClouds();
  } else if (group === 'style') {
    if (id !== L.style) { if (!quiet) engine.beginWipe(0, 1.2); changed = L.setStyle(id); }
  } else if (group === 'overlay') {
    if (id !== L.overlay) { if (!quiet) engine.beginWipe(1, 1.0); changed = L.setOverlay(id); }
  }
  ui.setLook(group, id);
  if (!changed || quiet) return;
  const list = { light: LIGHTS, weather: WEATHERS, style: STYLES, overlay: OVERLAYS }[group];
  const label = list.find((x) => x.id === id)?.label ?? id;
  const sub = group === 'light' ? lightCaption(id) : group === 'weather' ? weatherCaption(id) : group === 'overlay' && id === 'slope' ? 'Yellow 30° · orange 35° · red 40° · purple 45°+' : '';
  ui.caption(label, sub);
  persist();
}

/** The cloud sea needs the viewer above it: rise through the clouds. */
function liftAboveClouds() {
  const top = engine.looks._target().cloudTop;
  const { lon, lat, h } = engine.rig.lonLatH;
  if (h > top + 150) return;
  const hp = engine.rig.headingPitch();
  state.flight = new Flight(engine.rig, { lon, lat, h: top + 260, heading: hp.heading, pitch: Math.min(hp.pitch, 4), fov: engine.rig.fov, lookDist: 12000 }, { heightAt: (a, b) => engine.groundAt(a, b) });
  state.flight.duration = 3.2;
}

function cycle(group, list, cur) {
  const i = list.findIndex((x) => x.id === cur);
  setLook(group, list[(i + 1) % list.length].id);
}

function setLabels(on) { state.labels = on; labels.setEnabled(on); ui.setLabels(on); persist(); }

function setQuality(q, byUser) {
  q = resolveQuality(q);
  quality = q;
  engine.setQuality(q);
  ui.setQuality(q);
  if (byUser) { try { localStorage.setItem('rv-quality', q); } catch { /* storage unavailable */ } }
}

/** A link that reopens exactly this view and look. */
function shareLink() {
  const { lon, lat, h } = engine.rig.lonLatH, hp = engine.rig.headingPitch(), L = engine.looks;
  const q = new URLSearchParams({
    range: ranges[state.index].id, view: String(state.view),
    light: L.light, weather: L.weather, style: L.style, overlay: L.overlay,
  });
  if (state.free) q.set('at', [lon.toFixed(5), lat.toFixed(5), h.toFixed(0), hp.heading.toFixed(1), hp.pitch.toFixed(1), engine.rig.fov.toFixed(1)].join(','));
  const url = `${location.origin}${location.pathname}?${q}`;
  navigator.clipboard?.writeText(url).then(() => ui.caption('Link copied', 'Paste it to share this exact view'), () => ui.caption('Link', url));
  history.replaceState(null, '', `?${q}`);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function persist() {
  try {
    const L = engine.looks;
    localStorage.setItem('rv-looks', JSON.stringify({ light: L.light, weather: L.weather, style: L.style, overlay: L.overlay, labels: state.labels }));
  } catch { /* storage unavailable */ }
}

window.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
  const L = engine.looks;
  if (e.code.startsWith('Digit') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const n = Number(e.code.slice(5));
    if (e.shiftKey && n >= 1 && n <= WEATHERS.length) { setLook('weather', WEATHERS[n - 1].id); e.preventDefault(); return; }
    if (!e.shiftKey && n >= 1 && n <= LIGHTS.length) { setLook('light', LIGHTS[n - 1].id); return; }
  }
  switch (e.key) {
    case '[': jump(-1); break;
    case ']': jump(1); break;
    case ' ': surprise(); e.preventDefault(); break;
    case 'v': case 'V': goTo(state.index, (state.view + 1) % ranges[state.index].views.length); break;
    case 'h': case 'H': goTo(state.index, state.view); break;
    case 't': case 'T': cycle('style', STYLES, L.style); break;
    case 'o': case 'O': cycle('overlay', OVERLAYS, L.overlay); break;
    case 'l': case 'L': setLabels(!state.labels); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'c': case 'C': shareLink(); break;
    case '?': case '/': ui.toggleHelp(); break;
    case 'Escape': ui.toggleList(false); ui.toggleHelp(false); break;
    default: return;
  }
});
window.addEventListener('resize', () => engine.resize());

// --- Start ------------------------------------------------------------------

let saved = {};
try { saved = JSON.parse(localStorage.getItem('rv-looks') || '{}'); } catch { /* none */ }
const startLook = {
  light: params.get('light') || saved.light || 'golden',
  weather: params.get('weather') || saved.weather || 'summer',
  style: params.get('style') || saved.style || 'natural',
  overlay: params.get('overlay') || saved.overlay || 'none',
};
const startIndex = Math.max(0, ranges.findIndex((r) => r.id === (params.get('range') || 'tetons')));
const startView = Number(params.get('view') || 0);
for (const g of ['light', 'weather', 'style', 'overlay']) setLook(g, startLook[g], { quiet: true });
setLabels(params.has('labels') ? params.get('labels') !== '0' : saved.labels ?? true);

const first = ranges[startIndex];
const at = params.get('at')?.split(',').map(Number);
if (at && at.length >= 5 && at.every(Number.isFinite)) {
  // Deep link to an exact pose: lon,lat,height,heading,pitch[,fov]
  goTo(startIndex, startView, { instant: true });
  engine.rig.fov = at[5] ?? engine.rig.fov;
  engine.rig.set(at[0], at[1], at[2], at[3], at[4]);
  state.free = true;
} else if (params.has('test') || params.has('instant')) {
  goTo(startIndex, startView, { instant: true });
} else {
  // Dive in from orbit.
  const c = first.crest;
  const p = lonLatToEcef(c.lon - 25, c.lat - 12, 1.6e7);
  engine.rig.pos = p;
  engine.rig.lookAt(lonLatToEcef(c.lon, c.lat, 0));
  engine.rig.fov = 40;
  engine.looks.setBiome(first.biome);
  engine.looks.setContext(lookContext(first, startView));
  state.started = false;
  goTo(startIndex, startView);
  state.flight.duration = 7.5;
}
engine.looks.cur = engine.looks._target();
engine.looks.tweens = [];
window.__rv = {
  engine, state, ranges, goTo, setLook, ui, controls, paused: false,
  /** Test hook: render exactly one frame (with labels) while paused. */
  still() { engine.frame(0); labels.refresh(); labels.update(performance.now()); },
};

// --- Frame loop ---------------------------------------------------------------

let last = performance.now(), statusT = 0, slow = 0;
function loop(now) {
  if (window.__rv.paused) { last = now; requestAnimationFrame(loop); return; }
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const f = state.flight;
  if (f) {
    f.update(dt);
    engine.rig.pos = f.rig.pos; engine.rig.q.copy(f.rig.q); engine.rig.fov = f.rig.fov;
    engine.flightSpeed = f.speed;
    const pt = state.pendingTitle;
    if (pt && f.t / f.duration >= pt.at) { ui.setRange(pt.range, pt.view, state.index, ranges.length); state.pendingTitle = null; }
    if (f.done) { state.flight = null; engine.flightSpeed = 0; engine.prefetchTarget = null; }
  } else {
    if (state.pendingTitle) { const pt = state.pendingTitle; ui.setRange(pt.range, pt.view, state.index, ranges.length); state.pendingTitle = null; }
    // At a viewpoint, hold the eye its intended height above the rendered
    // ground, once the ground under it is detailed enough to trust.
    if (!state.free) {
      const v = ranges[state.index].views[state.view];
      const { lon, lat, h } = engine.rig.lonLatH;
      const t = engine.tiles.tileAt(lon, lat);
      const g = engine.groundAt(lon, lat);
      if (t && t.z >= 13 && Number.isFinite(g) && Math.abs(h - (g + v.eye.agl)) > 0.5) {
        const hp = engine.rig.headingPitch();
        engine.rig.set(lon, lat, h + (g + v.eye.agl - h) * Math.min(1, dt * 3), hp.heading, hp.pitch);
      }
    }
    // Trees near a low viewpoint would hide the view it was chosen for.
    const vv = ranges[state.index].views[state.view];
    engine.trees.uniforms.uClearR.value = !state.free && vv.eye.agl < 50 ? 140 : 0;
    controls.update(dt);
  }
  engine.frame(dt);
  labels.update(now);
  ui.tick(dt);
  if ((statusT += dt) > 0.2) {
    statusT = 0;
    const { lon, lat, h } = engine.rig.lonLatH;
    const pend = engine.tiles.jobs.size + engine.dem.inFlight + engine.dem.queue.size;
    ui.status({ lon, lat, h, agl: engine.agl, heading: engine.rig.headingPitch().heading, loading: pend });
  }
  // Adaptive detail: step down if frames stay slow (unless the user chose).
  if (!userPickedQuality && !params.has('test')) {
    slow = dt > 1 / 28 ? slow + dt : Math.max(0, slow - dt * 0.5);
    if (slow > 4) {
      slow = 0;
      const order = ['low', 'medium', 'high', 'ultra'], i = order.indexOf(quality);
      if (i > 0) { setQuality(order[i - 1], false); ui.caption('Detail lowered', 'to keep the view smooth on this device'); }
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
