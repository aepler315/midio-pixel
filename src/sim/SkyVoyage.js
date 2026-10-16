// Midasus's deep-space excursion: she leaves the ensemble, climbs into the
// far sky, and traces genuinely mathematical figures out there -- seed-baked
// geometric recipes (Lissajous, epicycle, superformula, rose, hypotrochoid,
// Thomas attractor) that stay intentional math while varying per voyage.
// A persistent trail sky-writes the geometry; completed figures freeze into
// fading constellations. Pure phase/position logic here; BiomeManager draws
// it (see drawDeepSky) behind the mountain silhouettes, and Midasus.js hides
// her normal glyph for the phases where she isn't "here."
import { mulberry32, clamp, lerp } from '../utils/math.js';
import { superformula, thomasDeriv, rk4Step3, hypotrochoid } from '../render/oscillators.js';
import { layoutTextPath, glyphTracePath } from '../world/LyricGlyph.js';

export const VoyagePhase = Object.freeze({
  IDLE: 'IDLE', WINDUP: 'WINDUP', ASCENT: 'ASCENT', DEEP_SPACE: 'DEEP_SPACE', REENTRY: 'REENTRY',
});

// Lengthened (were 0.55/1.2) now that WINDUP/ASCENT render in the character
// layer (see Midasus.draw()) instead of being hidden the instant she leaves
// -- a real send-off needs room to read as a performance, not a blink.
const WINDUP_SEC = 0.9;
const ASCENT_SEC = 1.6;
// Reentry used to hang ~1s at the station (cubic ease-in from station, not
// from her last figure pose). Keep it brisk and continuous.
const REENTRY_SEC = 0.62;
// Presentation scale (Midasus.draw() multiplies this into her own
// DRAW_SCALE): swells before launch ("gathering power," matching the
// spiral's own framing below), then recedes through the climb so she reads
// as traveling away rather than cutting to a dot.
const WINDUP_SCALE_PEAK = 1.35;
const ASCENT_SCALE_FAR = 0.25;
const FIGURE_SEC = 3.2;
const FIGURES_PER_VOYAGE = 3;
const FIGURE_RADIUS_PX = 130;
// _bakeRecipe's `scale` for the eight math families tops out at 0.82+0.36=1.18
// (baked into the 0.12 station margin below), but a chorus voyage's middle
// figure is sky-written lyric text instead, hard-coded to scale=2.2 in
// _pickFigureOrder -- nearly double. A station placed near the standard
// margin let that text run off the left/right edge of frame; this scale
// (and LYRIC_TEXT_SCALE below) let the station-safety math size the margin
// to whichever figure a given voyage can actually draw.
const FIGURE_SCALE_MAX = 1.18;
const LYRIC_TEXT_SCALE = 2.2;
// A lyric SYMBOL (lyricGlyph): the song's own motif -- heart, hourglass,
// chain -- traced as one of her figures. A little larger than a math
// figure so it reads as the centrepiece rather than one more curve.
const LYRIC_GLYPH_SCALE = 1.4;
const TRAIL_SEC = 5.5;
const TRAIL_MAX_PTS = 400;
// Trail segments longer than this are a teleport chord — skip them in draw.
export const TRAIL_GAP_PX = 28;
export const CONSTELLATION_HOLD_SEC = 8;
export const CONSTELLATION_FADE_SEC = 7;
export const CONSTELLATION_LIFE_SEC = 15;
// Her in-progress trail at the moment she lands. It used to be discarded in
// a single frame (`this.trail = []`), so whatever she was mid-way through
// writing vanished the instant she left the sky. It now hands off to an
// afterglow that fades out over this long instead.
export const AFTERGLOW_SEC = 15;
const AFTERGLOW_MAX = 2;
const CONSTELLATION_MAX = 4;
const ATLAS_MAX = 8; // permanent star-map entries; oldest myths fade first
// Navigational atlas: the next voyage is drawn toward the densest cluster
// of her own past figures -- she revisits her myths.
//
// That pull cannot apply to EVERY voyage, because its input is its own
// output. _navTarget returns the centroid of the densest clump of atlas
// stars; a voyage dragged there deposits ~3 more figures there; the next
// _navTarget finds that same clump, now denser, and pulls harder still.
// Nothing in the loop ever sends her to unwritten sky, so whichever patch
// the FIRST voyage happens to roll captures every voyage after it. Measured
// over 12 voyages: the station stayed inside an x-span of 0.17-0.27 of the
// stage for a whole song, in a y-band already clamped to the top third --
// one dense knot of stars in one corner and an empty sky everywhere else,
// which is exactly how it was reported. So the revisit is now occasional,
// and the voyages that are NOT revisiting actively seek empty sky.
const NAV_CLUSTER_RADIUS_PX = 140;
const NAV_PULL = 0.65; // how strongly the cluster overrides the random station
const NAV_REVISIT_CHANCE = 0.34; // how often a voyage returns to an old myth
// Candidates drawn for the best-candidate (Mitchell) placement used by every
// other voyage: keep the one whose nearest existing atlas star is furthest
// away. Same blue-noise idea the hero stars use (StarCatalogue.generateCatalogue),
// and the cheapest way to make a sky fill out rather than pile up.
const NAV_SPREAD_CANDIDATES = 12;
// Supernova finale: each atlas star detonates on its own popcorn delay.
const NOVA_STAGGER_MS = 900;
const NOVA_LIFE_MS = 1100;
// Fallback pairs when a recipe wasn't baked (tests that inject kind strings)...
const LISSAJOUS_FREQS = [[3, 2], [5, 4], [2, 3], [4, 3], [5, 3], [7, 4], [8, 5], [5, 2]];
// ...and the melody's own tuning: one coprime pair per pitch class, so a
// C melody knots differently than an F# one -- the figure is literally
// played by the notes.
const LISSAJOUS_BY_PITCH_CLASS = [
  [3, 2], [5, 4], [4, 3], [5, 2], [7, 4], [3, 1],
  [5, 3], [7, 5], [2, 1], [7, 3], [8, 3], [5, 1],
];
// Geometric figure families available for seed-baked voyage recipes.
const FIGURE_FAMILIES = ['lissajous', 'epicycle', 'superformula', 'rose', 'hypotrochoid', 'thomas', 'harmonograph', 'spiral'];
// Coprime-ish frequency pairs for seed-picked Lissajous knots.
const LISS_PAIR_POOL = [
  [2, 1], [3, 1], [3, 2], [4, 1], [4, 3], [5, 2], [5, 3], [5, 4],
  [6, 1], [6, 5], [7, 2], [7, 3], [7, 4], [7, 5], [8, 3], [8, 5], [9, 4], [9, 5],
];
const LISS_MORPH_SEC = 0.45; // parametric cross-fade between old/new tuning
const KICK_TAU_SEC = 0.15;   // onset phase-kicks ease in, never teleport
// Cap accumulated onset curve-time so hard note runs can't race her so far
// along the figure that the next sample looks like a teleport.
const KICK_MAX_SEC = 0.32;
const SPARKLES_MAX = 36;
const SPARKLE_LIFE_SEC = 0.6;
const SLASH_MAX = 6;
const SLASH_LIFE_SEC = 0.25;

export class SkyVoyage {
  constructor(seed = 1) {
    this.seed = (seed ^ 0x5117) >>> 0 || 1;
    this.rand = mulberry32(this.seed);
    this.phase = VoyagePhase.IDLE;
    this.phaseStartMs = 0;
    this.p = { x: 0, y: 0 };
    this.hue = 200;
    this.trail = []; // {x, y, hue, tMs}
    this.constellations = []; // {points:[{x,y}], hue, bornMs}
    this.afterglows = []; // {trail:[{x,y,hue,gap}], bornMs} -- a landed voyage's last trail, fading
    this._station = { x: 0, y: 0 };
    this._startPos = { x: 0, y: 0 };
    this._windUpFrom = { x: 0, y: 0 };
    this._diveTarget = { x: 0, y: 0 };

    // Each entry is a full seed-baked recipe { kind, ...params }. Tests may
    // inject plain kind strings; _recipeAt() normalizes both shapes.
    this._figureOrder = [];
    this._figureCount = 0;
    this._figureIdx = 0;
    this._figureStartMs = 0;
    this._figureTime0 = 0; // phase alignment offset into the current figure
    this._attractor = { x: 0.12, y: 0, z: 0 };
    this._voyageSerial = 0; // increments each trigger; mixes into recipe salt

    // Melody coupling: the current Lissajous tuning, the tuning it's
    // morphing away from, and a smoothed onset phase-kick (an eased burst
    // of extra curve-time so a hard note visibly accelerates her without
    // ever teleporting the position).
    this._liss = null;      // {a, b} or null -> figure-slot default
    this._lissPrev = null;
    this._lissMorphStartMs = -Infinity;
    this._kickSmooth = 0;   // seconds of accumulated eased curve-time
    this._kickTarget = 0;
    this.justLanded = false;
    this.justLaunched = false; // one-frame flag: WINDUP -> ASCENT, the send-off's own punctuation

    this.sparkles = [];     // {x, y, vx, vy, hue, age}
    this.microSlashes = []; // {x, y, ang, hue, age}

    // The Star Atlas: constellations don't die, they crystallize. When a
    // bright constellation's 6s fade ends it commits here as a permanent
    // dim star-map entry -- the song's sky slowly accumulates a mythology
    // of her voyages. atlasPulse (fed hype.slam by the Simulation) lets
    // the whole atlas glint with the beat.
    this.atlas = []; // {stars:[{x, y, phase}], hue}
    this.atlasPulse = 0;
    this.novae = []; // {x, y, hue, phase, delayMs, bornMs} -- the finale's detonation cascade
  }

  /** The densest cluster of her own past stars: for each atlas entry,
   * count ALL atlas stars within a radius of its centroid, and return the
   * winning centroid. Null when the sky is still unwritten. */
  _navTarget() {
    if (this.atlas.length === 0) return null;
    const centroids = this.atlas.map((entry) => {
      let x = 0, y = 0;
      for (const s of entry.stars) { x += s.x; y += s.y; }
      return { x: x / entry.stars.length, y: y / entry.stars.length };
    });
    let best = null, bestCount = -1;
    for (const c of centroids) {
      let count = 0;
      for (const entry of this.atlas) {
        for (const s of entry.stars) {
          if (Math.hypot(s.x - c.x, s.y - c.y) <= NAV_CLUSTER_RADIUS_PX) count++;
        }
      }
      if (count > bestCount) { bestCount = count; best = c; }
    }
    return best;
  }

  /** Where this voyage sets up shop, inside the safe band that keeps even
   * the biggest figure on screen and above the mountains.
   *
   * Two modes. NAV_REVISIT_CHANCE of the time she returns to an old myth
   * (the original behavior: lerp toward _navTarget by NAV_PULL). The rest
   * of the time she goes somewhere new, chosen best-candidate style --
   * NAV_SPREAD_CANDIDATES random stations, keep whichever one's nearest
   * existing atlas star is furthest away. With an empty atlas both modes
   * collapse to a plain random roll, so the first voyage of a song is
   * unchanged. Pure apart from this.rand. */
  _pickStation(stageW, stageH, marginFracX, radPx) {
    const xMin = stageW * marginFracX, xMax = stageW * (1 - marginFracX);
    let yMin = radPx + 20;
    let yMax = Math.min(stageH * 0.46, stageH - radPx * 0.35);
    if (yMax < yMin) {
      const y = clamp((yMin + yMax) / 2, 24, stageH * 0.46);
      yMin = y;
      yMax = y;
    }
    const safeXMin = radPx + 8;
    const safeXMax = stageW - radPx - 8;
    const clampX = (x) => safeXMax < safeXMin ? stageW * 0.5 : clamp(x, safeXMin, safeXMax);
    const clampY = (y) => clamp(y, yMin, yMax);
    const roll = () => ({
      x: stageW * (marginFracX + this.rand() * (1 - 2 * marginFracX)),
      y: yMin + this.rand() * (yMax - yMin),
    });

    const finish = (station) => ({
      x: clampX(station.x),
      y: clampY(station.y),
    });

    const nav = this._navTarget();
    if (!nav) return finish(roll());

    if (this.rand() < NAV_REVISIT_CHANCE) {
      const base = roll();
      return finish({
        x: clamp(lerp(base.x, nav.x, NAV_PULL), xMin, xMax),
        y: clamp(lerp(base.y, nav.y, NAV_PULL), yMin, yMax),
      });
    }

    // Unwritten sky. Distance to the NEAREST existing star is the right
    // score, not distance to the densest centroid: maximizing the latter
    // just parks her on the far side of one clump, which is how a second
    // clump gets started instead of a spread.
    let best = null, bestGap = -1;
    for (let i = 0; i < NAV_SPREAD_CANDIDATES; i++) {
      const cand = roll();
      let gap = Infinity;
      for (const entry of this.atlas) {
        for (const s of entry.stars) {
          const d = Math.hypot(s.x - cand.x, s.y - cand.y);
          if (d < gap) gap = d;
        }
      }
      if (gap > bestGap) { bestGap = gap; best = cand; }
    }
    return finish(best);
  }

  /** The finale: every atlas star detonates, staggered like popcorn, and
   * the map is spent. One-shot per accumulation; no-op on an empty sky. */
  detonateAtlas(nowMs) {
    for (const entry of this.atlas) {
      for (const s of entry.stars) {
        this.novae.push({
          x: s.x, y: s.y, hue: entry.hue, phase: s.phase,
          delayMs: this.rand() * NOVA_STAGGER_MS, bornMs: nowMs,
        });
      }
    }
    this.atlas = [];
  }

  /** A melody onset while she's away: retunes the Lissajous knot to the
   * note's pitch class (with a parametric morph, not a snap), kicks the
   * figure's phase along by an eased burst proportional to velocity, cuts
   * a micro-slash at her deep-sky position, and paints her the note's hue. */
  onMelodyOnset(evt) {
    if (this.phase !== VoyagePhase.DEEP_SPACE) return;
    const pc = ((Math.round(evt.pitch ?? 60) % 12) + 12) % 12;
    this.hue = pc * 30;
    const next = LISSAJOUS_BY_PITCH_CLASS[pc];
    const cur = this._currentLiss();
    if (next[0] !== cur[0] || next[1] !== cur[1]) {
      this._lissPrev = cur;
      this._liss = next;
      this._lissMorphStartMs = this._nowMs ?? this._figureStartMs;
    }
    this._kickTarget = Math.min(KICK_MAX_SEC, this._kickTarget + 0.08 * (evt.vel ?? 0.7));
    const ang = this.rand() * Math.PI * 2;
    this.microSlashes.push({ x: this.p.x, y: this.p.y, ang, hue: this.hue, age: 0 });
    if (this.microSlashes.length > SLASH_MAX) this.microSlashes.shift();
  }

  /** A kick while she's away: a radial sparkle burst off her position. */
  onKick(vel = 0.8) {
    if (this.phase !== VoyagePhase.DEEP_SPACE) return;
    const n = 5 + Math.round(3 * vel);
    for (let i = 0; i < n; i++) {
      if (this.sparkles.length >= SPARKLES_MAX) this.sparkles.shift();
      const ang = (i / n) * Math.PI * 2 + this.rand() * 0.5;
      const speed = 40 + 60 * this.rand();
      this.sparkles.push({
        x: this.p.x, y: this.p.y,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        hue: this.hue, age: 0,
      });
    }
  }

  _currentLiss() {
    if (this._liss) return this._liss;
    const recipe = this._recipeAt(this._figureIdx);
    if (recipe?.a != null && recipe?.b != null) return [recipe.a, recipe.b];
    return LISSAJOUS_FREQS[(this._figureIdx >= 0 ? this._figureIdx : 0) % LISSAJOUS_FREQS.length];
  }

  /** Normalize a figure-order slot to a recipe object. */
  _recipeAt(idx) {
    const raw = this._figureOrder[idx];
    if (!raw) return defaultRecipe('lissajous', 0);
    if (typeof raw === 'string') return defaultRecipe(raw, idx);
    return raw;
  }

  get active() { return this.phase !== VoyagePhase.IDLE; }

  /** 0 = fully present (still visually "here"), 1 = fully deep-sky. */
  get depth() {
    switch (this.phase) {
      case VoyagePhase.WINDUP: return 0;
      case VoyagePhase.ASCENT: return this._phaseU;
      case VoyagePhase.DEEP_SPACE: return 1;
      case VoyagePhase.REENTRY: return 1 - this._phaseU;
      default: return 0;
    }
  }

  /** Multiplier onto Midasus's own draw scale during WINDUP/ASCENT/REENTRY
   *  (DEEP_SPACE isn't drawn by her at all -- BiomeManager's tiny comet-head
   *  dot takes over). Swells to WINDUP_SCALE_PEAK as she winds up, eases
   *  down to ASCENT_SCALE_FAR through the climb (receding into the
   *  distance, not cutting away), and grows back to 1 through reentry. */
  get presentationScale() {
    const u = this._phaseU ?? 0;
    const smooth = u * u * (3 - 2 * u);
    switch (this.phase) {
      case VoyagePhase.WINDUP: return lerp(1, WINDUP_SCALE_PEAK, u * u);
      case VoyagePhase.ASCENT: return lerp(WINDUP_SCALE_PEAK, ASCENT_SCALE_FAR, smooth);
      case VoyagePhase.REENTRY: return lerp(ASCENT_SCALE_FAR, 1, smooth);
      default: return 1;
    }
  }

  trigger(nowMs, fromPos, stageW, stageH, chorusText = null, lyricSymbol = null) {
    if (this.active) return false;
    this.phase = VoyagePhase.WINDUP;
    this.phaseStartMs = nowMs;
    this._startPos = { ...fromPos };
    this._windUpFrom = { ...fromPos };
    this.p = { ...fromPos };
    this._voyageSerial++;
    this._chorusText = chorusText || null;
    this._lyricSymbolPath = lyricSymbol ? glyphTracePath(lyricSymbol) : [];
    this._lyricSymbol = this._lyricSymbolPath.length >= 4 ? lyricSymbol : null;
    // The station used to roll x in [0.48, 0.78] and y in [0.12, 0.20] --
    // right-of-center only (never the left half of the sky at all) and a
    // band under a tenth of the screen tall. Confirmed live: during
    // DEEP_SPACE, the whole ~3-figure, ~10-second performance (a large,
    // bright, densely-dotted orbit shape, FIGURE_RADIUS_PX~130-150px)
    // happens anchored to that one small, almost-dead-center-and-up zone
    // every single voyage, for every song -- a real, structural instance of
    // "the [bright things in the sky] are clustered in the middle," on top
    // of and independent from the ambient-star and constellation-weaver
    // clustering already fixed elsewhere in this file's siblings. Widened
    // to use most of the sky's width (both halves, not just the right) and
    // triple the vertical band, while keeping the lowest point of the
    // biggest possible figure (station.y + ~0.21 of stageH for the largest
    // scaled radius) comfortably above where terrain peaks (~0.55).
    //
    // The safe x-margin has to be sized to whichever figure THIS voyage can
    // actually draw, not the eight math families' own max: a chorus voyage
    // sky-writes lyric text at LYRIC_TEXT_SCALE (2.2), nearly double the
    // math families' FIGURE_SCALE_MAX (1.18). Placed at the old fixed 0.12
    // margin, that text's own ends run past the frame edge -- the reported
    // "a large portion of the drawings are outside the frame."
    const voyageScaleMax = this._chorusText ? LYRIC_TEXT_SCALE
      : this._lyricSymbol ? Math.max(LYRIC_GLYPH_SCALE, FIGURE_SCALE_MAX) : FIGURE_SCALE_MAX;
    const marginFracX = clamp((FIGURE_RADIUS_PX * voyageScaleMax) / stageW, 0.05, 0.45);
    const radPx = FIGURE_RADIUS_PX * voyageScaleMax;
    this._station = this._pickStation(stageW, stageH, marginFracX, radPx);

    this._figureOrder = this._pickFigureOrder();
    this._figureCount = 0;
    this._figureIdx = -1; // advanced to 0 on entering DEEP_SPACE
    this._figureTime0 = 0;
    // Seed the Thomas state from this voyage's RNG so chaos isn't the same orbit every time.
    this._attractor = {
      x: 0.05 + this.rand() * 0.4,
      y: (this.rand() - 0.5) * 0.3,
      z: (this.rand() - 0.5) * 0.3,
    };
    this.trail = []; // clean pen for this voyage
    return true;
  }

  /** Safety valve for the excursion scheduler: skip straight to REENTRY
   * (e.g. the song is ending and everyone needs to come home). No-op if idle. */
  forceEnd(nowMs) {
    if (!this.active || this.phase === VoyagePhase.REENTRY) return;
    this._beginReentry(nowMs, this._startPos);
  }

  /**
   * Bake FIGURES_PER_VOYAGE seed-based geometric recipes for this voyage.
   * Families never consecutive-repeat; each recipe carries its own
   * intentional params (ratios, harmonics, petal count, rate, scale).
   */
  _pickFigureOrder() {
    const order = [];
    let last = null;
    for (let i = 0; i < FIGURES_PER_VOYAGE; i++) {
      // Prefer unused families this voyage, then any except last.
      const used = new Set(order.map((r) => r.kind));
      let pool = FIGURE_FAMILIES.filter((k) => k !== last && !used.has(k));
      if (!pool.length) pool = FIGURE_FAMILIES.filter((k) => k !== last);
      if (!pool.length) pool = FIGURE_FAMILIES.slice();
      const kind = pool[Math.floor(this.rand() * pool.length)];
      order.push(this._bakeRecipe(kind, i));
      last = kind;
    }
    // During a chorus voyage, replace the middle figure with sky-written
    // text — sandwiched between two mathematical figures so it reads as
    // a reveal, not a label.
    if (this._chorusText) {
      const textPath = layoutTextPath(this._chorusText);
      if (textPath.length >= 4) {
        order[1] = {
          kind: 'lyricText', rate: 1, scale: LYRIC_TEXT_SCALE,
          phase: 0, slot: 1, textPath,
        };
      }
    }
    // The lyrics' symbol: her drawings used to be pure math unless it was a
    // chorus, and even then only the words. Now whatever the section (or,
    // failing that, the song) keeps returning to -- love, time, freedom,
    // captivity -- is traced as one of her three figures: the centrepiece
    // normally, and the opening figure when the middle slot is already the
    // chorus's own words.
    if (this._lyricSymbol) {
      const slot = order[1]?.kind === 'lyricText' ? 0 : 1;
      order[slot] = {
        kind: 'lyricGlyph', rate: 1, scale: LYRIC_GLYPH_SCALE,
        phase: 0, slot, textPath: this._lyricSymbolPath, glyphId: this._lyricSymbol,
      };
    }
    return order;
  }

  /**
   * Intentional-but-varied parameters for one geometric family.
   * Pure function of this.rand (already seed-mixed via voyage serial).
   */
  _bakeRecipe(kind, slot) {
    const r = this.rand;
    const rate = 1.25 + r() * 0.9; // curve speed
    const scale = 0.82 + r() * 0.36; // radius scale relative to FIGURE_RADIUS_PX
    const base = { kind, rate, scale, phase: r() * Math.PI * 2, slot };

    if (kind === 'lissajous') {
      const [a, b] = LISS_PAIR_POOL[Math.floor(r() * LISS_PAIR_POOL.length)];
      // Occasionally swap axes so vertical-dominant knots appear too.
      const swap = r() < 0.35;
      return {
        ...base,
        a: swap ? b : a,
        b: swap ? a : b,
        delta: [0, Math.PI / 4, Math.PI / 2, Math.PI / 3, Math.PI / 6][Math.floor(r() * 5)],
        aspect: 0.72 + r() * 0.5, // y stretch — ellipses, not only circles
      };
    }
    if (kind === 'epicycle') {
      // 2–4 nested circles; outer always k=1 so it stays a closed rosette.
      const nTerms = 2 + Math.floor(r() * 3);
      const terms = [{ r: 1.0, k: 1, s: r() < 0.5 ? 1 : -1 }];
      const harmonics = [2, 3, 4, 5, 7, 8];
      for (let i = harmonics.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        const tmp = harmonics[i]; harmonics[i] = harmonics[j]; harmonics[j] = tmp;
      }
      let rem = 0.55 + r() * 0.2;
      for (let i = 0; i < nTerms - 1; i++) {
        const share = rem * (0.45 + r() * 0.4);
        rem -= share;
        terms.push({
          r: share,
          k: harmonics[i % harmonics.length],
          s: r() < 0.45 ? -1 : 1, // reverse spin on some shells
        });
      }
      return { ...base, terms };
    }
    if (kind === 'superformula') {
      // m controls lobes; n's keep the form star/flower rather than blob.
      const m = 3 + Math.floor(r() * 6); // 3–8
      const n1 = 0.3 + r() * 1.4;
      const n2 = 0.8 + r() * 12;
      const n3 = 0.8 + r() * 12;
      return { ...base, m, n1, n2, n3, a: 1, bb: 1 };
    }
    if (kind === 'rose') {
      // Rhodonea: r = cos(k θ). Integer k → k (or 2k) petals.
      const k = 2 + Math.floor(r() * 6); // 2–7
      const offset = r() * 0.25; // slight offset so it isn't a pure zero-at-origin star
      return { ...base, k, offset, sinMode: r() < 0.5 };
    }
    if (kind === 'hypotrochoid') {
      // Spirograph: integers R,r for a closed curve; d sets the pen throw.
      const R = 4 + Math.floor(r() * 6); // 4–9
      const rInner = 1 + Math.floor(r() * Math.min(4, R - 1)); // 1..R-1
      const d = rInner * (0.45 + r() * 0.9);
      return { ...base, R, r: rInner, d };
    }
    if (kind === 'harmonograph') {
      // Two-term sum per axis (a real pendulum harmonograph's signature):
      // richer, less symmetric loops than a single-frequency Lissajous.
      const a1 = 1 + Math.floor(r() * 4);
      const a2 = a1 + 1 + Math.floor(r() * 3);
      const b1 = 1 + Math.floor(r() * 4);
      const b2 = b1 + 1 + Math.floor(r() * 3);
      return {
        ...base, a1, a2, b1, b2,
        mix: 0.3 + r() * 0.3,
        p2: r() * Math.PI * 2, p3: r() * Math.PI * 2, p4: r() * Math.PI * 2,
      };
    }
    if (kind === 'spiral') {
      // A breathing spiral: winds `turns` times while its radius swells
      // from the center out and back -- reads as a slow bloom rather than
      // a static rosette, the one figure here that isn't a fixed loop.
      const turns = 2 + Math.floor(r() * 3);
      const aspect = 0.75 + r() * 0.5;
      const dir = r() < 0.5 ? 1 : -1;
      return { ...base, turns, aspect, dir };
    }
    // thomas — live attractor; only rate/scale/phase salt vary.
    return {
      ...base,
      attractorScale: 3.6 + r() * 1.4,
    };
  }

  update(nowMs, dtSec, epicMood, ensembleAnchor) {
    this._nowMs = nowMs;
    this.justLanded = false;
    this.justLaunched = false;
    // Constellations, sparkles, and slashes keep fading even once she's home.
    this.pruneConstellations(nowMs);
    for (const s of this.sparkles) { s.x += s.vx * dtSec; s.y += s.vy * dtSec; s.age += dtSec; }
    this.sparkles = this.sparkles.filter((s) => s.age < SPARKLE_LIFE_SEC);
    for (const s of this.microSlashes) s.age += dtSec;
    this.microSlashes = this.microSlashes.filter((s) => s.age < SLASH_LIFE_SEC);
    // Nova cascade keeps playing out whether or not she's away.
    this.novae = this.novae.filter((n) => nowMs - n.bornMs < n.delayMs + NOVA_LIFE_MS);
    // Onset phase-kicks ease toward their target rather than jumping.
    this._kickSmooth += (1 - Math.exp(-dtSec / KICK_TAU_SEC)) * (this._kickTarget - this._kickSmooth);
    this._kickSmooth = Math.min(KICK_MAX_SEC, this._kickSmooth);
    // Slowly bleed spent kick so a run of onsets doesn't permanently race
    // the parameter; keeps the "whip" without stacking forever.
    if (this._kickTarget > 0) {
      this._kickTarget = Math.max(0, this._kickTarget - dtSec * 0.12);
    }
    if (!this.active) return;
    const elapsed = (nowMs - this.phaseStartMs) / 1000;

    if (this.phase === VoyagePhase.WINDUP) {
      this._phaseU = clamp(elapsed / WINDUP_SEC, 0, 1);
      // Spiral in: orbit radius shrinks while angular rate ramps up --
      // conservation-of-angular-momentum read as "gathering power."
      const radius = lerp(60, 8, this._phaseU);
      const rate = lerp(1.8, 9, this._phaseU);
      const ang = this._phaseU * rate * 6;
      this.p = { x: this._windUpFrom.x + radius * Math.cos(ang), y: this._windUpFrom.y + radius * Math.sin(ang) };
      if (this._phaseU >= 1) {
        this.phase = VoyagePhase.ASCENT;
        this.phaseStartMs = nowMs;
        this._startPos = { ...this.p };
        this.justLaunched = true; // one-frame flag: Midasus/Simulation fire send-off FX off this
      }
    } else if (this.phase === VoyagePhase.ASCENT) {
      this._phaseU = clamp(elapsed / ASCENT_SEC, 0, 1);
      const u = this._phaseU;
      const ease = u * u * (3 - 2 * u);
      // Cubic-ish climb: a control point above the start so the path arcs
      // upward rather than cutting a straight diagonal line.
      const ctrl = { x: (this._startPos.x + this._station.x) / 2, y: Math.min(this._startPos.y, this._station.y) - 80 };
      this.p = {
        x: (1 - ease) * (1 - ease) * this._startPos.x + 2 * (1 - ease) * ease * ctrl.x + ease * ease * this._station.x,
        y: (1 - ease) * (1 - ease) * this._startPos.y + 2 * (1 - ease) * ease * ctrl.y + ease * ease * this._station.y,
      };
      // Climb is travel, not sky-writing — don't stroke the ascent path.
      if (this._phaseU >= 1) {
        this.phase = VoyagePhase.DEEP_SPACE;
        this.phaseStartMs = nowMs;
        this._figureIdx = 0;
        this._figureStartMs = nowMs;
        this._figureCount = 1;
        this._resetFigureMotion();
        this._figureTime0 = this._phaseAlignFigure(this._figureOrder[0], this._offsetFromStation(this.p));
        // Place her on the first figure and pen-up so climb doesn't chord into it.
        this._placeOnFigure(nowMs, true);
      }
    } else if (this.phase === VoyagePhase.DEEP_SPACE) {
      // The Thomas attractor keeps integrating in the background regardless
      // of which figure is currently on screen, so selecting it mid-voyage
      // resumes a live chaotic system rather than a paused one. Matches
      // ChaosRibbon's "attractor-time per real second" integration scale.
      const b = lerp(0.32, 0.19, clamp(epicMood, 0, 1));
      const speed = 1.6;
      const substeps = 3;
      // Thomas' system genuinely has slow "laminar" stretches near its
      // unstable fixed points where the state barely moves for a real
      // second or two before bursting away again -- mathematically
      // correct chaos, but for a single point being watched live (not a
      // whole trail, like ChaosRibbon draws) it reads as Midasus visibly
      // stopping mid-figure. Reparametrize closer to arc length than wall-
      // clock time: when the local velocity is slow, walk more attractor-
      // time this frame so the ON-SCREEN pace stays roughly even, without
      // ever slowing an already-fast stretch further. The path drawn is
      // still the real Thomas attractor -- only the real-time pacing evens out.
      const deriv0 = thomasDeriv(this._attractor, b);
      const localSpeed = Math.hypot(deriv0.x, deriv0.y, deriv0.z);
      const SPEED_FLOOR = 0.4; // below this, start compensating
      const MAX_BOOST = 6;     // cap how hard a dead-still patch gets sped through
      const boost = clamp(SPEED_FLOOR / Math.max(localSpeed, 1e-3), 1, MAX_BOOST);
      const h = (speed * dtSec * boost) / substeps;
      for (let i = 0; i < substeps; i++) this._attractor = rk4Step3(thomasDeriv, this._attractor, h, b);

      const figElapsed = (nowMs - this._figureStartMs) / 1000;
      if (figElapsed >= FIGURE_SEC) {
        this._stampConstellation(nowMs);
        const exitOff = this._offsetFromStation(this.p);
        this._figureIdx++;
        this._figureStartMs = nowMs;
        this._figureCount++;
        this._resetFigureMotion();
        if (this._figureCount > FIGURES_PER_VOYAGE) {
          this._beginReentry(nowMs, ensembleAnchor);
        } else {
          // Next figure: phase-align so she resumes near the exit, pen-up so
          // we NEVER lerp a straight chord between two different curves.
          this._figureTime0 = this._phaseAlignFigure(this._figureOrder[this._figureIdx], exitOff);
          this._placeOnFigure(nowMs, true);
        }
      }
      if (this.phase === VoyagePhase.DEEP_SPACE) {
        this._placeOnFigure(nowMs, false);
      }
    } else if (this.phase === VoyagePhase.REENTRY) {
      this._phaseU = clamp(elapsed / REENTRY_SEC, 0, 1);
      const u = this._phaseU;
      // Smoothstep: moves immediately from her last sky-writing pose (not a
      // cubic hang at the station for half a second).
      const ease = u * u * (3 - 2 * u);
      const from = this._reentryFrom || this._station;
      this.p = {
        x: lerp(from.x, this._diveTarget.x, ease),
        y: lerp(from.y, this._diveTarget.y, ease),
      };
      this.hue = lerp(this._reentryHue0 ?? this.hue, 20, u); // blends toward re-entry orange
      // No trail during reentry — the dive home used to paint a long straight.
      if (this._phaseU >= 1) {
        this.phase = VoyagePhase.IDLE;
        if (this.trail.length > 1) {
          this.afterglows.push({ trail: this.trail, bornMs: nowMs });
          if (this.afterglows.length > AFTERGLOW_MAX) this.afterglows.shift();
        }
        this.trail = [];
        this._liss = null;
        this._lissPrev = null;
        this._kickSmooth = 0;
        this._kickTarget = 0;
        this.justLanded = true; // one-frame flag: Midasus/Simulation fire landing FX off this
      }
    }
  }

  /** Start the dive home from her live sky position (never snap to station). */
  _beginReentry(nowMs, ensembleAnchor) {
    this.phase = VoyagePhase.REENTRY;
    this.phaseStartMs = nowMs;
    this._reentryFrom = { x: this.p.x, y: this.p.y };
    this._reentryHue0 = this.hue;
    this._diveTarget = ensembleAnchor ? { ...ensembleAnchor } : { ...this._startPos };
    this._pushTrail(nowMs, true);
  }

  /** Unit offset of a screen point relative to the deep-sky station. */
  _offsetFromStation(p) {
    return {
      x: (p.x - this._station.x) / FIGURE_RADIUS_PX,
      y: (p.y - this._station.y) / FIGURE_RADIUS_PX,
    };
  }

  /** Clear per-figure motion debt so the next figure starts clean. */
  _resetFigureMotion() {
    this._kickSmooth = 0;
    this._kickTarget = 0;
    // Don't carry a mid-retune blend into a brand-new figure kind.
    this._lissPrev = null;
  }

  /**
   * Pick a time offset so the new figure's pose is as close as possible to
   * `targetOff` (previous exit). Avoids a visible teleport of the mote
   * without drawing a straight morph chord between different curves.
   */
  _phaseAlignFigure(recipeOrKind, targetOff) {
    const recipe = typeof recipeOrKind === 'string'
      ? defaultRecipe(recipeOrKind, this._figureIdx)
      : (recipeOrKind || this._recipeAt(this._figureIdx));
    if (!recipe || recipe.kind === 'thomas' || recipe.kind === 'lyricText' || recipe.kind === 'lyricGlyph') return 0;
    let bestT = 0, bestD = Infinity;
    // Sample ~1.5 periods of the parametric rate used in _figureOffset.
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * 4.0;
      const o = this._figureOffset(recipe, t);
      const d = (o.x - targetOff.x) ** 2 + (o.y - targetOff.y) ** 2;
      if (d < bestD) { bestD = d; bestT = t; }
    }
    return bestT;
  }

  /** Evaluate the current figure at the live clock and write p (+ trail). */
  _placeOnFigure(nowMs, penUp) {
    const recipe = this._recipeAt(this._figureIdx);
    const localT = (nowMs - this._figureStartMs) / 1000 + this._kickSmooth + (this._figureTime0 || 0);
    const raw = this._figureOffset(recipe, localT);
    const rad = FIGURE_RADIUS_PX * (recipe.scale ?? 1);
    this.p = {
      x: this._station.x + raw.x * rad,
      y: this._station.y + raw.y * rad,
    };
    this._pushTrail(nowMs, penUp);
  }

  /**
   * Unit-disk (roughly) offset for a recipe at parametric time localT.
   * Accepts a recipe object or a bare kind string (tests).
   */
  _figureOffset(recipeOrKind, localT) {
    const recipe = typeof recipeOrKind === 'string'
      ? defaultRecipe(recipeOrKind, this._figureIdx)
      : (recipeOrKind || defaultRecipe('lissajous', 0));
    const kind = recipe.kind;
    const RATE = recipe.rate ?? 1.6;
    const phase0 = recipe.phase ?? 0;

    if (kind === 'lissajous') {
      const [a, b] = this._currentLiss();
      const delta = recipe.delta ?? Math.PI / 4;
      const aspect = recipe.aspect ?? 1;
      const cur = {
        x: Math.sin(a * RATE * localT + phase0),
        y: Math.sin(b * RATE * localT + delta + phase0) * aspect,
      };
      // Mid-retune: evaluate BOTH tunings at the same parameter and blend --
      // the same morph trick used at figure switches, here for the melody's
      // pitch-class retargeting.
      if (this._lissPrev) {
        const uRaw = clamp(((this._nowMs ?? 0) - this._lissMorphStartMs) / (LISS_MORPH_SEC * 1000), 0, 1);
        if (uRaw >= 1) { this._lissPrev = null; return cur; }
        const u = uRaw * uRaw * (3 - 2 * uRaw);
        const [pa, pb] = this._lissPrev;
        const prev = {
          x: Math.sin(pa * RATE * localT + phase0),
          y: Math.sin(pb * RATE * localT + delta + phase0) * aspect,
        };
        return { x: lerp(prev.x, cur.x, u), y: lerp(prev.y, cur.y, u) };
      }
      return cur;
    }
    if (kind === 'epicycle') {
      const terms = recipe.terms || [{ r: 1.0, k: 1, s: 1 }, { r: 0.48, k: 3, s: 1 }, { r: 0.2, k: 7, s: 1 }];
      const norm = terms.reduce((s, t) => s + t.r, 0) || 1;
      let x = 0, y = 0;
      for (const t of terms) {
        const ang = t.s * t.k * RATE * localT + phase0;
        x += t.r * Math.cos(ang);
        y += t.r * Math.sin(ang);
      }
      return { x: x / norm, y: y / norm };
    }
    if (kind === 'superformula') {
      const phi = localT * RATE + phase0;
      const m = recipe.m ?? 6;
      const n1 = recipe.n1 ?? 1;
      const n2 = recipe.n2 ?? 10;
      const n3 = recipe.n3 ?? 10;
      const r = clamp(superformula(phi, m, n1, n2, n3), 0.05, 2.2);
      return { x: (r / 1.2) * Math.cos(phi), y: (r / 1.2) * Math.sin(phi) };
    }
    if (kind === 'rose') {
      const k = recipe.k ?? 4;
      const phi = localT * RATE + phase0;
      const wave = recipe.sinMode ? Math.sin(k * phi) : Math.cos(k * phi);
      const rr = Math.abs(wave) * (1 - (recipe.offset ?? 0)) + (recipe.offset ?? 0);
      return { x: rr * Math.cos(phi), y: rr * Math.sin(phi) };
    }
    if (kind === 'hypotrochoid') {
      const R = recipe.R ?? 5;
      const rIn = recipe.r ?? 3;
      const d = recipe.d ?? 2;
      const theta = localT * RATE * 0.55 + phase0;
      const p = hypotrochoid(theta, R, rIn, d);
      // Normalize by outer radius so the figure sits near unit scale.
      const norm = Math.max(1e-6, Math.abs(R - rIn) + Math.abs(d));
      return { x: p.x / norm, y: p.y / norm };
    }
    if (kind === 'lyricText' || kind === 'lyricGlyph') {
      const path = recipe.textPath;
      if (!path || path.length < 2) return { x: 0, y: 0 };
      const totalTime = FIGURE_SEC * 0.82;
      const progress = clamp(localT / totalTime, 0, 0.9999);
      const fi = progress * (path.length - 1);
      const i = Math.floor(fi);
      const frac = fi - i;
      const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
      if (b.gap) return { x: b.x, y: b.y };
      return { x: lerp(a.x, b.x, frac), y: lerp(a.y, b.y, frac) };
    }
    if (kind === 'harmonograph') {
      const a1 = recipe.a1 ?? 2, a2 = recipe.a2 ?? 5;
      const b1 = recipe.b1 ?? 3, b2 = recipe.b2 ?? 7;
      const mix = recipe.mix ?? 0.4;
      const p2 = recipe.p2 ?? 0, p3 = recipe.p3 ?? Math.PI / 2, p4 = recipe.p4 ?? 0;
      const x = (1 - mix) * Math.sin(a1 * RATE * localT + phase0) + mix * Math.sin(a2 * RATE * localT + p2);
      const y = (1 - mix) * Math.sin(b1 * RATE * localT + p3) + mix * Math.sin(b2 * RATE * localT + p4);
      return { x, y };
    }
    if (kind === 'spiral') {
      const turns = recipe.turns ?? 3;
      const aspect = recipe.aspect ?? 1;
      const dir = recipe.dir ?? 1;
      const phi = dir * (localT * RATE + phase0);
      const breathe = 0.5 - 0.5 * Math.cos(phi / turns);
      const rr = 0.12 + 0.88 * breathe;
      return { x: rr * Math.cos(phi), y: rr * Math.sin(phi) * aspect };
    }
    // 'thomas': read the persistent chaotic state -- update() integrates it
    // once per frame in the background regardless of which figure is shown.
    const as = recipe.attractorScale ?? 4.2;
    return {
      x: clamp(this._attractor.x / as, -1.3, 1.3),
      y: clamp(this._attractor.y / as, -1.3, 1.3),
    };
  }

  /**
   * @param {number} nowMs
   * @param {boolean} [forceGap] pen-up — next segment won't stroke from previous point
   */
  _pushTrail(nowMs, forceGap = false) {
    const last = this.trail[this.trail.length - 1];
    let gap = !!forceGap;
    if (last && !gap) {
      const d = Math.hypot(this.p.x - last.x, this.p.y - last.y);
      // Frame-to-frame teleport (phase bug / huge kick): break the stroke.
      if (d > TRAIL_GAP_PX) gap = true;
    }
    // Skip near-duplicate samples so dense steps don't explode the buffer
    // without adding shape (still record gaps so the pen lifts).
    if (last && !gap) {
      const d = Math.hypot(this.p.x - last.x, this.p.y - last.y);
      if (d < 0.35 && nowMs - last.tMs < 12) return;
    }
    this.trail.push({ x: this.p.x, y: this.p.y, hue: this.hue, tMs: nowMs, gap });
    const cutoff = nowMs - TRAIL_SEC * 1000;
    while (this.trail.length && this.trail[0].tMs < cutoff) this.trail.shift();
    if (this.trail.length > TRAIL_MAX_PTS) this.trail.splice(0, this.trail.length - TRAIL_MAX_PTS);
  }

  _stampConstellation(nowMs) {
    const figStart = this._figureStartMs;
    // Only continuous (non-gap) samples from this figure — no pen-up jumps.
    const points = [];
    for (const pt of this.trail) {
      if (pt.tMs < figStart) continue;
      if (pt.gap && points.length > 0) break; // stop at next pen-up
      points.push({ x: pt.x, y: pt.y });
    }
    if (points.length < 3) return;
    // Dense enough that consecutive samples stay on the curve (no long chords).
    const sampled = [];
    const step = Math.max(1, Math.floor(points.length / 28));
    for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) {
      sampled.push(points[points.length - 1]);
    }
    this.constellations.push({ points: sampled, hue: this.hue, bornMs: nowMs });
    if (this.constellations.length > CONSTELLATION_MAX) this.constellations.shift();
  }

  /** A constellation past its bright fade doesn't vanish -- it crystallizes
   * into the permanent atlas as dim twinkling stars. Call once per frame. */
  pruneConstellations(nowMs) {
    const keep = [];
    for (const c of this.constellations) {
      if (nowMs - c.bornMs < CONSTELLATION_LIFE_SEC * 1000) { keep.push(c); continue; }
      this.atlas.push({
        stars: c.points.map((p) => ({ x: p.x, y: p.y, phase: this.rand() * Math.PI * 2 })),
        hue: c.hue,
      });
      if (this.atlas.length > ATLAS_MAX) this.atlas.shift();
    }
    this.constellations = keep;
    this.afterglows = this.afterglows.filter((g) => nowMs - g.bornMs < AFTERGLOW_SEC * 1000);
  }
}

/** 1 at landing, easing to 0 over AFTERGLOW_SEC. */
export function afterglowLife01(bornMs, nowMs) {
  const u = clamp((nowMs - bornMs) / (AFTERGLOW_SEC * 1000), 0, 1);
  return 1 - u * u * (3 - 2 * u);
}

export function constellationLife01(bornMs, nowMs) {
  const age = (nowMs - bornMs) / 1000;
  if (age <= CONSTELLATION_HOLD_SEC) return 1;
  const u = clamp((age - CONSTELLATION_HOLD_SEC) / CONSTELLATION_FADE_SEC, 0, 1);
  const s = u * u * (3 - 2 * u);
  return 1 - s;
}

/** Fallback recipe when tests inject bare kind strings into _figureOrder. */
function defaultRecipe(kind, slot = 0) {
  const base = { kind, rate: 1.6, scale: 1, phase: 0, slot };
  if (kind === 'lissajous') {
    const [a, b] = LISSAJOUS_FREQS[slot % LISSAJOUS_FREQS.length];
    return { ...base, a, b, delta: Math.PI / 4, aspect: 1 };
  }
  if (kind === 'epicycle') {
    return {
      ...base,
      terms: [
        { r: 1.0, k: 1, s: 1 },
        { r: 0.48, k: 3, s: 1 },
        { r: 0.2, k: 7, s: 1 },
      ],
    };
  }
  if (kind === 'superformula') return { ...base, m: 6, n1: 1, n2: 10, n3: 10 };
  if (kind === 'rose') return { ...base, k: 4, offset: 0.08, sinMode: false };
  if (kind === 'hypotrochoid') return { ...base, R: 5, r: 3, d: 2.2 };
  if (kind === 'thomas') return { ...base, attractorScale: 4.2 };
  if (kind === 'harmonograph') return { ...base, a1: 2, a2: 5, b1: 3, b2: 7, mix: 0.4, p2: 0, p3: Math.PI / 2, p4: 0 };
  if (kind === 'spiral') return { ...base, turns: 3, aspect: 1, dir: 1 };
  return { ...base, kind: 'lissajous', a: 3, b: 2, delta: Math.PI / 4, aspect: 1 };
}
