// What a world is allowed to be, stated in one place.
//
// BiomeManager.draw() used to dispatch on `world.kind` through seven
// consecutive `if (kind === 'x') { drawXWorld(...); return; }` blocks, each
// handing the whole manager plus twelve or thirteen positional arguments to
// a module that then reached back into 19-36 of the manager's members. Two
// costs came out of that shape:
//
//   1. The argument lists drifted. Five worlds take `skyVoyage` and two do
//      not, so the same call spelled the same way meant different things
//      depending on which branch it sat in, and JavaScript drops a surplus
//      argument without a word. A `frame` object makes the mismatch a
//      property that is either there or not, rather than a position.
//   2. There was no answer to "what may a world touch?". The manager exposes
//      256 fields and 100 methods; the worlds use 40 of them. Nothing said
//      which 40, so every new world re-derived the answer by reading its
//      neighbours, and every new manager field looked equally fair game.
//
// WORLD_CONTRACT is that missing answer, and worldContract.test.js holds the
// line: a world module reaching for anything outside this list fails the
// build. The list is deliberately an allowlist and not a facade object --
// wrapping 40 members per frame would cost real time in the hot path to
// enforce statically what a test can enforce for free.
import { drawCityWorld } from './city/drawCity.js';
import { drawFarsideWorld } from './farside/drawFarside.js';
import { drawFathomWorld } from './fathom/drawFathom.js';
import { drawRedlineWorld, drawRoad } from './redline/drawRedline.js';
import { drawFoundryWorld, drawMachinery } from './foundry/drawFoundry.js';
import { drawUnderstoryWorld, drawCanopy } from './understory/drawUnderstory.js';
import { drawNaveWorld, drawVault } from './nave/drawNave.js';

// kind -> the function that draws it. The alpine kind is absent on
// purpose and worldContract.test.js asserts that fall-through:
//   'alpine'  -- the original path, still inline in BiomeManager.draw() below
//                the dispatch. Every module here began as a translation of
//                it, so it is the fall-through rather than an entry.
export const WORLD_RENDERERS = new Map([
  ['city', drawCityWorld],
  ['airless', drawFarsideWorld],
  ['abyssal', drawFathomWorld],
  ['strip', drawRedlineWorld],
  ['foundry', drawFoundryWorld],
  ['overgrowth', drawUnderstoryWorld],
  ['nave', drawNaveWorld],
]);

// Every BiomeManager member a world draw module may read or call. Grouped by
// what the world wants it FOR, because the useful question when adding a
// world is "how do I get the ground?", not "what is this field called?".
export const WORLD_CONTRACT = Object.freeze({
  // The shared passes. All seven worlds call all six of these -- they are
  // what makes a world a world rather than an unrelated canvas.
  passes: [
    '_drawSky', '_drawGround', '_drawFlood', '_drawRidgeVolume',
    '_drawTerrainFooting', '_drawTransitionOverlays', '_drawSignature',
  ],
  // Passes a world takes or leaves. Fathom and Nave skip drawDeepSky by
  // choice -- their own headers explain why open-sky stars would contradict
  // a water ceiling and a cathedral vault.
  optionalPasses: [
    'drawDeepSky', '_drawCelestial', '_drawMoon', '_drawHaze', '_drawFogBanks',
  ],
  // Terrain geometry: silhouette strips and the fields they stand on.
  terrain: ['stripsFor', 'fields', 'groundField', 'groundY', '_rotated'],
  // Where we are in the song.
  time: ['tSec', 'durationMs', 'currentBlend', 'openingGain', 'unravel'],
  // What the music and the sim are doing this frame.
  state: [
    'world', // response.smoothingMs also governs integrated travel
    'energyCurves', 'worldRhythm', 'sections', '_lastSectionIdx', 'fever',
    'orogenyGrowth', 'light', 'weatherState', 'weatherFields',
    '_activeWeatherIntensity', 'weaver', 'meteors',
    '_moonPhase01', '_celestialApproachAt',
  ],
  // Presentation budget: how fancy, how bright, how fast.
  budget: ['visualStyle', 'reducedFlash', 'reducedMotion', '_perf', 'lerpCache'],
});

// Flattened for membership checks.
export const WORLD_CONTRACT_MEMBERS = Object.freeze(
  new Set(Object.values(WORLD_CONTRACT).flat()),
);

// Defining structures live in their world modules and survive quality shedding.
export const WORLD_SIGNATURES = new Map([
  ['overgrowth', drawCanopy], ['nave', drawVault],
  ['strip', drawRoad], ['foundry', drawMachinery],
]);
