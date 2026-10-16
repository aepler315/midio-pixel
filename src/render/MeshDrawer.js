// Applies a per-frame pose transform to a rest-pose mesh and strokes each
// edge with a color derived purely from its own geometry (follow-up item
// 1): hue from the edge's screen-space angle, brightness/glow from how far
// its current length has deformed from rest. Squash-and-stretch, jaw
// snaps, and neck bobs all become visible motion this way, for free.
import { curl2 } from '../utils/fields.js';
import { hexToRgb, rgbToHsl } from '../utils/color.js';

const RIM_LIGHT_RANGE = 26; // max lightness swing (+/-) a fully-facing/fully-averted edge can pick up
const RIM_HUE_BLEND = 0.35; // max fraction an edge's hue shifts toward the light's hue on its lit side

const _scratchPool = [];
function _getScratch(n) {
  for (let i = 0; i < _scratchPool.length; i++) {
    if (_scratchPool[i].length >= n) return _scratchPool.splice(i, 1)[0];
  }
  const arr = new Array(n);
  for (let j = 0; j < n; j++) arr[j] = { x: 0, y: 0 };
  return arr;
}
function _releaseScratch(arr) {
  if (_scratchPool.length < 8) _scratchPool.push(arr);
}

/** Shortest signed hue delta from a to b, in degrees, through whichever direction around the wheel is shorter. */
function hueDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/** A light's hue, read directly off `hueDeg` when a source already works in
 *  hue-degrees (a character's own glow) rather than round-tripping through
 *  a hex color it never otherwise needed. Falls back to parsing `colorHex`
 *  (the celestial's own light shape) so both kinds of source work here. */
function lightHueOf(light) {
  if (typeof light.hueDeg === 'number') return light.hueDeg;
  if (light.colorHex) {
    const rgb = hexToRgb(light.colorHex);
    return rgbToHsl(rgb.r, rgb.g, rgb.b).h;
  }
  return null;
}

/** Precompute each edge's local (undeformed) length once per mesh. */
export function computeRestLengths(mesh) {
  return mesh.edges.map(([i, j]) => {
    const a = mesh.vertices[i], b = mesh.vertices[j];
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
}

/** Matches canvas composition order translate*rotate*scale applied to v.
 *  rotX/rotY add an optional orthographic tumble (same math as SpaceRidge's
 *  wireframe projection, mesh z implicit 0) applied before the flat rotate/
 *  scale/translate: rotY foreshortens width as the glyph turns to face a
 *  new direction, rotX foreshortens height as it tips forward/back. Both
 *  default to 0 (a no-op, zero extra cost) -- meant for rare, brief
 *  transition accents, not a resting pose. */
export function applyTransform(v, { tx = 0, ty = 0, rot = 0, scaleX = 1, scaleY = 1, rotX = 0, rotY = 0 }) {
  let vx = v.x, vy = v.y;
  if (rotX !== 0 || rotY !== 0) {
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const y1 = vy * cosX;
    const z1 = vy * sinX;
    vx = vx * cosY + z1 * sinY;
    vy = y1;
  }
  const sx = vx * scaleX, sy = vy * scaleY;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return { x: tx + sx * cos - sy * sin, y: ty + sx * sin + sy * cos };
}

/**
 * Draws one mesh part already resolved to screen-space points.
 * @param {{x:number,y:number}[]} points same length/order as mesh.vertices
 */
export function drawMeshEdges(ctx, mesh, restLengths, points, baseHueDeg, {
  satBase = 68, lightBase = 52, glowBoost = 34, alpha = 0.9, widthBase = 1.6, widthGlow = 2.0,
  outline = false, // true -> a near-black contour pass UNDER the spectral stroke: the silhouette reads razor-sharp against the glow underlays
  light = null, // Movement VII: the celestial light modulates the angle-derived hue/lightness above, it never replaces it
  lights = null, // secondary, local, falloff-limited sources (a kick-synced ground pulse, a nearby character's own glow) -- see LightField.js
  rimAmount = 0.6,
} = {}) {
  // Normalized to a flat list once per call, not per edge. `light` (the
  // celestial) has no radius, so it never falls off with distance --
  // exactly its old, single-source behavior when `lights` is omitted.
  // Anything in `lights` DOES fall off, since it's meant to light up
  // whoever's nearby, not the whole scene.
  const litMeta = [];
  if (rimAmount > 0) {
    const collect = (L) => {
      if (!L || !(L.intensity > 0.01)) return;
      const hue = lightHueOf(L);
      if (hue === null) return;
      litMeta.push({ x: L.x, y: L.y, intensity: L.intensity, radius: L.radius ?? Infinity, hue });
    };
    collect(light);
    if (lights) for (const L of lights) collect(L);
  }

  if (outline) {
    const o = outline === true ? {} : outline;
    ctx.save();
    ctx.strokeStyle = o.color || 'rgba(7,10,20,0.85)';
    ctx.lineWidth = widthBase + (o.widthAdd ?? 2.4);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [i, j] of mesh.edges) {
      ctx.moveTo(points[i].x, points[i].y);
      ctx.lineTo(points[j].x, points[j].y);
    }
    ctx.stroke();
    ctx.restore();
  }
  for (let e = 0; e < mesh.edges.length; e++) {
    const [i, j] = mesh.edges[e];
    const a = points[i], b = points[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // The color law: a character's hue is a constant the player can
    // trust, not a function of which way an edge happens to be pointing
    // on screen. Used to derive part of `hue` from the edge's own
    // screen-space angle (+/-hueSpread/2 around baseHueDeg) -- every mesh-
    // drawn character read as a spectral gradient across its own edges
    // instead of one flat, identifiable color. Rim lighting (below) is a
    // different, legitimate mechanism -- it still modulates hue toward a
    // real light source -- and is untouched.
    let hue = baseHueDeg;
    const rest = restLengths[e];
    const deform = rest > 0.001 ? Math.abs(len - rest) / rest : 0;
    const glow = Math.min(1, deform * 3);

    let lightness = Math.min(88, lightBase + glow * glowBoost);
    const sat = Math.min(100, satBase + glow * 22);

    if (litMeta.length && len > 0.001) {
      // Rim light: how much this edge faces each source versus turns away
      // from it, from the edge's own normal -- a stylized cue, not a
      // physically exact one, since these are open wireframe strokes with
      // no defined front face. Summed across every source in range; the
      // single strongest contributor's hue is what the edge tints toward,
      // so overlapping lights don't muddy into an average color.
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      const nx = dy / len, ny = -dx / len;
      let totalAmt = 0, domAmt = 0, domHue = null;
      for (const L of litMeta) {
        let tlx = L.x - midX, tly = L.y - midY;
        const dist = Math.hypot(tlx, tly) || 1;
        if (dist > L.radius) continue; // out of a local light's reach
        tlx /= dist; tly /= dist;
        const facing = nx * tlx + ny * tly; // -1 (fully averted) .. +1 (fully facing)
        const falloff = L.radius === Infinity ? 1 : Math.max(0, 1 - dist / L.radius);
        const amt = facing * L.intensity * rimAmount * falloff;
        totalAmt += amt;
        if (Math.abs(amt) > Math.abs(domAmt)) { domAmt = amt; domHue = L.hue; }
      }
      if (totalAmt !== 0) {
        lightness = Math.max(4, Math.min(92, lightness + totalAmt * RIM_LIGHT_RANGE));
        if (domAmt > 0 && domHue !== null) hue = (hue + hueDelta(hue, domHue) * Math.min(1, domAmt) * RIM_HUE_BLEND + 360) % 360;
      }
    }

    if (glow > 0.15) {
      ctx.strokeStyle = `hsla(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${lightness.toFixed(0)}%, ${(alpha * 0.35).toFixed(2)})`;
      ctx.lineWidth = widthBase + widthGlow * glow + 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.strokeStyle = `hsla(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${lightness.toFixed(0)}%, ${alpha})`;
    ctx.lineWidth = widthBase + widthGlow * glow;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/** Convenience: transform every vertex of a mesh with a single rigid transform, then draw. */
export function drawMeshPart(ctx, mesh, restLengths, transform, baseHueDeg, options) {
  const scratch = _getScratch(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const t = applyTransform(mesh.vertices[i], transform);
    scratch[i].x = t.x; scratch[i].y = t.y;
  }
  drawMeshEdges(ctx, mesh, restLengths, scratch, baseHueDeg, options);
  _releaseScratch(scratch);
  return scratch;
}

/**
 * Additive soft halo: a hue-tinted radial gradient (opaque center -> fully
 * transparent edge) filled into an ellipse. Stands in for the old "blurred,
 * enlarged, additive mesh copy" under-glow trick without a `ctx.filter`
 * blur -- on mobile Canvas2D every `filter` use forces an offscreen layer
 * allocation + GPU flush, which a plain gradient fill avoids entirely.
 */
export function drawGlowHalo(ctx, cx, cy, rx, ry, hueDeg, alpha, { sat = 70, light = 74 } = {}) {
  if (alpha <= 0.002 || rx <= 0.5 || ry <= 0.5) return;
  const r = Math.max(rx, ry);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `hsl(${hueDeg.toFixed(0)},${sat}%,${light}%)`);
  g.addColorStop(1, `hsla(${hueDeg.toFixed(0)},${sat}%,${light}%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The salvia melt: every vertex flows through a slow divergence-free
 * curl-noise field, so the form is never at rest -- a liquid instrument
 * rather than a rigid glyph. Two incommensurate field samples blend so
 * the flow never settles into a loop. Rest lengths are NOT recomputed:
 * the melt registers as continuous edge deformation, which the drawer
 * turns into shifting glow and hue -- the body itself plays.
 */
export function meltMesh(mesh, cx, cy, tSec, amt, seed = 0) {
  if (amt <= 0.02) return mesh;
  const scratch = _getScratch(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    const dx = v.x - cx, dy = v.y - cy;
    if (dx * dx + dy * dy < 4) { scratch[i].x = v.x; scratch[i].y = v.y; continue; }
    const f = curl2((v.x + seed * 37.7) * 0.028, (v.y - seed * 11.3) * 0.028, tSec * 0.21 + seed);
    const g = curl2((v.y + seed * 5.1) * 0.041, v.x * 0.041, tSec * 0.34 - seed * 2);
    scratch[i].x = v.x + (f.x * 0.7 + g.x * 0.3) * amt;
    scratch[i].y = v.y + (f.y * 0.7 + g.y * 0.3) * amt;
  }
  return { vertices: scratch, edges: mesh.edges, _scratch: scratch };
}

/**
 * Per-vertex lerp between two meshes that share vertex count and edge
 * topology (spec: the Apotheosis morph) -- t=0 is exactly meshA, t=1 is
 * exactly meshB, continuous in between. Edges are taken from meshA since
 * the two are required to be topologically identical.
 */
export function lerpMesh(meshA, meshB, t) {
  if (t <= 0) return meshA;
  if (t >= 1) return meshB;
  const scratch = _getScratch(meshA.vertices.length);
  for (let i = 0; i < meshA.vertices.length; i++) {
    const v = meshA.vertices[i], w = meshB.vertices[i];
    scratch[i].x = v.x + (w.x - v.x) * t;
    scratch[i].y = v.y + (w.y - v.y) * t;
  }
  return { vertices: scratch, edges: meshA.edges, _scratch: scratch };
}

/**
 * Radially displace a mesh's vertices about (cx,cy) by a ModalRing-style
 * field (anything with .energy and .displacementAt(theta)). Rest lengths
 * are intentionally NOT recomputed: displacement changes edge lengths
 * relative to rest, which is exactly what drives the glow/brightness in
 * drawMeshEdges -- the vibration lights the wireframe up for free.
 */
export function displaceMeshRadial(mesh, cx, cy, field) {
  if (!field || field.energy < 0.05) return mesh;
  const scratch = _getScratch(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    const dx = v.x - cx, dy = v.y - cy;
    const r = Math.hypot(dx, dy);
    if (r < 2) { scratch[i].x = v.x; scratch[i].y = v.y; continue; }
    const s = (r + field.displacementAt(Math.atan2(dy, dx))) / r;
    scratch[i].x = cx + dx * s;
    scratch[i].y = cy + dy * s;
  }
  return { vertices: scratch, edges: mesh.edges, _scratch: scratch };
}
