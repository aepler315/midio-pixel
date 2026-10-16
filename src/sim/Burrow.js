// Broshi's underground excursion: he dives beneath the ground and swims
// through an intricate cavern generated from noise (see marchingSquares.js),
// steering away from rock via direct potential-field sampling of the same
// noise field the walls were extracted from -- a hard guarantee he never
// swims into solid earth, not just a statistical one. The cave geometry is
// pure data here (fully unit-testable); draw() composites the "dirt-sight"
// fog-of-war (browser-only -- needs a real canvas).
import { mulberry32, clamp01, lerp } from '../utils/math.js';
import { curl2, valueNoise3 } from '../utils/fields.js';
import {
  sampleCaveGrid, extractContours, insetContour, polygonArea, polygonCentroid,
} from '../render/marchingSquares.js';
import { BROSHI_BODY } from '../render/meshes.js';
import { computeRestLengths, drawMeshPart, meltMesh } from '../render/MeshDrawer.js';
import { generateBolt } from '../world/Lightning.js';

export const BurrowPhase = Object.freeze({
  IDLE: 'IDLE', DIG_IN: 'DIG_IN', TUNNELING: 'TUNNELING', ERUPT: 'ERUPT',
});

const DIG_IN_SEC = 0.7;
const TUNNEL_SEC = 8.0;
const ERUPT_SEC = 0.5;
const GRID_COLS = 110, GRID_ROWS = 20;
const CELL_PX = 13;
const NOISE_SCALE = 0.09;
const THRESHOLD = 0.5;
const SWIM_SPEED_PX_S = 130;
const RIDGE_PERIOD_SEC = 1.0; // a mole-ridge surface tell at a fixed cadence
const MIN_CONTOUR_AREA = 6; // grid-units^2; skip decorating tiny noise-blob contours
const MAX_SPIKES = 14; // combined stalactite + stalagmite cap
const MAX_CRYSTALS = 5;
// Resonance veins: melody-charged crystals arc glowing filaments to each
// other, building a ley-line network of the motif inside the rock.
const CHARGE_PER_ONSET = 0.4;
const CHARGE_TAU_SEC = 2.5;
const VEIN_CHARGE_MIN = 0.25;
const VEIN_REGEN_MS = 120; // the filament re-jitters at this cadence, like a held arc
// The eruption's ground ripple: just under Midio's max landing strength
// (1.0) -- a big surface event, but a smaller body than Midio's own impact.
const ERUPT_RIPPLE_STRENGTH = 0.85;

export class Burrow {
  constructor(seed = 1) {
    this.rand = mulberry32((seed ^ 0x8123) >>> 0 || 1);
    this._bodyRest = computeRestLengths(BROSHI_BODY);
    this.phase = BurrowPhase.IDLE;
    this.phaseStartMs = 0;
    this.p = { x: 0, y: 0 }; // world px
    this.heading = 0;
    this.contours = []; // [{points:[{x,y}] (world px), insets:[[...]x2], area}]
    this.stalactites = []; // [{x,y}] anchor points (world px), hanging from a ceiling edge
    this.stalagmites = []; // [{x,y}] anchor points, growing from a floor edge
    this.crystals = []; // [{x,y,hue}]
    this._worldOriginX = 0;
    this._gx = GRID_COLS / 2;
    this._gy = GRID_ROWS / 2;
    this._t = 0;
    this._nextRidgeMs = -Infinity;
    this._enteredTunneling = false;
    this._diveTarget = { x: 0, y: 0 };

    // Music reactivity underground: kick pressure-rings + crystal flash,
    // bass-driven wall vibration, melody-triggered stalactite drips -- and
    // world-locked dirt shards flung from the hole on dig-in and eruption.
    this.rings = [];   // {age, vel} expanding from his position
    this.drips = [];   // {x, y, vy, age, life} in local cave coords
    this.shards = [];  // {wx, wy, vx, vy, age, life, rot} in world coords
    this.veins = [];   // {key, i, j, pts, regenAtMs, packetU} between charged crystals
    this.crystalFlash = 0;
    this._bass = 0;
    this.justSurfaced = false; // one-frame flag: Broshi pops a hop off this
  }

  /** A kick while he's tunneling: a pressure ring expands off him and
   * every currently-visible crystal flashes with the beat. */
  onKick(vel = 0.8) {
    if (this.phase !== BurrowPhase.TUNNELING) return;
    this.rings.push({ age: 0, vel });
    if (this.rings.length > 4) this.rings.shift();
    this.crystalFlash = 1;
  }

  /** A melody onset while he's tunneling: the note's pitch class rings a
   * specific crystal (a repeating motif visibly re-rings the same stones),
   * and the stalactite nearest his x drips, shaken loose. */
  onMelodyOnset(evt = {}) {
    if (this.phase !== BurrowPhase.TUNNELING) return;

    if (this.crystals.length > 0) {
      const pc = ((Math.round(evt.pitch ?? 60) % 12) + 12) % 12;
      const crystal = this.crystals[pc % this.crystals.length];
      crystal.charge = Math.min(1, crystal.charge + CHARGE_PER_ONSET * (evt.vel ?? 0.7));
    }

    if (this.stalactites.length > 0) {
      const lx = this._gx * CELL_PX;
      let nearest = this.stalactites[0];
      for (const s of this.stalactites) {
        if (Math.abs(s.x - lx) < Math.abs(nearest.x - lx)) nearest = s;
      }
      this.drips.push({ x: nearest.x, y: nearest.y + nearest.len, vy: 0, age: 0, life: 0.9 });
      if (this.drips.length > 10) this.drips.shift();
    }
  }

  /** Charged crystal pairs hold a living arc between them: filaments form
   * when both ends are hot, re-jitter at a fixed cadence like a sustained
   * spark, carry a traveling energy packet, and dissolve as charge fades. */
  _updateVeins(nowMs, dtSec) {
    const eligible = [];
    for (let i = 0; i < this.crystals.length; i++) {
      for (let j = i + 1; j < this.crystals.length; j++) {
        if (this.crystals[i].charge > VEIN_CHARGE_MIN && this.crystals[j].charge > VEIN_CHARGE_MIN) {
          eligible.push(`${i}-${j}`);
        }
      }
    }
    const eligibleSet = new Set(eligible);
    this.veins = this.veins.filter((v) => eligibleSet.has(v.key));
    const have = new Set(this.veins.map((v) => v.key));
    for (const key of eligible) {
      if (have.has(key)) continue;
      const [i, j] = key.split('-').map(Number);
      this.veins.push({ key, i, j, pts: null, regenAtMs: -Infinity, packetU: this.rand() });
    }
    for (const v of this.veins) {
      if (nowMs >= v.regenAtMs) {
        const a = this.crystals[v.i], b = this.crystals[v.j];
        v.pts = generateBolt(a.x, a.y, b.x, b.y, { displace: 14, detail: 4, branches: 0, rand: this.rand }).main;
        v.regenAtMs = nowMs + VEIN_REGEN_MS;
      }
      const speed = 0.8 + 0.8 * Math.min(this.crystals[v.i].charge, this.crystals[v.j].charge);
      v.packetU += speed * dtSec;
      if (v.packetU > 1) v.packetU -= 1;
    }
  }

  _spawnShards(count, worldXAt, surfaceY) {
    for (let i = 0; i < count; i++) {
      const ang = -Math.PI / 2 + (this.rand() - 0.5) * 1.3; // an upward fan
      const speed = 140 + 220 * this.rand();
      this.shards.push({
        wx: worldXAt + (this.rand() - 0.5) * 26, wy: surfaceY,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        age: 0, life: 0.7 + 0.4 * this.rand(), rot: this.rand() * Math.PI,
      });
    }
  }

  get active() { return this.phase !== BurrowPhase.IDLE; }

  /** Fraction of the way into "fully underground" -- 0 at the surface, 1
   * once diving/tunneling/erupting are all in the underground band. Used
   * to fade Broshi's normal surface glyph out and back in. */
  get depth() {
    if (this.phase === BurrowPhase.DIG_IN) return clamp01(((this._nowMs ?? 0) - this.phaseStartMs) / (DIG_IN_SEC * 1000));
    if (this.phase === BurrowPhase.TUNNELING) return 1;
    if (this.phase === BurrowPhase.ERUPT) return 1 - clamp01(((this._nowMs ?? 0) - this.phaseStartMs) / (ERUPT_SEC * 1000));
    return 0;
  }

  trigger(nowMs, fromPos, worldX, groundY, holeWorldX = worldX) {
    if (this.active) return false;
    this.phase = BurrowPhase.DIG_IN;
    this.phaseStartMs = nowMs;
    this._nowMs = nowMs;
    // Surface pose in WORLD space — never screen-space (that desyncs as
    // Midio scrolls and causes a teleport on resurface).
    this._holeWorldX = holeWorldX; // where HE actually digs (not Midio's world anchor)
    this._surfaceWorldX = holeWorldX;
    this._diveTarget = { x: holeWorldX, y: groundY };
    this._groundY = groundY;
    this.p = { x: holeWorldX, y: groundY };
    this._dugInPulseFired = false;
    this._geoCanvas = null; // rebuilt lazily on first draw() from the fresh geometry below
    this._generateCave(worldX);
    this._spawnShards(14, holeWorldX, groundY);
    return true;
  }

  /** World-x he should reappear at when justSurfaced fires (Broshi spring sync). */
  get surfaceWorldX() {
    return Number.isFinite(this._surfaceWorldX) ? this._surfaceWorldX : this._holeWorldX;
  }

  forceEnd(nowMs) {
    if (!this.active || this.phase === BurrowPhase.ERUPT) return;
    this.phase = BurrowPhase.ERUPT;
    this.phaseStartMs = nowMs;
    // Pop where he is right now (world-x), not a stale dig-in screen point.
    this._surfaceWorldX = Number.isFinite(this.p?.x) ? this.p.x : this._holeWorldX;
    this._diveTarget = { x: this._surfaceWorldX, y: this._groundY ?? this.p?.y ?? 0 };
  }

  _noiseAt(gx, gy) {
    return valueNoise3((this._worldOriginX / CELL_PX + gx) * NOISE_SCALE, gy * NOISE_SCALE, this._seedZ);
  }

  _generateCave(worldX) {
    this._worldOriginX = worldX;
    this._seedZ = this.rand() * 1000;
    const originGrid = worldX / CELL_PX;
    const grid = sampleCaveGrid(GRID_COLS, GRID_ROWS, originGrid, this._seedZ, { noiseScale: NOISE_SCALE });
    const rawContours = extractContours(grid, GRID_COLS, GRID_ROWS, THRESHOLD);

    // Local cave-window pixel space (not world coordinates): this is what
    // gets baked into the static geo-canvas once in draw(); the live
    // worldX/groundY offset is applied only at blit time each frame.
    const toLocal = (pt) => ({ x: pt.x * CELL_PX, y: pt.y * CELL_PX });
    this.contours = rawContours.map((c) => ({
      points: c.points.map(toLocal),
      insets: [0.10, 0.20].map((f) => insetContour(c.points, f).map(toLocal)),
      area: Math.abs(polygonArea(c.points)),
    }));

    // Entry point: search outward from the grid center for an open cell.
    let entry = { x: GRID_COLS / 2, y: GRID_ROWS / 2 };
    if (this._noiseAt(entry.x, entry.y) > THRESHOLD) {
      outer: for (let r = 1; r < 8; r++) {
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const cand = { x: entry.x + Math.cos(ang) * r * 1.5, y: entry.y + Math.sin(ang) * r * 1.5 };
          if (this._noiseAt(cand.x, cand.y) <= THRESHOLD) { entry = cand; break outer; }
        }
      }
    }
    this._gx = entry.x;
    this._gy = entry.y;
    this.heading = this.rand() * Math.PI * 2;

    this.stalactites = [];
    this.stalagmites = [];
    this.crystals = [];
    const bigContours = rawContours.filter((c) => Math.abs(polygonArea(c.points)) > MIN_CONTOUR_AREA);
    for (const c of bigContours) {
      const pts = c.points;
      for (let i = 0; i < pts.length; i += 3) {
        if (this.stalactites.length + this.stalagmites.length >= MAX_SPIKES) break;
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const above = this._noiseAt(mx, my - 0.6);
        const below = this._noiseAt(mx, my + 0.6);
        const len = 14 + this.rand() * 10; // fixed at generation time -- draw() never calls rand()
        if (above > THRESHOLD && below <= THRESHOLD) this.stalactites.push({ ...toLocal({ x: mx, y: my }), len });
        else if (below > THRESHOLD && above <= THRESHOLD) this.stalagmites.push({ ...toLocal({ x: mx, y: my }), len });
      }
    }
    const bySize = [...rawContours].sort((c1, c2) => Math.abs(polygonArea(c2.points)) - Math.abs(polygonArea(c1.points)));
    for (const c of bySize.slice(0, 3)) {
      if (this.crystals.length >= MAX_CRYSTALS) break;
      const centroid = toLocal(polygonCentroid(c.points));
      this.crystals.push({ x: centroid.x + (this.rand() - 0.5) * 20, y: centroid.y + (this.rand() - 0.5) * 20, hue: 180 + this.rand() * 60, charge: 0 });
    }
  }

  /** Advances the phase machine, Broshi's underground steering, the music
   * FX (rings/drips/shards/flash), and the surface mole-ridge tell.
   * `groundField` (optional) receives pulseAt() calls; `bassEnergy` (0..1)
   * drives the cave walls' vibration. Both are safe to omit in pure-logic
   * tests. */
  update(nowMs, dtSec, worldX, groundField = null, bassEnergy = 0) {
    this._nowMs = nowMs;
    this.justSurfaced = false;

    // FX keep aging even in the frame the phase machine goes idle, so the
    // last shards of an eruption finish their arcs above ground.
    this._bass += (1 - Math.exp(-dtSec / 0.12)) * (clamp01(bassEnergy) - this._bass);
    this.crystalFlash = Math.max(0, this.crystalFlash - dtSec / 0.25);
    for (const r of this.rings) r.age += dtSec;
    this.rings = this.rings.filter((r) => r.age < 0.4);
    for (const d of this.drips) { d.vy += 300 * dtSec; d.y += d.vy * dtSec; d.age += dtSec; }
    this.drips = this.drips.filter((d) => d.age < d.life);
    for (const s of this.shards) {
      s.vy += 520 * dtSec; s.wx += s.vx * dtSec; s.wy += s.vy * dtSec;
      s.rot += 4 * dtSec; s.age += dtSec;
    }
    this.shards = this.shards.filter((s) => s.age < s.life);

    if (!this.active) return;
    this._t += dtSec;

    // Crystal charges ring down like struck bells; the vein network follows.
    const chargeDecay = Math.exp(-dtSec / CHARGE_TAU_SEC);
    for (const cr of this.crystals) cr.charge *= chargeDecay;
    this._updateVeins(nowMs, dtSec);

    if (this.phase === BurrowPhase.DIG_IN) {
      if (!this._dugInPulseFired) {
        this._dugInPulseFired = true;
        if (groundField) groundField.pulseAt(nowMs, this._holeWorldX ?? worldX, 34, nowMs + 260);
      }
      const u = clamp01((nowMs - this.phaseStartMs) / (DIG_IN_SEC * 1000));
      this.p = { x: this._diveTarget.x, y: this._diveTarget.y + u * u * 60 }; // an accelerating nose-down dip
      if (u >= 1) {
        this.phase = BurrowPhase.TUNNELING;
        this.phaseStartMs = nowMs;
        this._nextRidgeMs = nowMs + RIDGE_PERIOD_SEC * 1000;
      }
    } else if (this.phase === BurrowPhase.TUNNELING) {
      this._stepSwim(dtSec);
      this.p = { x: this._worldOriginX + this._gx * CELL_PX, y: this._groundY + this._gy * CELL_PX };

      if (groundField && nowMs >= this._nextRidgeMs) {
        this._nextRidgeMs = nowMs + RIDGE_PERIOD_SEC * 1000;
        groundField.pulseAt(nowMs, this.p.x, -7, nowMs + 220);
      }
      if (nowMs - this.phaseStartMs >= TUNNEL_SEC * 1000) {
        this.phase = BurrowPhase.ERUPT;
        this.phaseStartMs = nowMs;
        // Erupt where he is underground — that world-x is the surface pop.
        this._surfaceWorldX = this.p.x;
        this._diveTarget = { x: this.p.x, y: this._groundY ?? this.p.y };
        if (groundField) {
          groundField.pulseAt(nowMs, this.p.x, 46, nowMs + 480);
          groundField.impulse(this.p.x, ERUPT_RIPPLE_STRENGTH, nowMs);
        }
        this._spawnShards(18, this.p.x, this._groundY ?? 480);
      }
    } else if (this.phase === BurrowPhase.ERUPT) {
      const u = clamp01((nowMs - this.phaseStartMs) / (ERUPT_SEC * 1000));
      // Ease out of the dirt at the SAME world-x (no lerp to a stale dig point).
      const ease = u * u * (3 - 2 * u);
      this.p = {
        x: this._surfaceWorldX,
        y: lerp(this.p.y, this._diveTarget.y, ease),
      };
      if (u >= 1) {
        this.phase = BurrowPhase.IDLE;
        this.contours = [];
        this.stalactites = [];
        this.stalagmites = [];
        this.crystals = [];
        this.rings = [];
        this.drips = [];
        this.veins = [];
        this.justSurfaced = true; // one-frame flag: Broshi pops a hop off this
      }
    }
  }

  /** Curl-noise wander with hard wall avoidance: if the tentative next
   * position would be inside rock, a handful of alternate headings are
   * tried and the lowest-noise one is taken instead. If even the best
   * option is still rock (a tight corner), he simply holds position for
   * that frame rather than tunneling through the wall. */
  _stepSwim(dtSec) {
    const wander = curl2(this._t * 0.6, this._gx * 0.3, this._t * 0.4);
    this.heading += wander.x * dtSec * 2;

    const tryHeading = (h) => {
      const gx = this._gx + (Math.cos(h) * SWIM_SPEED_PX_S * dtSec) / CELL_PX;
      const gy = this._gy + (Math.sin(h) * SWIM_SPEED_PX_S * dtSec) / CELL_PX;
      return { gx, gy, noise: this._noiseAt(gx, gy) };
    };

    let best = tryHeading(this.heading);
    if (best.noise > THRESHOLD) {
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        const cand = tryHeading(this.heading + k * 0.35);
        if (cand.noise < best.noise) best = { ...cand, heading: this.heading + k * 0.35 };
      }
      if (best.heading !== undefined) this.heading = best.heading;
    }
    if (best.noise > THRESHOLD) return; // cornered -- hold position this frame
    this._gx = clamp01(best.gx / GRID_COLS) * GRID_COLS;
    this._gy = clamp01(best.gy / GRID_ROWS) * GRID_ROWS;
  }

  // --- Rendering (browser-only: needs a real <canvas>, not covered by
  // node --test). Draws the underground band beneath the world: a static
  // "geo" image of the cave (built once per burrow), masked each frame by
  // a "vision" alpha field that blooms around Broshi as he swims and fades
  // behind him -- the fog-of-war dirt-sight. ---

  _ensureCanvases() {
    if (this._geoCanvas) return;
    const w = GRID_COLS * CELL_PX, h = GRID_ROWS * CELL_PX;
    this._geoCanvas = this._buildGeoCanvas(w, h);
    this._visionCanvas = document.createElement('canvas');
    this._visionCanvas.width = w; this._visionCanvas.height = h;
    this._scratchCanvas = document.createElement('canvas');
    this._scratchCanvas.width = w; this._scratchCanvas.height = h;
    this._erupted = false;
  }

  _strokePoly(ctx, points) {
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.closePath();
    ctx.stroke();
  }

  _buildGeoCanvas(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1024';
    ctx.fillRect(0, 0, w, h);

    for (const c of this.contours) {
      ctx.strokeStyle = 'hsla(260, 30%, 72%, 0.9)';
      ctx.lineWidth = 2;
      this._strokePoly(ctx, c.points);
      ctx.strokeStyle = 'hsla(260, 25%, 60%, 0.4)';
      ctx.lineWidth = 1;
      for (const inset of c.insets) this._strokePoly(ctx, inset);
    }

    ctx.fillStyle = 'hsla(250, 20%, 58%, 0.85)';
    for (const s of this.stalactites) {
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x, s.y + s.len); ctx.lineTo(s.x + 4, s.y);
      ctx.closePath(); ctx.fill();
    }
    for (const s of this.stalagmites) {
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x, s.y - s.len); ctx.lineTo(s.x + 4, s.y);
      ctx.closePath(); ctx.fill();
    }

    for (const cr of this.crystals) this._drawCrystal(ctx, cr, 1);
    return canvas;
  }

  _drawCrystal(ctx, cr, alphaMul) {
    ctx.save();
    ctx.translate(cr.x, cr.y);
    ctx.fillStyle = `hsla(${cr.hue}, 70%, 70%, ${0.8 * alphaMul})`;
    ctx.strokeStyle = `hsla(${cr.hue}, 80%, 88%, ${0.9 * alphaMul})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const r = i % 2 === 0 ? 10 : 5;
      const px = Math.cos(ang) * r, py = Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  draw(ctx, worldX, originX) {
    // Shards outlive the burrow itself (the eruption's debris finishes its
    // arc after he's surfaced), so they draw whether or not the band does.
    if (!this.active || this.depth <= 0.02) {
      this._drawShards(ctx, worldX, originX);
      return;
    }
    this._ensureCanvases();
    const w = GRID_COLS * CELL_PX, h = GRID_ROWS * CELL_PX;
    const vctx = this._visionCanvas.getContext('2d');

    // Memory fades: what he's already seen dims back into darkness rather
    // than staying revealed, so the cave blooms into visibility as he
    // swims and fades like an after-image behind him.
    vctx.save();
    vctx.globalCompositeOperation = 'destination-out';
    vctx.fillStyle = 'rgba(0,0,0,0.007)';
    vctx.fillRect(0, 0, w, h);
    vctx.restore();

    // The eruption payoff: the whole system floods into view for a beat.
    if (this.phase === BurrowPhase.ERUPT && !this._erupted) {
      this._erupted = true;
      vctx.fillStyle = 'white';
      vctx.fillRect(0, 0, w, h);
    }

    // Headlight: a soft ellipse offset ahead of his heading.
    const lx = this._gx * CELL_PX, ly = this._gy * CELL_PX;
    const hx = lx + Math.cos(this.heading) * 30, hy = ly + Math.sin(this.heading) * 30;
    const HEADLIGHT_R = 145;
    const grad = vctx.createRadialGradient(hx, hy, 0, hx, hy, HEADLIGHT_R);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    vctx.fillStyle = grad;
    vctx.beginPath();
    vctx.arc(hx, hy, HEADLIGHT_R, 0, Math.PI * 2);
    vctx.fill();

    // Composite: static geometry + the live music layers, all masked by
    // the vision field together so nothing dynamic leaks outside his sight.
    const sctx = this._scratchCanvas.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.globalCompositeOperation = 'source-over';
    sctx.drawImage(this._geoCanvas, 0, 0);

    const nowMs = this._nowMs ?? 0;
    sctx.save();
    sctx.globalCompositeOperation = 'lighter';

    // Bass makes the earth itself vibrate: the cave walls get a live
    // re-stroke whose width and vertex jitter ride the low band.
    if (this._bass > 0.12) {
      sctx.strokeStyle = `hsla(260, 45%, 80%, ${0.15 + 0.35 * this._bass})`;
      sctx.lineWidth = 1.2 + 1.6 * this._bass;
      for (const c of this.contours) {
        sctx.beginPath();
        c.points.forEach((p, i) => {
          const jx = Math.sin(nowMs * 0.02 + i * 1.7) * 2.5 * this._bass;
          const jy = Math.cos(nowMs * 0.023 + i * 2.3) * 2.5 * this._bass;
          if (i === 0) sctx.moveTo(p.x + jx, p.y + jy); else sctx.lineTo(p.x + jx, p.y + jy);
        });
        sctx.closePath();
        sctx.stroke();
      }
    }

    // Resonance veins: charged crystal pairs hold a living arc, its
    // brightness riding the weaker end's charge, with an energy packet
    // traveling the filament.
    for (const v of this.veins) {
      if (!v.pts) continue;
      const a = this.crystals[v.i], b = this.crystals[v.j];
      if (!a || !b) continue;
      const strength = Math.min(a.charge, b.charge);
      const hue = (a.hue + b.hue) / 2;
      sctx.strokeStyle = `hsla(${hue}, 70%, 80%, ${0.2 + 0.5 * strength})`;
      sctx.lineWidth = 1 + 1.2 * strength;
      sctx.beginPath();
      v.pts.forEach((p, k) => { if (k === 0) sctx.moveTo(p.x, p.y); else sctx.lineTo(p.x, p.y); });
      sctx.stroke();
      const idx = Math.min(v.pts.length - 1, Math.floor(v.packetU * (v.pts.length - 1)));
      const pp = v.pts[idx];
      sctx.fillStyle = `hsla(${hue}, 85%, 90%, ${0.5 + 0.5 * strength})`;
      sctx.beginPath();
      sctx.arc(pp.x, pp.y, 2.4, 0, Math.PI * 2);
      sctx.fill();
    }

    // Kicks flash every crystal with the beat, and a melody-charged
    // crystal holds its own glow while the charge rings down.
    for (const cr of this.crystals) {
      const glow = this.crystalFlash + cr.charge;
      if (glow > 0.03) this._drawCrystal(sctx, cr, Math.min(1.4, glow));
    }
    // ...and fire a pressure ring off him through the rock.
    for (const r of this.rings) {
      const u = r.age / 0.4;
      sctx.strokeStyle = `hsla(180, 60%, 80%, ${0.5 * (1 - u)})`;
      sctx.lineWidth = 2 * (1 - u * 0.5);
      sctx.beginPath();
      sctx.arc(lx, ly, 12 + u * 90, 0, Math.PI * 2);
      sctx.stroke();
    }

    // Melody onsets shake drips loose from the nearest stalactite.
    for (const d of this.drips) {
      const life = 1 - d.age / d.life;
      sctx.fillStyle = `hsla(195, 70%, 78%, ${0.9 * life})`;
      sctx.fillRect(d.x - 1, d.y, 2, 3.5);
    }
    sctx.restore();

    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(this._visionCanvas, 0, 0);
    sctx.globalCompositeOperation = 'source-over';

    const screenX = this._worldOriginX - worldX + originX;
    const screenY = this._groundY;

    ctx.save();
    ctx.drawImage(this._scratchCanvas, screenX, screenY);

    // Broshi himself: his actual body glyph at 0.8 scale, melted and
    // rolling with the swim, plus the dotted excavation line behind him.
    const bx = screenX + lx, by = screenY + ly;
    ctx.strokeStyle = 'rgba(150,255,180,0.35)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx - Math.cos(this.heading) * 40, by - Math.sin(this.heading) * 40);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);

    const facing = Math.cos(this.heading) >= 0 ? 1 : -1;
    const swimRoll = 0.22 * Math.sin(nowMs * 0.0075);
    const pitchTilt = Math.sin(this.heading) * 0.35 * facing;
    const hub = BROSHI_BODY.vertices[0];
    const bodyMesh = meltMesh(BROSHI_BODY, hub.x, hub.y, nowMs / 1000, 2.5, 2);
    drawMeshPart(ctx, bodyMesh, this._bodyRest, {
      tx: bx, ty: by, rot: swimRoll + pitchTilt, scaleX: 0.8 * facing, scaleY: 0.8,
    }, 110, { satBase: 42, lightBase: 62 });

    ctx.restore();

    this._drawShards(ctx, worldX, originX);
  }

  /** Dirt shards: flung from the hole on dig-in and eruption, arcing
   * ABOVE ground in world space -- deliberately not vision-masked. */
  _drawShards(ctx, worldX, originX) {
    if (!this.shards.length) return;
    ctx.save();
    for (const s of this.shards) {
      const life = 1 - s.age / s.life;
      const sx = s.wx - worldX + originX;
      ctx.translate(sx, s.wy);
      ctx.rotate(s.rot);
      ctx.fillStyle = `hsla(28, 48%, 42%, ${0.95 * life})`;
      ctx.fillRect(-2.4, -1.2, 4.8, 2.4);
      ctx.rotate(-s.rot);
      ctx.translate(-sx, -s.wy);
    }
    ctx.restore();
  }
}
