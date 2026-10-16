// The inhabited shore: the Range frame read in thirds -- starry sky on top,
// land through the middle, and the near sea across the bottom third, in
// place of the old ground strip. Three small residents live in it:
//   - Midio sails the sea on a little shard-built ship,
//   - Broshi wanders the beach along the shoreline, pausing to look up,
//   - Midasus glides through the sky with her baby stars in tow.
//
// Every pose is a pure function of heard time (and the nominal stage size),
// so seek, replay and export all draw the same frame for the same instant.
// Music only modulates small amplitudes (swell, sail belly, a hop, a lift);
// it never moves anyone along their route.
import { MIDIO_BODY, midioEyeMesh, MIDIO_EYE_SOCKET_R, BROSHI_BODY, BROSHI_HEAD, BROSHI_JAW, BROSHI_EYE, BROSHI_TAIL, MIDASUS_MESH, BABY_STAR_MESH } from '../render/meshes.js';
import { computeRestLengths, drawMeshEdges, drawGlowHalo, applyTransform } from '../render/MeshDrawer.js';
import { MIDIO_IDENTITY_HUE } from '../render/ColorLaw.js';
import { clamp, clamp01, mulberry32 } from '../utils/math.js';
import { hexToRgb, hexLerp } from '../utils/color.js';
import { capFlashAlpha } from '../ui/Accessibility.js';

/** Where the sea begins, as a fraction of frame height (rule of thirds). */
export const SEA_TOP_FRAC = 2 / 3;
/** Lower edge of the sky third. */
export const SKY_BOTTOM_FRAC = 1 / 3;

export const BROSHI_HUE = 16;   // warm coral: reads against sand and sea
export const MIDASUS_HUE = 276; // violet: reads against the night sky

const TAU = Math.PI * 2;
// Overscan (nominal px) so camera shake never exposes an edge of the sea.
const EDGE = 64;
const SHIP_PERIOD_S = 64;
const BROSHI_PERIOD_S = 30;
const MIDASUS_X_PERIOD_S = 53;
const MIDASUS_Y_PERIOD_S = 21;
const BABY_LAGS_S = [0.55, 0.95, 1.35];

const frac = (v) => v - Math.floor(v);
const smooth = (u) => u * u * (3 - 2 * u);

/** A small hop arc (0..1) after the kicks in `hits` (as recentConductorHits
 *  returns them): up and back down over 300 ms per kick. */
export function kickHop01(hits, nowMs) {
  // The highest of the overlapping arcs, so a kick landing mid-hop carries
  // him on up rather than snapping him back to the sand.
  let hop = 0;
  for (const hit of hits || []) {
    const dt = nowMs - hit.tMs;
    if (dt >= 0 && dt < 300) hop = Math.max(hop, hit.strength * Math.sin(Math.PI * dt / 300));
  }
  return hop;
}

/** The beach edge (top of the land strip in front of the sea) at x. Static
 *  per x so the shore reads as land, not water. */
export function shoreTopY(x, W, H) {
  const k = H / 720;
  const u = x / W;
  return H * SEA_TOP_FRAC - k * (9 + 4 * Math.sin(u * TAU * 2 + 0.7) + 2.5 * Math.sin(u * TAU * 5 + 2.1));
}

/** The waterline where the sea meets the beach at x and time t. */
export function waterlineY(x, W, H, tSec) {
  const k = H / 720;
  return H * SEA_TOP_FRAC + k * (1.5 * Math.sin(x / W * TAU * 4 - tSec * 0.9));
}

/** Sea surface offset (px) at x on a row at depth01 (0 = shore, 1 = nearest). */
export function swellY(x, W, H, tSec, depth01 = 1, bass = 0) {
  const k = H / 720 * (0.35 + 0.65 * depth01);
  const amp = 0.7 + 0.5 * clamp01(bass);
  const u = x / W;
  return k * amp * (4.2 * Math.sin(u * TAU * 3 - tSec * 1.05)
    + 2.2 * Math.sin(u * TAU * 7 + tSec * 1.6)
    + 1.1 * Math.sin(u * TAU * 13 - tSec * 2.3));
}

/** Midio's ship: sails left to right across the near sea and comes round
 *  again, pitching on the swell. */
export function shipPose(tSec, W, H, { bass = 0, energy = 0, reducedMotion = false } = {}) {
  const k = H / 720;
  const u = frac(tSec / SHIP_PERIOD_S + 0.22);
  const x = -0.1 * W + u * 1.2 * W;
  const baseY = H * (SEA_TOP_FRAC + 0.13);
  const depth = 0.55;
  const bob = reducedMotion ? 0 : swellY(x, W, H, tSec, depth, bass);
  const dx = 6;
  const slope = reducedMotion ? 0 : (swellY(x + dx, W, H, tSec, depth, bass) - swellY(x - dx, W, H, tSec, depth, bass)) / (2 * dx);
  return {
    x, y: baseY + bob, rot: clamp(Math.atan(slope) * 0.9, -0.22, 0.22),
    scale: 0.8 * k, billow01: 0.45 + 0.55 * clamp01(energy), heading: 1,
  };
}

/** Broshi: wanders the beach -- walk, stop and look up, walk back. */
export function broshiPose(tSec, W, H, { kick = 0, reducedMotion = false } = {}) {
  const k = H / 720;
  const p = frac(tSec / BROSHI_PERIOD_S) * BROSHI_PERIOD_S;
  const x0 = 0.1 * W, x1 = 0.5 * W;
  let x, facing, walking, lookUp01 = 0;
  if (p < 11) { x = x0 + (x1 - x0) * smooth(p / 11); facing = 1; walking = true; }
  else if (p < 15) { x = x1; facing = 1; walking = false; lookUp01 = Math.sin(Math.PI * (p - 11) / 4); }
  else if (p < 26) { x = x1 + (x0 - x1) * smooth((p - 15) / 11); facing = -1; walking = true; }
  else { x = x0; facing = -1; walking = false; lookUp01 = Math.sin(Math.PI * (p - 26) / 4); }
  const step = tSec * 2.4;
  const stride = walking && !reducedMotion ? Math.sin(step * TAU) : 0;
  const bob = walking && !reducedMotion ? Math.abs(Math.sin(step * Math.PI * 2)) * 1.6 * k : 0;
  const hop = reducedMotion ? 0 : 8 * k * clamp01(kick);
  const y = shoreTopY(x, W, H) + 2 * k - bob - hop;
  return { x, y, facing, walking, stride, lookUp01, scale: 1.0 * k, airborne: bob + hop };
}

/** Midasus: a slow looping glide through the sky third. */
export function midasusPose(tSec, W, H, { treble = 0, reducedMotion = false } = {}) {
  const at = (t) => ({
    x: W * (0.5 + 0.4 * Math.sin(TAU * t / MIDASUS_X_PERIOD_S + 0.4)),
    y: H * (0.13 + 0.075 * Math.sin(TAU * t / MIDASUS_Y_PERIOD_S + 1.1)),
  });
  const p = at(tSec);
  const q = at(tSec + 0.1);
  const lift = reducedMotion ? 0 : H * 0.02 * clamp01(treble);
  const vx = (q.x - p.x) / 0.1;
  const trail = [];
  for (let i = 1; i <= 9; i++) trail.push(at(tSec - i * 0.11));
  const babies = BABY_LAGS_S.map((lag, i) => {
    const b = at(tSec - lag);
    const a = (reducedMotion ? 0 : tSec * 1.7) + i * TAU / 3;
    const r = H / 720 * 9;
    return { x: b.x + Math.cos(a) * r, y: b.y + Math.sin(a) * r * 0.6 };
  });
  return { x: p.x, y: p.y - lift, bank: clamp(vx * 0.004, -0.5, 0.5), spin: reducedMotion ? 0 : tSec * 0.5,
    scale: 1.25 * H / 720, trail, babies };
}

const REST = {
  midio: computeRestLengths(MIDIO_BODY),
  broshiBody: computeRestLengths(BROSHI_BODY),
  broshiHead: computeRestLengths(BROSHI_HEAD),
  broshiJaw: computeRestLengths(BROSHI_JAW),
  broshiEye: computeRestLengths(BROSHI_EYE),
  broshiTail: computeRestLengths(BROSHI_TAIL),
  midasus: computeRestLengths(MIDASUS_MESH),
  baby: computeRestLengths(BABY_STAR_MESH),
};

function drawMesh(ctx, mesh, rest, transform, hue, options, local = null) {
  const points = mesh.vertices.map((v) => applyTransform(local ? local(v) : v, transform));
  drawMeshEdges(ctx, mesh, rest, points, hue, options);
  return points;
}

function rotateAbout(px, py, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return (v) => ({ x: px + (v.x - px) * c - (v.y - py) * s, y: py + (v.x - px) * s + (v.y - py) * c });
}

function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Paint the near sea (with its beach) over the bottom third, then the three
 * residents. `ctx` must be in nominal stage space (W x H).
 */
export function drawInhabitedShore(ctx, {
  W, H, tSec, bands = null, kick = 0, airColor = '#2a3850', landColor = '#3a3024', haloColor = '#ffffff',
  night01 = 0.5, celestial = null, glitterX = null, reducedMotion = false, reducedFlash = false,
}) {
  const eq = bands || [];
  const avg = (i, j) => { let s = 0, n = 0; for (let b = i; b <= j; b++) { s += eq[b] || 0; n++; } return n ? s / n : 0; };
  const bass = avg(0, 1), mid = avg(2, 4), treble = avg(5, 6);
  const energy = (bass + mid + treble) / 3;
  const k = H / 720;
  const motion = { bass, energy, kick, treble, reducedMotion };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Reduced motion holds the sea still: one fixed wave phase, no swell.
  drawSea(ctx, { W, H, tSec: reducedMotion ? 0 : tSec, bass: reducedMotion ? 0 : bass, treble, airColor, landColor, haloColor, night01, celestial, glitterX, reducedFlash, k });

  // Midasus first: she is the farthest resident, up in the sky third.
  const midasus = midasusPose(tSec, W, H, motion);
  drawMidasus(ctx, midasus, { night01, reducedFlash });
  drawBroshi(ctx, broshiPose(tSec, W, H, motion), { k });
  // Reduced motion also stills the wake, pennant and Midio's hover.
  drawShip(ctx, shipPose(tSec, W, H, motion), { tSec: reducedMotion ? 0 : tSec, night01, landColor, k, reducedFlash, lookAt: midasus });
  ctx.restore();
}

function drawSea(ctx, { W, H, tSec, bass, treble, airColor, landColor, haloColor, night01, celestial, glitterX, reducedFlash, k }) {
  const seaTop = H * SEA_TOP_FRAC;
  const N = 48;
  // Beach: a strip of land in front of the sea, so the earth third ends on
  // a shore rather than a cut.
  const sand = hexLerp(landColor, airColor, 0.18);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = -EDGE + (i / N) * (W + 2 * EDGE);
    const y = shoreTopY(x, W, H);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(W + EDGE, seaTop + 6 * k);
  ctx.lineTo(-EDGE, seaTop + 6 * k);
  ctx.closePath();
  const beach = ctx.createLinearGradient(0, seaTop - 16 * k, 0, seaTop + 6 * k);
  beach.addColorStop(0, hexLerp(sand, '#000000', 0.2));
  beach.addColorStop(1, sand);
  ctx.fillStyle = beach;
  ctx.fill();

  // Water body: reflected sky at the shore, deepening toward the viewer.
  const surface = hexLerp(airColor, '#1f8ea3', 0.78);
  const deep = hexLerp(airColor, '#032531', 0.9);
  const darken = 0.25 * clamp01(night01);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = -EDGE + (i / N) * (W + 2 * EDGE);
    const y = waterlineY(x, W, H, tSec);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(W + EDGE, H + EDGE);
  ctx.lineTo(-EDGE, H + EDGE);
  ctx.closePath();
  const body = ctx.createLinearGradient(0, seaTop, 0, H);
  body.addColorStop(0, hexLerp(hexLerp(surface, airColor, 0.3), '#000000', darken));
  body.addColorStop(0.35, hexLerp(hexLerp(surface, deep, 0.55), '#000000', darken));
  body.addColorStop(1, hexLerp(deep, '#000000', darken));
  ctx.fillStyle = body;
  ctx.fill();

  // Shore foam along the waterline.
  if (!reducedFlash) {
    ctx.strokeStyle = rgba(hexLerp(haloColor, '#ffffff', 0.5), 0.35);
    ctx.lineWidth = 1.6 * k;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * W;
      const y = waterlineY(x, W, H, tSec) + 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Wave rows in perspective: dense at the shore, wide apart up close.
  const rows = 11;
  const crest = hexLerp(hexLerp(surface, '#ffffff', 0.35), haloColor, 0.25);
  for (let j = 0; j < rows; j++) {
    const d = (j + 1) / (rows + 1);
    const depth01 = Math.pow(d, 1.6);
    const y0 = seaTop + (H - seaTop) * depth01;
    ctx.strokeStyle = rgba(crest, 0.1 + 0.16 * (1 - d));
    ctx.lineWidth = (0.8 + 1.6 * depth01) * k;
    ctx.beginPath();
    const phase = j * 1.37;
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * W;
      const y = y0 + swellY(x + phase * 97, W, H, tSec + phase, depth01, bass);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Glitter path under whichever sun or moon is up.
  const bodyName = celestial?.activeBody;
  const lit = bodyName ? celestial[bodyName] : null;
  if (lit && lit.visibility > 0.02) {
    // The body's on-screen x (the caller maps it from the scenic stage).
    const cx = Number.isFinite(glitterX) ? glitterX : lit.xFrac * W;
    // Reduced flash holds one glint layout instead of reshuffling 6x/s.
    const rand = mulberry32(0x5ea + (reducedFlash ? 0 : Math.floor(tSec * 6)));
    const color = hexLerp(lit.colorHex || '#ffffff', '#ffffff', 0.3);
    const glints = reducedFlash ? 26 : 60;
    ctx.fillStyle = color;
    for (let i = 0; i < glints; i++) {
      const d = rand();
      const y = seaTop + 3 * k + (H - seaTop) * d * d;
      const spread = (18 + 120 * d) * k;
      const x = cx + (rand() * 2 - 1) * spread * (0.4 + 0.6 * rand());
      const w = (3 + 12 * d) * k * (0.5 + rand());
      ctx.globalAlpha = capFlashAlpha(lit.visibility * (0.18 + 0.4 * (1 - Math.abs(x - cx) / (spread + 1))) * (0.6 + 0.4 * clamp01(treble)), reducedFlash);
      ctx.fillRect(x - w / 2, y, w, Math.max(1, 1.4 * k));
    }
    ctx.globalAlpha = 1;
  }
}

function drawMidasus(ctx, pose, { night01, reducedFlash }) {
  const hue = MIDASUS_HUE;
  // Sparkle trail along the path she just flew.
  for (let i = 0; i < pose.trail.length; i++) {
    const p = pose.trail[i];
    const a = (1 - i / pose.trail.length) * 0.45;
    ctx.fillStyle = `hsla(${hue},80%,82%,${a.toFixed(3)})`;
    const r = (1.6 - i * 0.12) * pose.scale;
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, r), 0, Math.PI * 2); ctx.fill();
  }
  drawGlowHalo(ctx, pose.x, pose.y, 26 * pose.scale, 26 * pose.scale, hue, reducedFlash ? 0.25 : 0.4 + 0.2 * clamp01(night01));
  drawMesh(ctx, MIDASUS_MESH, REST.midasus, { tx: pose.x, ty: pose.y, rot: pose.spin + pose.bank, scaleX: pose.scale, scaleY: pose.scale },
    hue, { alpha: 0.95, widthBase: 1.3, outline: { widthAdd: 1.6 } });
  for (const b of pose.babies) {
    drawGlowHalo(ctx, b.x, b.y, 8 * pose.scale, 8 * pose.scale, hue, 0.25);
    drawMesh(ctx, BABY_STAR_MESH, REST.baby, { tx: b.x, ty: b.y, rot: -pose.spin * 1.5, scaleX: pose.scale * 0.9, scaleY: pose.scale * 0.9 },
      hue, { alpha: 0.85, widthBase: 0.9 });
  }
}

function drawBroshi(ctx, pose, { k }) {
  const hue = BROSHI_HUE;
  const t = { tx: pose.x, ty: pose.y, scaleX: pose.scale * pose.facing, scaleY: pose.scale };
  // Contact shadow on the sand, shrinking as he leaves the ground.
  ctx.fillStyle = `rgba(0,0,0,${(0.3 * (1 - clamp01(pose.airborne / (12 * k)))).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(pose.x, pose.y + pose.airborne + 1 * k, 17 * pose.scale, 3 * pose.scale, 0, 0, Math.PI * 2);
  ctx.fill();
  const opts = { alpha: 0.95, widthBase: 1.2, outline: { widthAdd: 1.4 } };
  // Legs: the two ground spikes step in opposition while he walks.
  const legs = (v) => {
    if (v === BROSHI_BODY.vertices[7]) return { x: v.x + 3 * pose.stride, y: v.y };
    if (v === BROSHI_BODY.vertices[9]) return { x: v.x - 3 * pose.stride, y: v.y };
    return v;
  };
  const tail = rotateAbout(-26, -16, 0.25 * Math.sin(pose.stride * 1.3 + pose.x * 0.05));
  drawMesh(ctx, BROSHI_TAIL, REST.broshiTail, t, hue, opts, tail);
  drawMesh(ctx, BROSHI_BODY, REST.broshiBody, t, hue, opts, legs);
  // Head tips up toward the sky when he stops to look around.
  const head = rotateAbout(8, -14, -0.55 * pose.lookUp01);
  drawMesh(ctx, BROSHI_HEAD, REST.broshiHead, t, hue, opts, head);
  drawMesh(ctx, BROSHI_JAW, REST.broshiJaw, t, hue, opts, head);
  drawMesh(ctx, BROSHI_EYE, REST.broshiEye, t, hue, { alpha: 0.95, widthBase: 0.9 }, head);
}

// Ship hull/sail in ship-local units (about 96 long), keel at y=0 on the
// waterline, bow toward +x.
const HULL = [
  { x: -44, y: -12 }, { x: 38, y: -12 }, { x: 50, y: -20 }, { x: 34, y: 4 }, { x: -34, y: 4 },
];
const MAST_X = 2;

function drawShip(ctx, pose, { tSec, night01, landColor, k, reducedFlash, lookAt }) {
  const hue = MIDIO_IDENTITY_HUE;
  const s = pose.scale;
  ctx.save();
  ctx.translate(pose.x, pose.y);
  // Wake: foam spreading behind the stern.
  ctx.strokeStyle = 'rgba(220,240,245,0.18)';
  ctx.lineWidth = 1.2 * k;
  for (let i = 0; i < 3; i++) {
    const len = (40 + 26 * i) * s;
    const wob = Math.sin(tSec * 3 + i) * 1.5 * s;
    ctx.beginPath();
    ctx.moveTo(-34 * s, 2 * s);
    ctx.quadraticCurveTo(-34 * s - len * 0.5, (4 + 3 * i) * s + wob, -34 * s - len, (7 + 5 * i) * s);
    ctx.stroke();
  }
  ctx.rotate(pose.rot);
  // Hull shadow on the water.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(0, 5 * s, 46 * s, 5 * s, 0, 0, Math.PI * 2); ctx.fill();
  // Hull.
  ctx.beginPath();
  HULL.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
  ctx.closePath();
  ctx.fillStyle = hexLerp(landColor, '#120e0a', 0.5);
  ctx.fill();
  ctx.strokeStyle = `hsla(${hue},60%,62%,0.9)`;
  ctx.lineWidth = 1.3 * k;
  ctx.stroke();
  // Hull facets, in the same shard language as the residents.
  ctx.beginPath();
  ctx.moveTo(-34 * s, 4 * s); ctx.lineTo(-10 * s, -12 * s); ctx.lineTo(12 * s, 4 * s); ctx.lineTo(38 * s, -12 * s);
  ctx.strokeStyle = `hsla(${hue},55%,55%,0.45)`;
  ctx.lineWidth = 0.9 * k;
  ctx.stroke();
  // Mast and sail. The sail's belly fills with the music's energy.
  const top = -86, foot = -16;
  ctx.strokeStyle = 'rgba(230,225,210,0.9)';
  ctx.lineWidth = 1.4 * k;
  ctx.beginPath(); ctx.moveTo(MAST_X * s, -12 * s); ctx.lineTo(MAST_X * s, top * s); ctx.stroke();
  const belly = (14 + 16 * pose.billow01) * s;
  ctx.beginPath();
  ctx.moveTo(MAST_X * s + 1, (top + 4) * s);
  ctx.quadraticCurveTo(MAST_X * s + belly * 1.6, (top + foot) * 0.5 * s, MAST_X * s + 30 * s, foot * s);
  ctx.lineTo(MAST_X * s + 1, foot * s);
  ctx.closePath();
  ctx.fillStyle = `rgba(236,230,214,${(0.78 - 0.25 * clamp01(night01)).toFixed(3)})`;
  ctx.fill();
  ctx.strokeStyle = `hsla(${hue},45%,70%,0.8)`;
  ctx.lineWidth = 1 * k;
  ctx.stroke();
  // Jib forward of the mast.
  ctx.beginPath();
  ctx.moveTo(MAST_X * s - 1, (top + 10) * s);
  ctx.lineTo(-30 * s, -14 * s);
  ctx.lineTo(MAST_X * s - 1, -14 * s);
  ctx.closePath();
  ctx.fillStyle = `rgba(236,230,214,${(0.55 - 0.2 * clamp01(night01)).toFixed(3)})`;
  ctx.fill();
  // Pennant streaming aft from the masthead.
  const flap = Math.sin(tSec * 7) * 2 * s;
  ctx.beginPath();
  ctx.moveTo(MAST_X * s, top * s);
  ctx.lineTo((MAST_X - 14) * s, top * s + 2 * s + flap);
  ctx.lineTo(MAST_X * s, (top + 5) * s);
  ctx.fillStyle = `hsl(${hue},70%,58%)`;
  ctx.fill();
  // Masthead lantern at night.
  if (night01 > 0.2) drawGlowHalo(ctx, MAST_X * s, (top + 8) * s, 12 * s, 12 * s, 42, (reducedFlash ? 0.25 : 0.45) * clamp01((night01 - 0.2) / 0.5));
  ctx.restore();

  // Midio stands on the aft deck, hovering a hair above it, and keeps an
  // eye on Midasus overhead.
  const deck = applyTransform({ x: -22 * s, y: -12 * s }, { tx: pose.x, ty: pose.y, rot: pose.rot });
  const ms = s * 0.55;
  const hover = 2 * s + Math.sin(tSec * 1.7) * 1.2 * s;
  const mx = deck.x, my = deck.y - hover;
  let ix = 0, iy = 0;
  if (lookAt) {
    const dx = lookAt.x - mx, dy = lookAt.y - (my - 31 * ms);
    const d = Math.hypot(dx, dy) || 1;
    ix = (dx / d) * MIDIO_EYE_SOCKET_R * 0.8;
    iy = (dy / d) * MIDIO_EYE_SOCKET_R * 0.8;
  }
  drawGlowHalo(ctx, mx, my - 30 * ms, 20 * ms, 26 * ms, hue, reducedFlash ? 0.15 : 0.28);
  const t = { tx: mx, ty: my, rot: pose.rot * 0.5, scaleX: ms, scaleY: ms };
  drawMesh(ctx, MIDIO_BODY, REST.midio, t, hue, { alpha: 0.95, widthBase: 1.3, outline: { widthAdd: 1.5 } });
  const eye = midioEyeMesh(ix, iy);
  drawMesh(ctx, eye, computeRestLengths(eye), t, hue, { alpha: 1, widthBase: 2 });
}

