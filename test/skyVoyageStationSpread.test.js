// Midasus's voyages have to spread across the sky over a song, not pile up.
//
// _navTarget returns the centroid of the densest clump of her own atlas
// stars, and trigger() used to lerp EVERY station toward it at NAV_PULL
// (0.65). The input of that pull is its own output: a voyage dragged to the
// clump deposits three more figures there, so the next _navTarget finds the
// same clump denser and pulls harder. Nothing ever sent her to empty sky.
//
// The result on screen was a single dense knot of stars in one corner --
// whichever corner the FIRST voyage rolled -- and a bare sky everywhere
// else, in every world (drawDeepSky is called from _drawSky, which every
// world kind runs). It only showed up minutes into a song, which is why it
// survived a 32-second smoke fixture where the atlas is still empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkyVoyage, VoyagePhase } from '../src/sim/SkyVoyage.js';

const W = 1280, H = 720, FIG_R = 130;

/** One song's worth of voyages, driven through the real trigger() and the
 *  real atlas crystallization. Returns each voyage's station, as fractions
 *  of the stage. Figures are stamped as rings around the station because
 *  that is what _stampConstellation samples off the trail. */
function stations(seed, count = 12) {
  const v = new SkyVoyage(seed);
  const out = [];
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += 25000;
    v.phase = VoyagePhase.IDLE;
    v.trigger(now, { x: W / 2, y: H / 2 }, W, H);
    const st = v._station;
    out.push({ x: st.x / W, y: st.y / H });
    for (let f = 0; f < 3; f++) {
      const points = [];
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        points.push({ x: st.x + Math.cos(a) * FIG_R * 0.8, y: st.y + Math.sin(a) * FIG_R * 0.8 });
      }
      v.constellations.push({ points, hue: 200, bornMs: now });
    }
    now += 16000;
    v.pruneConstellations(now);
  }
  return out;
}

test('voyages spread across the sky instead of converging on one patch', () => {
  // Measured on the converging version: 0.17-0.27 for these same seeds.
  for (const seed of [1, 315, 4242]) {
    const xs = stations(seed).map((s) => s.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    assert.ok(spread > 0.5,
      `seed ${seed}: stations span only ${spread.toFixed(2)} of the stage width -- `
      + 'the nav pull has collapsed back into a single-patch attractor');
  }
});

test('no half of the sky is left unvisited over a song', () => {
  // The symptom as reported was "dense stars in one corner, nowhere else".
  // Converging runs put every station in one half and none in the other.
  for (const seed of [1, 315, 4242]) {
    const xs = stations(seed).map((s) => s.x);
    const left = xs.filter((x) => x < 0.5).length;
    assert.ok(left >= 2 && xs.length - left >= 2,
      `seed ${seed}: ${left}/${xs.length} stations on the left -- one side of the sky is going unwritten`);
  }
});

test('she still revisits her myths sometimes', () => {
  // The spread fix must not delete the authored behavior it is bounding:
  // some voyages should still land close to an earlier one.
  let revisits = 0;
  for (const seed of [1, 315, 4242, 77, 2024]) {
    const st = stations(seed);
    for (let i = 1; i < st.length; i++) {
      const near = st.slice(0, i).some((p) => Math.hypot(p.x - st[i].x, p.y - st[i].y) < 0.08);
      if (near) revisits++;
    }
  }
  assert.ok(revisits > 0, 'no voyage ever returned near an earlier one -- the myth revisit is gone');
});

test('stations stay inside the safe band at every stage size', () => {
  // The band exists so the biggest figure cannot run off frame or sink into
  // the mountains. Best-candidate placement must respect it like the lerp did.
  for (const seed of [1, 315]) {
    for (const s of stations(seed)) {
      assert.ok(s.x > 0.04 && s.x < 0.96, `station x ${s.x.toFixed(2)} escaped the frame margin`);
      assert.ok(s.y >= 0.12 && s.y <= 0.50, `station y ${s.y.toFixed(2)} escaped the safe vertical band`);
    }
  }
});
