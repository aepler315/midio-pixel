// The Dramaturgy Director: the difference between a stack of effects and
// a staged show. Four pure functions BiomeManager consumes --
//   castBiomes:        sections get biomes matched to their energy, the
//                      way a director casts scenes (calm -> ARCTIC/SAKURA,
//                      hot -> EMBER/SOLAR), never the same biome twice
//                      in a row
//   classifyTransition: boundary sharpness (novelty at the cut) picks the
//                      transition style -- gentle FADE, one-bar SHUTTER
//                      wipe, or a hard CUT with a flash on the beat
//   intensityBudget:   a global gain staging the show -- the intro holds
//                      the phenomena layer back so the finale has
//                      somewhere to go
//   dayArc:            one sun-arc across the whole song: dawn tint at
//                      the start, zenith mid-song, dusk into the finale.
import { clamp01, smoothstep, mulberry32 } from '../utils/math.js';

// Where each biome sits on the cold-to-hot axis.
export const BIOME_TEMPERATURE = {
  ARCTIC: 0.04, MIRROR: 0.10, CORAL: 0.16, SAKURA: 0.22, TWILIGHT: 0.28,
  ABYSS: 0.36, LUMEN: 0.42, VOID: 0.48, GEODE: 0.51, NEBULA: 0.54, JADE: 0.60,
  AURUM: 0.66, CYBER: 0.80, STORM: 0.86, EMBER: 0.92, SOLAR: 0.98,
};

/**
 * Assign biomes to sections by matching biome temperature to the
 * section's energy percentile rank. Seeded jitter keeps different songs
 * from casting identically; immediate repeats are forbidden.
 */
export function castBiomes(sectionEnergies, seed = 1, temperature = BIOME_TEMPERATURE) {
  const n = sectionEnergies.length;
  if (n === 0) return [];
  const rand = mulberry32(seed >>> 0 || 1);
  const names = Object.keys(temperature);
  if (names.length === 0) return [];

  // Percentile rank of each section's energy (ties broken by index).
  const order = sectionEnergies.map((e, i) => [e, i]).sort((a, b) => a[0] - b[0]);
  const rank = new Array(n);
  order.forEach(([, idx], pos) => { rank[idx] = n === 1 ? 0.5 : pos / (n - 1); });

  const out = [];
  for (let i = 0; i < n; i++) {
    let best = null, bestScore = Infinity;
    for (const name of names) {
      if (out[i - 1] === name) continue; // no immediate repeats
      const score = Math.abs(temperature[name] - rank[i]) + rand() * 0.15;
      if (score < bestScore) { bestScore = score; best = name; }
    }
    out.push(best);
  }
  return out;
}

/**
 * Boundary sharpness -> transition style.
 *
 * The ladder used to run cut / shutter / fade from the top down, which put
 * the ladder's two ends the wrong way round: `cut` is a brief 0.35-alpha
 * flash, while `shutter` closes the screen to near-black for a whole bar --
 * so the *mildest* visual was reserved for the sharpest musical boundary and
 * the most violent one for merely-moderate boundaries. The screen bit down
 * hardest exactly where the music was least emphatic.
 *
 * Now the effect tracks the boundary: only the sharpest turns earn the
 * shutter, the middle band gets the flash, and everything softer fades.
 */
export function classifyTransition(novelty, maxNovelty) {
  if (!(maxNovelty > 1e-9)) return 'fade';
  const s = novelty / maxNovelty;
  return s > SHUTTER_SHARPNESS ? 'shutter' : s > CUT_SHARPNESS ? 'cut' : 'fade';
}

// Raised from the old 0.66 shutter cutoff: the shutter is now both the
// rarest style and the strongest effect, so it has to be genuinely earned.
const SHUTTER_SHARPNESS = 0.78;
const CUT_SHARPNESS = 0.33;

/**
 * Global phenomena gain across the song: restrained intro ramping over
 * the first ~22% of the song, then full. Always within [0.55, 1].
 *
 * Note this is a function of ELAPSED TIME only -- it stages the show, but it
 * cannot hear the song. A track that fades in for forty seconds reaches full
 * strength long before the music does, which is what OpeningDirector exists
 * to correct; the two multiply together in BiomeManager.
 */
export function intensityBudget(progress) {
  const p = clamp01(progress);
  // The intro floor. Previously documented as 0.35 while actually being 0.55.
  //
  // There was also a "final push past 85%" term here (`* (1 + 0.12 *
  // smoothstep(0.85, 1, p))`) which could never do anything: `ramp` is
  // already 1.0 from p=0.22 onward, so the outer Math.min(1, ...) clipped the
  // push away every time. Removed rather than left as decoration -- a
  // late-song lift belongs to hypeBoost, which is live and audible.
  return 0.55 + 0.45 * smoothstep(0, 0.22, p);
}

/**
 * The song-long sun arc. Returns the celestial's vertical position
 * (fraction of canvas height) plus dawn/dusk tint overlays.
 */
export function dayArc(progress) {
  const p = clamp01(progress);
  // Distance from either edge of the song: 0 at dawn/dusk, 0.5 at zenith.
  const edgeDist = Math.min(p, 1 - p);
  return {
    celestialYFrac: 0.28 - 0.13 * Math.sin(Math.PI * p), // low at dawn/dusk, high at zenith
    dawn: { color: '#ff9a6b', alpha: 0.14 * (1 - smoothstep(0, 0.18, p)) },
    dusk: { color: '#141040', alpha: 0.20 * smoothstep(0.78, 1, p) },
    // Aerial-perspective haze warms at both ends of the day arc (a low sun
    // means a longer light path through the atmosphere) and cools toward
    // zenith; plateaus at 0 for the middle third of the song rather than
    // dipping only at a single instant.
    hazeWarm: 1 - smoothstep(0, 0.35, edgeDist),
  };
}
