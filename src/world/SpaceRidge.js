// The third equalizer: a crystalline/orbital node-and-segment line high in
// the deep sky — deliberately MASSIVE, far back in the cosmos (megalophobia:
// something too large to be nearby), and traveling through DEPTH rather than
// sliding sideways: it doesn't scroll with the world at all. A slow whole-
// line tidal drift (like a body large enough to feel a distant gravitational
// pull) rides underneath a per-node depth read off the same band energy that
// drives its shimmer — active bands push their node out and larger, quiet
// ones recede and shrink toward the vanishing point — plus a slow global
// dolly so the whole structure breathes in and out over the better part of a
// minute. Pure math + draw(). BiomeManager consumes it; tests exercise the
// math directly.
import { clamp, clamp01, mulberry32 } from '../utils/math.js';
import { capFlashAlpha } from '../ui/Accessibility.js';
import { kickEnv } from './MountainChoreo.js';
import { sampleSpaceRidge } from './alpine/RidgeMotion.js';
import { hexToRgb, hexLerp } from '../utils/color.js';
import { skylineYAt } from './alpine/RangeSkyline.js';

// +3 joints past each edge (was +1 vs. the old 24-on-screen packing) so the
// widened depth spread never pulls the outermost joints on-screen.
export const N_NODES = 30;
// Aurora (drawAurora): its hem and crown colours, ray columns per ridge
// segment, and how far below the hem it fades (in curtain heights).
const AURORA_GREEN = '#59ffb4';
const AURORA_VIOLET = '#a86bff';
const AURORA_COLUMNS = 6;
const AURORA_SKIRT = 0.12;
// How far the curtain's hem takes the shape of the land's skyline (0 keeps
// its own musical wave), how far above that skyline it always stays (a
// fraction of the frame height), and how old a skyline reading may be
// before it is ignored (heard seconds; a seek leaves the old one behind).
const AURORA_ECHO = 0.8;
const AURORA_RIDGE_GAP = 0.06;
const SKYLINE_STALE_SEC = 1;
const ATTACK_SEC = 0.05;
const RELEASE_SEC = 0.25;
const FLASH_ON_THRESHOLD = 0.55;
const FLASH_REARM_THRESHOLD = 0.24;
const FLASH_LIFE_MS = 300;
// The foot of the immense sky structure, kept above the ocean horizon.
// Exported so anything that needs to MEET this structure (the monolith in
// FractureEngine ties into it) can anchor to the real altitude rather than
// re-deriving it from a magic number that would silently drift out of sync.
export const BASELINE_FRAC = 0.33;
// The musical lift is broad enough to change the distant silhouette at
// playback size; three adjacent levels are averaged before projection.
const MAX_H_FRAC = 0.11;
// Extra span past each screen edge (in units of one joint spacing).
const EDGE_JOINTS = 3;

// Tidal drift: two slow incommensurate periods (seconds) summed so the whole
// line's vertical position never repeats on a simple cycle -- reads as a
// vague, massive external pull (distant gravity / a moon-on-tides analogue)
// rather than a mechanical bob. Amplitude is a fraction of canvas height.
const TIDAL_PERIOD_1_SEC = 19;
const TIDAL_PERIOD_2_SEC = 47;
export const TIDAL_AMPLITUDE_FRAC = 0.012;

// Depth: each node eases its own z (0 far, 1 near) toward its band level on
// the same attack/release dynamics as the level itself -- a second-order lag
// so depth motion never snaps. A slow global dolly (its own long period)
// breathes the whole structure in and out on top of the per-node reads.
const DEPTH_GLOBAL_PERIOD_SEC = 31;
const DEPTH_GAIN = 0.45;        // per-node depth contribution to size/spread/alpha
const DEPTH_GLOBAL_GAIN = 0.30; // whole-structure dolly contribution
const DEPTH_MUL_MIN = 0.42, DEPTH_MUL_MAX = 1.85;

// The icosahedron used to spin at a fixed rad/s, so its pose never met a
// note. A kick cocks it forward by this many radians at the envelope peak
// and lets it fall back into the slow tumble. ~22 degrees: a hitch, not a spin-out.
export const WIRE_KICK_RAD = 0.38;

/** Extra rotation (radians) of the sky wireframe at `tauMs` after a kick.
 *  0 before the hit and again once the envelope has settled, so the slow
 *  tumble stays the resting motion and the beat is a single cock forward. */
export function wireframeKickRadians(tauMs) {
  if (!(tauMs >= 0)) return 0;
  return WIRE_KICK_RAD * kickEnv(tauMs);
}

/**
 * How calm stretches the ridge's own attack/release envelopes. This line
 * used to chase eqBands at the SAME fast 0.05s/0.25s taus regardless of
 * section energy -- a raw EQ readout stays a jumpy stepped EQ readout even
 * in a calm section, reading as "the high-intensity visualization is still
 * on," just quieter (bands themselves are lower, not the line's own
 * behavior). Stretching both taus makes each node ease into its target over
 * a much longer window, so the whole line rolls in slow, broad contours
 * instead of ticking to every treble transient. Pure so it's testable
 * without asserting on the segment-drawing/wireframe machinery.
 */
export function calmResponseParams(calmLevel) {
  const c = clamp01(calmLevel);
  return { tauMul: 1 + 3 * c }; // up to 4x slower attack/release at full calm
}

// Icosahedron: 12 vertices, 30 edges. Precomputed once (module scope).
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_RAW = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];
const ICO_NORM = Math.hypot(1, PHI, 0);
export const ICO_VERTS = ICO_RAW.map(([x, y, z]) => [x / ICO_NORM, y / ICO_NORM, z / ICO_NORM]);
export const ICO_EDGES = (() => {
  const edges = [];
  for (let i = 0; i < ICO_VERTS.length; i++) {
    for (let j = i + 1; j < ICO_VERTS.length; j++) {
      const [ax, ay, az] = ICO_VERTS[i], [bx, by, bz] = ICO_VERTS[j];
      const d = Math.hypot(ax - bx, ay - by, az - bz);
      if (d < 1.06) edges.push([i, j]); // nearest-neighbor edge length ~1.05
    }
  }
  return edges;
})();

/** Rotate every vertex by (rotX, rotY) and orthographically project to 2D,
 *  scaled by `scale`. Pure; returns {points:[{x,y}], edges} for the caller
 *  to stroke. */
export function projectWireframe(verts, edges, rotX, rotY, scale) {
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const points = verts.map(([x, y, z]) => {
    // Rotate around X, then Y.
    const y1 = y * cosX - z * sinX;
    const z1 = y * sinX + z * cosX;
    const x2 = x * cosY + z1 * sinY;
    const z2 = -x * sinY + z1 * cosY;
    void z2;
    return { x: x2 * scale, y: y1 * scale };
  });
  return { points, edges };
}

/** xFrac span: three joints past left and right of [0,1]. */
export function nodeXFrac(i, n = N_NODES, edgeJoints = EDGE_JOINTS) {
  const denom = Math.max(1, n - 1 - 2 * edgeJoints);
  // i=0 → -edgeJoints/denom units left of 0; i=n-1 → past 1 on the right.
  return (i - edgeJoints) / denom;
}

/** Whole-line tidal vertical offset (px) at a given song time -- exported
 *  pure so the moon can ride the same drift at a fraction of the amplitude,
 *  and so tests can pin the amplitude bound without a live instance. */
export function tidalOffset(tSec, canvasHeight) {
  const amp = TIDAL_AMPLITUDE_FRAC * canvasHeight;
  const w1 = (2 * Math.PI) / TIDAL_PERIOD_1_SEC;
  const w2 = (2 * Math.PI) / TIDAL_PERIOD_2_SEC;
  return amp * (0.6 * Math.sin(tSec * w1) + 0.4 * Math.sin(tSec * w2 + 1.3));
}

export class SpaceRidge {
  constructor(seed) {
    const rand = mulberry32((seed ^ 0x2b1e) >>> 0 || 1);
    // Three far-off masses share one silhouette; their uneven centers and
    // widths are stable for a song, while the seven bands move their crest.
    this._spine = [
      { x: 0.16 + rand() * 0.06, width: 0.10, height: 0.61 },
      { x: 0.44 + rand() * 0.08, width: 0.15, height: 1 },
      { x: 0.75 + rand() * 0.07, width: 0.11, height: 0.76 },
    ];
    this.nodes = [];
    for (let i = 0; i < N_NODES; i++) {
      const xFrac = nodeXFrac(i) + (rand() - 0.5) * 0.012;
      // Treble-weighted band pick: bands 4-6 get ~65% of nodes, 0-1 ~10%.
      const r = rand();
      let band;
      if (r < 0.10) band = rand() < 0.5 ? 0 : 1;
      else if (r < 0.35) band = 2 + Math.floor(rand() * 2); // 2-3
      else band = 4 + Math.floor(rand() * 3); // 4-6
      this.nodes.push({ xFrac, band, phase: rand() * Math.PI * 2, level: 0, z: 0, flashArmed: true });
    }
    this._flashes = [];
    // The land's skyline the aurora echoes ({ ys, atSec }); the Range sets it.
    this.skyline = null;
    this.lastEchoed = false;
    this._rotX = 0;
    this._rotY = 0;
    this._tidalPx = 0;
    this._zGlobal = 0;
    this._tSec = 0;
  }

  update(nowMs, dtSec, eqBands, calmLevel = 0, kickTauMs = -1) {
    if (this.history) {
      const sample = this.history.sample(nowMs);
      this._tSec = nowMs / 1000;
      this.nodes.forEach(n => { n.level = sample.spaceLevels[n.band]; n.z = sample.spaceDepths[n.band]; });
      this._rotX = this._tSec * .04 + sample.kick01 * WIRE_KICK_RAD;
      this._rotY = this._tSec * .027 + sample.kick01 * WIRE_KICK_RAD * .7;
      this._tidalPx = this.reducedMotion ? 0 : tidalOffset(this._tSec, this._lastCanvasHeight || 720);
      this._zGlobal = this.reducedMotion ? 0 : Math.sin(this._tSec * 2 * Math.PI / DEPTH_GLOBAL_PERIOD_SEC);
      return;
    }
    const { tauMul } = calmResponseParams(calmLevel);
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const raw = clamp01(eqBands ? (eqBands[n.band] ?? 0) : 0);
      const target = Math.pow(raw, 1.4);
      const tau = (target > n.level ? ATTACK_SEC : RELEASE_SEC) * tauMul;
      n.level += (1 - Math.exp(-dtSec / tau)) * (target - n.level);
      // A one-step jump cannot exceed .154 at the live 120Hz clock. Arm on
      // release and fire on a fresh rise in the incoming band instead.
      if (raw <= FLASH_REARM_THRESHOLD) n.flashArmed = true;
      if (n.flashArmed && raw >= FLASH_ON_THRESHOLD) {
        this._flashes.push({ i, atMs: nowMs });
        n.flashArmed = false;
      }

      // Depth is a second-order lag behind level -- same attack/release
      // shape, one step slower, so a node's push-out/recede never snaps.
      const zTau = n.level > n.z ? ATTACK_SEC : RELEASE_SEC;
      n.z += (1 - Math.exp(-dtSec / zTau)) * (n.level - n.z);
    }
    this._flashes = this._flashes.filter((f) => nowMs - f.atMs < FLASH_LIFE_MS);
    const tSec = nowMs / 1000;
    this._tSec = tSec;
    // Idle tumble is a function of song time (seek-safe). The kick term is
    // zero except during the hit, so a scrub back to the same instant
    // draws the same pose.
    const wobble = wireframeKickRadians(kickTauMs);
    this._rotX = tSec * 0.04 + wobble;
    this._rotY = tSec * 0.027 + wobble * 0.7;
    this._tidalPx = tidalOffset(tSec, this._lastCanvasHeight || 720);
    this._zGlobal = Math.sin((tSec * 2 * Math.PI) / DEPTH_GLOBAL_PERIOD_SEC);
  }

  /** Current whole-line tidal offset in px, for the moon to partially ride.
   *  Recomputed against the last canvas height `update()` saw (falls back to
   *  720 before the first draw). */
  tidalOffsetPx(canvasHeight) {
    if (canvasHeight != null) return tidalOffset(this._tSec, canvasHeight);
    return this._tidalPx;
  }

  /** Screen-space samples for the ridge polyline. No world scroll -- this
   *  structure is deliberately too large/far to read as scrolling with the
   *  world; it moves in depth (see depthMul) and on the tidal drift only. */
  _samples(canvas, reducedMotion = this.reducedMotion) {
    const frame = this.frameSample;
    if (frame && frame.width === canvas.width && frame.height === canvas.height && frame.heardTimeMs === this._tSec * 1000 && frame.reducedMotion === !!reducedMotion) {
      const s = frame.sample;
      return { pts: s.points, y0: s.y0, maxH: s.maxH };
    }
    if (this.history) {
      const s = sampleSpaceRidge({ viewport: canvas, seededGeometry: this, history: this.history,
        heardTimeMs: this._tSec * 1000, reducedMotion });
      return { pts: s.points, y0: s.y0, maxH: s.maxH };
    }
    this._lastCanvasHeight = canvas.height;
    const y0 = canvas.height * BASELINE_FRAC + this._tidalPx;
    const maxH = canvas.height * MAX_H_FRAC;
    const cx = canvas.width / 2;
    const pts = this.nodes.map((n, i) => {
      const depthMul = clamp(1 + DEPTH_GAIN * n.z + DEPTH_GLOBAL_GAIN * this._zGlobal, DEPTH_MUL_MIN, DEPTH_MUL_MAX);
      const xBase = n.xFrac * canvas.width;
      const x = cx + (xBase - cx) * depthMul;
      const level = (this.nodes[Math.max(0, i - 1)].level + n.level
        + this.nodes[Math.min(this.nodes.length - 1, i + 1)].level) / 3;
      const mass = Math.min(1, this._spine.reduce((sum, peak) => {
        const distance = (n.xFrac - peak.x) / peak.width;
        return sum + peak.height * Math.exp(-distance * distance);
      }, 0));
      const resting = canvas.height * (0.045 + 0.09 * mass);
      const y = y0 - resting - level * maxH;
      return { x, y, i, level: n.level, depthMul };
    });
    // Independent near/far nodes can otherwise cross in projection and fold
    // the skyline into sharp loops. Depth may compress spacing, not its order.
    for (let i = 1; i < pts.length; i++) pts[i].x = Math.max(pts[i].x, pts[i - 1].x + 3);
    return { pts, y0, maxH };
  }

  /** The space the live aurora occupies, for secondary sky paint: from just
   *  under its hem up through the height its curtain usually reaches. The
   *  sky below the hem stays ordinary sky. */
  corridorAt(canvas, x) {
    return this.corridor(canvas)(x);
  }

  corridor(canvas) {
    const { pts: raw, maxH } = this._samples(canvas);
    const pts = this._echoSkyline(raw, canvas).sort((a, b) => a.x - b.x);
    const flashSet = this._flashLevels(this._tSec);
    // The tallest each segment's rays can stand this frame (their sway
    // factor never exceeds 1), so nothing painted later reaches the crown.
    const reach = [];
    for (let i = 0; i < pts.length - 1; i++) reach.push(this._curtainHeight(canvas, maxH, pts[i], pts[i + 1], flashSet, 1));
    return (x) => {
      let y = pts[0].y, r = reach[0] ?? 0;
      for (let i = 1; i < pts.length; i++) {
        if (x > pts[i].x) { y = pts[i].y; r = reach[Math.min(i, reach.length - 1)] ?? r; continue; }
        const dx = pts[i].x - pts[i - 1].x;
        const t = dx > 0 ? clamp01((x - pts[i - 1].x) / dx) : 0;
        y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        r = reach[i - 1];
        break;
      }
      // The skirt hangs below the hem in proportion to the curtain.
      return { top: y - r, bottom: y + Math.max(15, r * AURORA_SKIRT) };
    };
  }

  /** The aurora's hem echoing the land: the skyline's shape (`skyline`, set
   *  by the Range each frame it reads one, weighted by how far the land has
   *  arrived) carried at the curtain's own
   *  altitude, with a share of the musical wave left on top, and never
   *  closer to the land than the gap. Without a fresh skyline, the musical
   *  wave alone. Returns new points; the samples are not changed. */
  _skylineFresh() {
    const sky = this.skyline;
    return !!sky && Math.abs(this._tSec - sky.atSec) <= SKYLINE_STALE_SEC;
  }

  _echoSkyline(pts, canvas) {
    const sky = this.skyline;
    if (!this._skylineFresh() || pts.length < 2) return pts.slice();
    const weight = clamp01(sky.weight ?? 1);
    const land = pts.map((p) => skylineYAt(sky.ys, canvas, p.x));
    const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
    const lift = mean(land) - mean(pts.map((p) => p.y));
    const gap = canvas.height * AURORA_RIDGE_GAP;
    return pts.map((p, k) => {
      const y = p.y + (land[k] - lift - p.y) * AURORA_ECHO;
      return { ...p, y: p.y + (Math.min(y, land[k] - gap) - p.y) * weight };
    });
  }

  /** One ridge segment's curtain height, scaled by its rays' sway (0..1). */
  _curtainHeight(canvas, maxH, a, b, flashSet, sway) {
    const flash = Math.max(flashSet.get(a.i) || 0, flashSet.get(b.i) || 0);
    const level = (a.level + b.level) / 2;
    const dm = (a.depthMul + b.depthMul) / 2;
    return (canvas.height * 0.09 + maxH * 0.5 * level + 40 * (canvas.height / 720) * flash) * sway * dm;
  }

  /** Each node's current flash (0..1): the song history's band flash, or
   *  the live flashes still fading. */
  _flashLevels(tSec) {
    const flashSet = new Map();
    if (this.history) {
      const sample = this.history.sample(this._tSec * 1000);
      this.nodes.forEach((n, i) => flashSet.set(i, sample.spaceFlash01[n.band]));
    }
    const nowMs = tSec * 1000;
    for (const f of this._flashes) {
      const u = clamp01((nowMs - f.atMs) / FLASH_LIFE_MS);
      flashSet.set(f.i, 1 - u);
    }
    return flashSet;
  }

  /**
   * The same musical skyline worn as an aurora: a curtain whose bright lower
   * hem follows the ridge, rising in rays where its bands are loud and
   * flaring where a node flashes. Brightest at night; a faint veil by day.
   * Rays drift slowly in time; reduced motion holds them still.
   */
  drawAurora(ctx, canvas, color, tSec, { reducedFlash = false, reducedMotion = false, presentation = 1, night01 = 1 } = {}) {
    const { pts: raw, maxH } = this._samples(canvas, reducedMotion);
    // Whether this sky had the land's skyline to echo (see BiomeManager
    // takeSkylineUnsettled).
    this.lastEchoed = this._skylineFresh();
    const pts = this._echoSkyline(raw, canvas);
    if (pts.length < 2) return;
    const flashSet = this._flashLevels(tSec);
    // Under reduced motion a flash may brighten the curtain but never
    // stretch it: the rays stand still.
    const reachFlash = reducedMotion ? new Map() : flashSet;
    const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
    const present = Number.isFinite(presentation) ? clamp01(presentation) : 1;
    const paint = inherited * present * (0.3 + 0.7 * clamp01(night01));
    if (paint < 0.005) return;
    const t = reducedMotion ? 0 : tSec;
    const hem = hexLerp(color, AURORA_GREEN, 0.55);
    const crown = hexLerp(color, AURORA_VIOLET, 0.7);
    const h = hexToRgb(hem), c = hexToRgb(crown);
    // One unit-space gradient: y = 0 is the hem, y = -1 the curtain's top.
    const g = ctx.createLinearGradient(0, AURORA_SKIRT, 0, -1);
    g.addColorStop(0, `rgba(${h.r},${h.g},${h.b},0)`);
    g.addColorStop(0.12, `rgba(${h.r},${h.g},${h.b},0.9)`);
    g.addColorStop(0.3, `rgba(${h.r},${h.g},${h.b},0.38)`);
    g.addColorStop(0.7, `rgba(${c.r},${c.g},${c.b},0.16)`);
    g.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.save();
    ctx.globalCompositeOperation = reducedFlash ? 'source-over' : 'lighter';
    ctx.fillStyle = g;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const flash = Math.max(flashSet.get(a.i) || 0, flashSet.get(b.i) || 0);
      const level = (a.level + b.level) / 2;
      const dm = (a.depthMul + b.depthMul) / 2;
      const w = (b.x - a.x) / AURORA_COLUMNS;
      for (let j = 0; j < AURORA_COLUMNS; j++) {
        const u = (j + 0.5) / AURORA_COLUMNS;
        const x = a.x + (b.x - a.x) * u;
        const y = a.y + (b.y - a.y) * u;
        // Two slow interfering folds give the curtain its rays.
        const fold = (0.5 + 0.5 * Math.sin(x * 0.045 + t * 0.35)) * (0.55 + 0.45 * Math.sin(x * 0.13 - t * 0.9));
        const height = this._curtainHeight(canvas, maxH, a, b, reachFlash, 0.75 + 0.25 * Math.sin(x * 0.021 + t * 0.22));
        ctx.save();
        ctx.globalAlpha = paint * capFlashAlpha((0.1 + 0.22 * fold + 0.18 * level + 0.3 * flash) * dm, reducedFlash);
        ctx.translate(x - w / 2, y);
        ctx.scale(1, height);
        ctx.fillRect(0, -1, w + 0.6, 1 + AURORA_SKIRT);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  draw(ctx, canvas, color, tSec, reducedFlash = false, presentation = 1, inheritedActivity = 0, reducedMotion = false, satellitePresence = 1) {
    const { pts, y0, maxH } = this._samples(canvas, reducedMotion);
    if (!this.history && inheritedActivity > 0 && !reducedMotion) {
      for (const p of pts) p.y -= 10 * inheritedActivity * Math.sin(p.x / 370 + tSec * .42);
    }

    const flashSet = this._flashLevels(tSec);

    const inherited = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
    const present = Number.isFinite(presentation) ? Math.min(1, Math.max(0, presentation)) : 1;
    const paint = inherited * present;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // A broad, quiet body gives the skyline physical scale even between
    // notes. The contour above it is the musical edge, not an isolated wire.
    const { r, g, b } = hexToRgb(color);
    const body = ctx.createLinearGradient(0, y0 - maxH - canvas.height * 0.07, 0, y0);
    body.addColorStop(0, `rgba(${r},${g},${b},0.03)`);
    body.addColorStop(0.55, `rgba(${r},${g},${b},0.15)`);
    body.addColorStop(1, `rgba(${r},${g},${b},0.02)`);
    ctx.globalAlpha = paint;
    ctx.fillStyle = body;
    ctx.beginPath();
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.lineTo(pts[pts.length - 1].x, y0);
    ctx.lineTo(pts[0].x, y0);
    ctx.closePath();
    ctx.fill();

    // One soft depth ghost only (two tall ghosts read as extra sky-high bands).
    const depthLayers = [
      { yScale: 1.2, yOff: -maxH * 0.06, alpha: 0.035, lw: 8 },
    ];
    ctx.globalCompositeOperation = reducedFlash ? 'source-over' : 'lighter';
    for (const layer of depthLayers) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = paint * capFlashAlpha(layer.alpha, reducedFlash);
      ctx.lineWidth = layer.lw;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ly = y0 + (p.y - y0) * layer.yScale + layer.yOff;
        if (i === 0) ctx.moveTo(p.x, ly); else ctx.lineTo(p.x, ly);
      }
      ctx.stroke();
    }

    // Vast mirrored ghost above — inverted cosmos echo, not a hairline.
    ctx.strokeStyle = color;
    ctx.globalAlpha = paint * capFlashAlpha(0.035, reducedFlash);
    ctx.lineWidth = 5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const gy = (y0 - maxH * 0.85) - (p.y - y0) * 0.55;
      if (i === 0) ctx.moveTo(p.x, gy); else ctx.lineTo(p.x, gy);
    });
    ctx.stroke();

    // Main ridge: thick soft underglow + thinner bright core (distant power),
    // scaled by each segment's average depth -- nodes pushing out read
    // larger and brighter, receding ones thinner and dimmer.
    //
    // Weighted toward the wide, soft pass and away from the thin, sharp one
    // (was [11,0.055]/[4.5,0.11]/[1.6,0.28] -- roughly even thirds by total
    // brightness). A crisp bright core is a NEAR-light cue; this structure's
    // whole premise is the opposite ("too large and far to be nearby"), and
    // now that it draws behind the sun/moon rather than blooming over them
    // (see BiomeManager.draw), it needs to read as diffuse light on its own
    // rather than relying on occlusion alone to sell the distance.
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const flash = Math.max(flashSet.get(a.i) || 0, flashSet.get(b.i) || 0);
      const dm = (a.depthMul + b.depthMul) / 2;
      for (const [lw, base] of [[17, 0.075], [7, 0.16], [2.8, 0.58]]) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = paint * capFlashAlpha((base + 0.35 * flash) * dm, reducedFlash);
        ctx.lineWidth = lw * dm;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Node cores — larger, softer (star-stations on a structure too big),
    // sized/lit by their own depth. Same diffusion logic as the ridge
    // strokes above: a bigger, dimmer point reads as a distant glow: a
    // small, near-full-alpha one reads as a nearby light bulb.
    for (const p of pts) {
      if (p.i % 4 !== 1) continue;
      const n = this.nodes[p.i];
      const dm = p.depthMul;
      ctx.fillStyle = color;
      ctx.globalAlpha = paint * capFlashAlpha(0.07 * dm, reducedFlash);
      ctx.beginPath();
      ctx.arc(p.x, p.y, (9 + 5 * n.level) * dm, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = paint * capFlashAlpha((0.18 + 0.24 * n.level) * dm, reducedFlash);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2 * dm, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tumbling polyhedron — same deep-sky band as the ridge, not the top
    // bezel. No world scroll (matches the ridge); rides the same tidal drift.
    if (satellitePresence <= 0) { ctx.restore(); return; }
    const cx = canvas.width * 0.16;
    const cy = canvas.height * (BASELINE_FRAC - 0.04) + this._tidalPx * 0.5;
    const icoScale = Math.max(36, canvas.height * 0.055) * (1 + 0.15 * this._zGlobal);
    const wf = projectWireframe(ICO_VERTS, ICO_EDGES, this._rotX, this._rotY, icoScale);
    ctx.strokeStyle = color;
    ctx.globalAlpha = paint * capFlashAlpha(0.055, reducedFlash) * satellitePresence;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const [i, j] of wf.edges) {
      const a = wf.points[i], b = wf.points[j];
      ctx.moveTo(cx + a.x, cy + a.y);
      ctx.lineTo(cx + b.x, cy + b.y);
    }
    ctx.stroke();

    ctx.restore();
  }
}
