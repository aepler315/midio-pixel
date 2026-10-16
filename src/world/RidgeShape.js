// The SHAPE of a mountain, as distinct from where its summits come from
// (that's RidgePortrait's job -- the song picks the summits; this file
// decides what a summit actually looks like and how a range hangs
// together).
//
// What was wrong with the previous model: a range was a set of INDEPENDENT
// parametric bumps, each `max`ed against a low noise floor. Three
// consequences, all visible the moment you render the height field:
//
//   1. The flanks came out straight. The old peakProfile blended a dome
//      term (exponent < 1, flat-topped) with a spire term (exponent 3) at
//      an 80/20 mix, and those two average into a near-perfect isoceles
//      triangle. A row of triangles reads as bunting, not as mountains.
//   2. Wherever no summit stood, the field fell to the noise floor, so a
//      large fraction of every tile was dead flat ground -- and the strip
//      TILES, so that dead stretch scrolls past on repeat.
//   3. Saddles collapsed to the floor between neighbours, so summits read
//      as separate cones standing on a plain rather than as high points on
//      one connected crest.
//
// The model here is the other way around: a range is a CREST SPINE that
// runs unbroken across the whole tile, and summits are elevations OF that
// spine. Detail is anchored to relief (how far above the valley floor we
// already are) instead of sprayed uniformly, so valleys stay calm and
// crests carry the texture -- which is both what real terrain does and
// what stops the noise from inventing summits that compete with the ones
// the song actually chose.
//
// Pure, DOM-free, deterministic -- tests exercise every function directly.
import { clamp, clamp01, lerp } from '../utils/math.js';
import { plateauProfile } from './ColoradoPlateau.js';

/**
 * One side of a summit: height 0..1 at normalized flank distance `d`
 * (0 at the summit, 1 at the foot).
 *
 * A superellipse quarter, which gives a single intuitive knob for the one
 * thing that actually distinguishes mountain silhouettes from tents:
 *
 *   q < 1  concave/pinched sides  -- a horn (Matterhorn, Grand Teton)
 *   q = 1  a straight triangle    -- what the old code was accidentally making
 *   q > 1  convex/bulging sides   -- a shield or dome
 *
 * Real alpine summits sit just below 1: crisp near the top, easing as they
 * go down, with the broad connective mass supplied separately by the apron
 * (see apronMass) rather than by fattening the summit itself. Keeping those
 * two jobs in separate terms is what lets a range be both sharply-peaked
 * AND properly joined up, which a single blended profile could not do.
 */
export function flankProfile(d, q) {
  const t = clamp01(d);
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const qq = Math.max(0.2, q);
  return Math.pow(1 - Math.pow(t, qq), 1 / qq);
}

// A summit's steep side is narrower AND more pinched than its shallow side.
// Real ranges get this from asymmetric erosion -- a glacial cirque bites a
// steep headwall on one flank while the other keeps a long dip slope -- and
// because the ice came from a prevailing direction, neighbouring summits
// mostly lean the SAME way. That regional consistency is a much stronger
// realism cue than per-peak randomness, which just reads as noise.
// Neither side may sit near q=1: that is exactly the straight-sided
// triangle this rewrite exists to get rid of. The steep side is pinched
// (concave, a cirque headwall), the shallow side bulges (convex, a long
// dip slope running out to the valley) -- so the two flanks of one summit
// are visibly different CURVES, not just different widths.
//
// September 2026 sharpening pass: the previous values still landed visibly
// closer to a tent than to a horn on screen. The steep exponent deepens
// (0.55 -> 0.47, and the spiky end of flankQs reaches ~0.42), the steep
// face narrows (0.66 -> 0.56 of nominal width), and the dip slope lengthens
// to compensate (1.42 -> 1.50), so a summit's footprint stays roughly fixed
// while its crest turns into an edge. A pinched profile on a narrower base
// is exactly what makes a peak read as a point rather than as a broad knob:
// the sharpened steep face covers LESS strip than before, which also keeps
// total silhouette coverage flat (the perf governor's binding constraint).
export const FLANK_Q_STEEP = 0.47;
export const FLANK_Q_SHALLOW = 1.42;
export const STEEP_WIDTH_MUL = 0.56;
export const SHALLOW_WIDTH_MUL = 1.50;
// Plateau formations are far more symmetric than alpine peaks: erosion works
// inward from both faces at similar rates on flat-lying rock, so a butte does
// not have a "steep side" the way a glacially carved mountain does. Using the
// alpine multipliers here made every mesa look like it was sliding downhill.
export const PLATEAU_STEEP_MUL = 0.90;
export const PLATEAU_SHALLOW_MUL = 1.12;

/**
 * The two flank curvatures a character (and therefore a song, through
 * ShapeGrammar's terrain mods) implies.
 *
 * This is where the song's spike-vs-organic bias reaches the actual
 * silhouette. The old model spent `shoulder`/`spire`/`spireMix` on
 * peakProfile's power blend; this model spends them on the superellipse
 * exponents instead, so a spiky song still gets genuinely needle-like
 * summits and an organic one still gets broad convex ones. Both returned
 * values deliberately stay clear of q=1 across the whole input range --
 * q=1 is the straight-sided triangle, which is the shape this rewrite
 * exists to eliminate.
 */
export function flankQs(cfg, litho = null, songMix = 0) {
  const shoulder = cfg?.shoulder ?? 0.66;
  const spire = cfg?.spire ?? 2.6;
  const spireMix = cfg?.spireMix ?? 0.2;
  let spiky = clamp01(
    0.25
    + spireMix * 1.6
    + ((spire - 1.6) / 2.6) * 0.35
    - ((shoulder - 0.35) / 0.95) * 0.45,
  );
  // The song's own spectral mass shapes the cross-section too, blended in
  // at the layer's profileMix (L3, the timbre layer, leans hardest). This
  // is the link the old field ran through massProfile's three-term flank:
  // a tip-heavy (airy/bright) mix pinches the summit into a horn, a
  // foot-heavy (bass) one carries its bulk high and broad. Dropping it
  // when the flank model changed would have quietly cost the ranges one of
  // the two things that actually made them the SONG's mountains.
  if (litho && songMix > 0) {
    const tip = litho.tip ?? 0.3;
    const foot = litho.foot ?? 0.35;
    const songSpiky = clamp01(0.5 + (tip - foot) * 1.35);
    spiky = lerp(spiky, songSpiky, clamp01(songMix));
  }
  return {
    // The spiky reach keeps pace with the sharpened FLANK_Q_STEEP: a truly
    // spike-driven song now drives the steep face to ~0.42, a genuinely
    // needle-like horn, instead of stalling at the old floor of 0.42-0.45
    // that still rendered as a wide cone.
    steep: lerp(0.85, FLANK_Q_STEEP - 0.05, spiky),
    shallow: lerp(1.85, FLANK_Q_SHALLOW - 0.30, spiky),
  };
}

// A landmark's attack has to be decisive before it overrules the range's
// regional dip: below this it is as likely to be the shape of the analysis
// window as the shape of the music, and letting every summit pick its own
// side on a weak reading is exactly the per-peak randomness the regional
// grain exists to avoid.
export const ATTACK_FLANK_FLOOR = 0.28;
// How much further apart the two faces are pulled at a maximal attack. A
// hard drop is a genuinely lopsided mountain; a swell barely leans.
export const ATTACK_ASYM_MAX = 1.34;

/**
 * Height contributed by one summit at signed distance `dx` from its apex.
 *
 * `dip` (-1 or +1) is the range's prevailing steep direction; a summit
 * whose own `flip` disagrees with it reverses -- a handful of those per
 * range keeps the run from looking stamped, without losing the regional
 * grain.
 *
 * `peak.attack` overrules both when the song was emphatic about it. The
 * strip scrolls right-to-left and larger x is later music, so a landmark
 * that rose faster than it fell (a drop: attack > 0) puts its headwall on
 * the earlier side -- the face you walk INTO on the way to the hit -- and
 * trails its long dip slope out behind. A swell that faded sharply (attack
 * < 0) does the reverse. That single sign is the difference between a range
 * that merely has the song's peaks in it and one that shows you the song's
 * gestures as you travel past them.
 */
export function summitMass(dx, peak, dip = 1, qs = null) {
  const attack = clamp(peak.attack ?? 0, -1, 1);
  const decisive = Math.abs(attack) >= ATTACK_FLANK_FLOOR;
  const steepIsLeft = decisive ? attack > 0 : (peak.flip ? -dip : dip) > 0;
  const onLeft = dx < 0;
  const steepSide = onLeft === steepIsLeft;
  // The asymmetry deepens with how emphatic the attack was, about the
  // existing steep/shallow multipliers, so the footprint stays roughly
  // fixed while the two faces trade length.
  const lean = decisive
    ? lerp(1, ATTACK_ASYM_MAX, (Math.abs(attack) - ATTACK_FLANK_FLOOR) / (1 - ATTACK_FLANK_FLOOR))
    : 1;
  const base = steepSide ? STEEP_WIDTH_MUL / lean : SHALLOW_WIDTH_MUL * lean;
  const halfWidth = Math.max(8, peak.w * base);
  const d = Math.abs(dx) / halfWidth;
  if (d >= 1) return 0;
  const q = steepSide
    ? (qs?.steep ?? FLANK_Q_STEEP)
    : (qs?.shallow ?? FLANK_Q_SHALLOW);
  return flankProfile(d, q) * peak.h;
}

/**
 * Height contributed by one PLATEAU formation at signed distance `dx`.
 *
 * The southern-Utah counterpart to `summitMass`. The asymmetry machinery is
 * unchanged -- one flank still runs steeper than the other, and a summit's
 * own `flip` can disagree with the regional dip -- but the profile inside
 * that envelope is a formation (caprock, cliff bands, benches, talus) rather
 * than a continuous alpine flank. See ColoradoPlateau.js.
 *
 * A butte's two sides are far less different than a mountain's, so the width
 * asymmetry is compressed: erosion works inward from both faces at similar
 * rates on flat-lying rock. Leaving the alpine multipliers in place made
 * every mesa look like it was sliding downhill.
 */
/**
 * Recover the 0..1 spike-vs-organic figure from a flankQs result.
 *
 * flankQs already blends the character dials, the song's lithology and the
 * layer's profileMix into its two exponents; this reads that blend back out
 * so the plateau formations can be chosen from the same number rather than
 * from a second, independently-drifting copy of the same logic.
 * FLANK_Q_STEEP is the spikiest steep exponent the blend can reach and 0.85
 * the least, so the steep side alone recovers it.
 */
export function flankness01(qs) {
  const steep = qs?.steep ?? 0.85;
  return clamp01((0.85 - steep) / Math.max(1e-6, 0.85 - (FLANK_Q_STEEP - 0.13)));
}

/**
 * One formation's contribution to the height field.
 *
 * The profile alone cannot carry the variety: a fin and a mesa can have
 * completely different cross-sections and still read as the same object if
 * they are drawn the same width and the same height. So the form's own
 * `widthMul`, `heightMul` and `asym` are applied here, and they do as much
 * work as the profile does.
 *
 * `asym` is the cuesta lever. A monocline -- Comb Ridge, the Waterpocket
 * Fold -- has one plumb face and a dip slope running several times longer.
 * Splitting it as a square root about the existing steep/shallow multipliers
 * keeps the formation's total footprint roughly fixed while the two sides
 * trade length, so a reef leans without also becoming twice the landform.
 */
export function plateauMass(dx, peak, dip = 1) {
  const form = peak.form;
  const steepIsLeft = (peak.flip ? -dip : dip) > 0;
  const onLeft = dx < 0;
  const steepSide = onLeft === steepIsLeft;
  const base = steepSide ? PLATEAU_STEEP_MUL : PLATEAU_SHALLOW_MUL;
  const asym = Math.max(1, form?.asym ?? 1);
  const lean = steepSide ? 1 / Math.sqrt(asym) : Math.sqrt(asym);
  const halfWidth = Math.max(6, peak.w * (form?.widthMul ?? 1) * base * lean);
  const d = Math.abs(dx) / halfWidth;
  if (d >= 1) return 0;
  return plateauProfile(d, form) * peak.h * (form?.heightMul ?? 1);
}

/**
 * The connective mass around a summit's foot -- the thing that makes a
 * RANGE instead of a row of cones. Wide, low, and additive across
 * neighbours so overlapping feet pile into genuine high saddles; capped by
 * the caller so a crowded stretch never fills flat to summit height.
 */
export function apronMass(dx, peak, spread) {
  const reach = Math.max(8, peak.w * Math.max(1, spread));
  const d = Math.abs(dx) / reach;
  if (d >= 1) return 0;
  // Squared falloff: stays high near the foot (building the saddle) then
  // releases quickly, so aprons join NEIGHBOURS without flooding the
  // whole tile into a plateau.
  const t = 1 - d;
  return t * t * peak.h;
}

/**
 * Circular box blur -- the strip TILES, so the wrap has to be seamless or
 * the massing envelope below would put a discontinuity at the tile seam.
 * Iterated boxes approximate a gaussian at a fraction of the cost.
 */
export function blurWrap(src, radius, passes = 2) {
  const n = src.length;
  if (n === 0 || radius < 1) return Float32Array.from(src);
  let a = Float32Array.from(src);
  let b = new Float32Array(n);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += a[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      b[i] = acc / w;
      acc -= a[(((i - radius) % n) + n) % n];
      acc += a[(((i + radius + 1) % n) + n) % n];
    }
    const t = a; a = b; b = t;
  }
  return a;
}

/**
 * The range's own massing envelope: a heavily blurred copy of the summit
 * field. This is what makes the crest a RANGE rather than a shelf.
 *
 * The first attempt at this file drove the spine from independent
 * low-frequency noise, which produced a dead-flat table with summits
 * spiking out of it -- swapping one wrong read ("cones on a plain") for
 * another ("spikes on a table"). A real massif is the AGGREGATE of its
 * summits: the ground swells under a cluster of peaks and subsides between
 * clusters, so foothills descend out of the high country instead of the
 * high country sitting on a plinth. Deriving the envelope from the summits
 * themselves gets that for free, and it keeps the song's own composition
 * (which summits, where) in charge of the range's large-scale shape.
 *
 * `floorH` keeps the crest alive across gaps -- never the bare plain the
 * old field fell to -- without flattening the envelope's own relief.
 */
export function massingEnvelope(summitField, floorH, gain, radius) {
  const blurred = blurWrap(summitField, radius, 2);
  let peak = 0;
  for (const v of blurred) if (v > peak) peak = v;
  const out = new Float32Array(blurred.length);
  const norm = peak > 1e-6 ? 1 / peak : 0;
  for (let i = 0; i < blurred.length; i++) {
    out[i] = floorH + gain * clamp01(blurred[i] * norm);
  }
  return out;
}

/**
 * Crenellation: the rocky serration along a crest. Amplitude scales with
 * `relief` (how far this x already stands above the valley floor), which
 * is the whole point -- uniform noise across the tile was inventing local
 * maxima down on the flats that competed with the song's real summits (a
 * 3-5 peak massif was measuring 13 local maxima before this). Anchoring it
 * to relief means valleys stay calm and only genuine high ground gets
 * chewed.
 */
export function crenellation(noise, x, relief, amp, cellPx = 0) {
  if (!(relief > 0) || !(amp > 0)) return 0;
  // The serration's grain, in tile pixels. Given a `cellPx` (the song's
  // own subdivision converted to strip distance -- see pulseFor in
  // SilhouetteGenerator) the crest is chewed at the rate the music moves,
  // so a fast track's ridges are finely toothed and a slow one's are
  // coarsely broken. The bare constants are the original fixed grain,
  // which is ~48 px for the coarsest octave.
  const f1 = cellPx > 2 ? 1 / cellPx : 0.021;
  const o1 = noise.sample(x * f1 + 7.3);
  const o2 = noise.sample(x * f1 * 2.48 + 19.1);
  const o3 = noise.sample(x * f1 * 5.48 + 3.7);
  // A fourth, finer octave (max-pretty pass) adds rock teeth to the crest,
  // weighted LOW so the detail rides the existing skyline instead of
  // overtopping it -- the previous pass had already spent the available
  // headroom, so this leans on grain rather than lift (see the no-clipping
  // test that guards exactly this).
  const o4 = noise.sample(x * f1 * 9.7 + 27.9);
  const n = o1 * 0.50 + o2 * 0.28 + o3 * 0.16 + o4 * 0.06;
  return n * amp * relief;
}

// How much of a couloir's placement the beat grid owns. Not 1: a fully
// locked flank is a comb, and the noise term is what keeps the gullies
// looking eroded rather than machined.
export const PULSE_LOCK = 0.62;
// How narrow each incision is around its beat. Higher is a tighter V.
const PULSE_SHARPNESS = 2.6;

/**
 * A periodic incision, 1 exactly ON the beat and falling away sharply
 * between beats. `periodPx` is one beat (or bar) converted to tile
 * distance; the callers choose a period that divides the tile width
 * exactly, so the grid stays in phase across the wrap.
 */
export function pulseComb(x, periodPx, sharpness = PULSE_SHARPNESS) {
  if (!(periodPx > 2)) return 0;
  const onBeat = 0.5 + 0.5 * Math.cos((x / periodPx) * Math.PI * 2);
  return Math.pow(onBeat, sharpness);
}

/**
 * Couloirs: the near-vertical gullies that stripe a mountain's flanks.
 * These only ever CARVE (never add), only on real relief, and -- unlike
 * the old uniform ridged carve -- are strongest on the FLANKS and fade out
 * at both the summit apex and the valley floor, which is where real
 * couloirs actually live. `flankness` is supplied by the caller from the
 * local slope, so the gullies follow the mountain's own geometry instead
 * of being stamped on at a fixed rate everywhere.
 */
export function couloirCarve(noise, x, relief, flankness, amp, pulse = null) {
  if (!(relief > 0) || !(amp > 0) || !(flankness > 0)) return 0;
  const n = noise.sample(x * 0.038 + 11.9);
  // Ridged and rectified: sharp V incisions, never bumps.
  const v = 1 - Math.abs(n);
  let carve = v * v;
  if (pulse && pulse.periodPx > 2) {
    // Gullies on the beat. Couloir SPACING is the one piece of mountain
    // texture that is genuinely periodic in nature (cirques bite a headwall
    // at an interval set by the ice, not at random), so a metric grid is
    // not a costume here -- it is the more geological answer as well as the
    // musical one. Depth still comes from noise, because the point is that
    // the gullies fall on the pulse, not that every beat cuts one; a range
    // where all of them cut equally reads as corduroy.
    const depth = 0.42 + 0.58 * Math.abs(noise.sample(x / (pulse.periodPx * 2.1) + 4.1));
    carve = lerp(carve, pulseComb(x, pulse.periodPx) * depth, clamp01(pulse.lock ?? PULSE_LOCK));
  }
  return carve * amp * relief * clamp01(flankness);
}

/** Prevailing steep-side direction for a range, from its own seed. */
export function regionalDip(rand) {
  return rand() < 0.5 ? -1 : 1;
}

/**
 * Composes the shape parameters a character/lithology pair implies. Kept
 * here (rather than inline in the field loop) so the numbers that decide
 * how a range READS are in one place next to the functions that use them.
 */
export function shapeDials(cfg, litho) {
  const basement = litho?.basement ?? 0.35;
  const edge = litho?.edge ?? 0.25;
  const air = litho?.air ?? 0.15;
  return {
    // Bass builds high country -- an altiplano the summits stand on -- but
    // the envelope is a PLATFORM, not the mountain. Two calibration
    // mistakes in a row here, in opposite directions: a high floor with a
    // tiny swing read as a flat table with summits spiking out of it, and
    // then a big swing read as rolling hills, because the base climbed so
    // close to the summit ceiling that the tallest peak cleared its own
    // footing by barely a quarter of the strip. Relief -- summit height
    // ABOVE local base -- is the thing that makes a mountain read as a
    // mountain, so the envelope has to stay well down and leave it room.
    // Kept deliberately low. Every unit of envelope is opaque silhouette
    // across the WHOLE tile, and the strips are blitted per frame per layer:
    // profiling the running game put drawImage at ~63% of frame time, and an
    // earlier cut of these numbers raised mean strip coverage ~30% (L2
    // 0.29 -> 0.38), which alone pushed the frame budget over and made the
    // perf governor shed every optional pass within seconds. Deep passes
    // between the masses are both cheaper AND better looking than a high
    // continuous plinth -- the range still never dies to a flat plain,
    // which was the actual defect being fixed.
    spineFloor: clamp(0.04 + basement * 0.05 + (cfg.bed ?? 0.12) * 0.16, 0.03, 0.13),
    spineSwing: clamp(0.11 + basement * 0.09, 0.09, 0.22),
    // Presence/edge cuts gullies; air serrates the crest. The max-pretty
    // pass raises the crenel ceiling a notch (0.26 -> 0.34) so the sharpened
    // crests carry more rock serration where the song's air allows it.
    couloir: clamp((cfg.notch ?? 0.12) * (0.55 + 1.15 * edge), 0, 0.34),
    // Modest lift over the original -- the headroom was already spent by the
    // earlier pass (see the no-clip test), so this is grain, not lift.
    crenel: clamp((cfg.teeth ?? 0.08) * (0.50 + 1.30 * air) * 1.12, 0, 0.30),
    apronSpread: clamp(cfg.apronSpread ?? 2.4, 1.6, 3.4),
    apronCap: clamp(cfg.apronCap ?? 0.5, 0.3, 0.7),
  };
}

/** How much this x reads as a flank rather than an apex or a flat -- the
 *  gate couloirs ride. Derived from the local gradient, normalized so it
 *  peaks on steep ground and falls away at both summits and valley floors. */
export function flankness(slopePerPx) {
  const s = Math.abs(slopePerPx) * 220;
  return clamp01(s) * clamp01(2 - s);
}

export { lerp };
