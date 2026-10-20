// Near-field foreground occluders (NearField.js): huge biome-landmark
// silhouettes sweeping past faster than the characters. Mirrors
// FarVignettes.js's seeded-sector architecture, so the tests mirror
// farVignettes.test.js's shape -- plus the readability guarantee (no two
// occupied sectors back to back) and a full-biome smoke test against every
// LANDMARKS painter, since this is the first place those painters are ever
// invoked outside a baked, fire-and-forget strip generation pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearFieldForSector, NearField, PROP_CHANCE, SECTOR_PX, NEARFIELD_RATIO, OUTLINE_COLOR,
} from '../src/world/NearField.js';
import { LANDMARKS } from '../src/world/Landmarks.js';
import { BIOMES } from '../src/world/BiomeProfiles.js';

const BIOME = 'JADE';

test('nearFieldForSector is deterministic, and sector 0 always stays clear', () => {
  assert.equal(nearFieldForSector(5, 0, BIOME), null, 'opening screenful stays clear');
  assert.equal(nearFieldForSector(5, -1, BIOME), null);
  for (let i = 1; i < 40; i++) {
    const a = nearFieldForSector(9001, i, BIOME);
    const b = nearFieldForSector(9001, i, BIOME);
    assert.deepEqual(a, b, `sector ${i} must be stable`);
  }
});

test('an unknown biome name is refused rather than throwing', () => {
  assert.equal(nearFieldForSector(1, 5, 'NOT_A_REAL_BIOME'), null);
});

test('two occupied sectors are never adjacent, regardless of how the dice land', () => {
  // Passing prevOccupied=true must force a clear sector, no matter what the
  // roll would otherwise have been -- this is the actual readability floor,
  // not just a statistical tendency.
  for (let i = 1; i < 200; i++) {
    assert.equal(nearFieldForSector(777, i, BIOME, true), null, `sector ${i} should be forced clear`);
  }
});

test('density (when not forced clear) tracks the configured chance', () => {
  let hits = 0;
  const N = 2000;
  for (let i = 1; i <= N; i++) {
    if (nearFieldForSector(42, i, BIOME, false)) hits++;
  }
  const density = hits / N;
  assert.ok(Math.abs(density - PROP_CHANCE) < 0.06, `density ${density} should sit near ${PROP_CHANCE}`);
});

test('descriptor fields stay within their documented ranges', () => {
  for (let i = 1; i <= 500; i++) {
    const d = nearFieldForSector(123, i, BIOME);
    if (!d) continue;
    assert.ok(d.offset01 >= 0.1 && d.offset01 <= 0.9);
    assert.equal(typeof d.flip, 'boolean');
    assert.equal(typeof d.hang, 'boolean');
    assert.ok(Number.isInteger(d.painterIdx) && d.painterIdx >= 0);
    assert.ok(d.scale > 0);
    assert.equal(d.biomeName, BIOME);
  }
});

test('different songs place different silhouettes in different places', () => {
  let differs = 0;
  for (let i = 1; i <= 60; i++) {
    const a = nearFieldForSector(1, i, BIOME);
    const b = nearFieldForSector(2, i, BIOME);
    if (JSON.stringify(a) !== JSON.stringify(b)) differs++;
  }
  assert.ok(differs > 10, 'two songs must not share a placement map');
});

// --- The class: sector caching, biome captured at first sight -------------

test('a sector\'s biome is captured the first time it is queried and never changes after', () => {
  const nf = new NearField(555);
  const canvas = { width: 1280, height: 720 };
  const env1 = { tSec: 0, kick: 0, biomeName: 'EMBER' };
  // worldX=3000 puts sector 4 (a known occupied sector for this seed/biome
  // combination) inside the visible window -- worldX=0 only reaches sectors
  // -1..2, and none of those happen to roll occupied for this seed.
  nf.draw({ save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, ellipse() {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {} }, canvas, 3000, env1);

  // Find a sector that actually got a prop.
  let occupiedIdx = null;
  for (const [idx, d] of nf._cache) if (d) { occupiedIdx = idx; break; }
  assert.ok(occupiedIdx !== null, 'expected at least one occupied sector in the opening view');
  assert.equal(nf._cache.get(occupiedIdx).biomeName, 'EMBER');

  // Redraw far downstream with a DIFFERENT current biome -- the cached
  // sector must not be retroactively reskinned.
  const env2 = { tSec: 10, kick: 0, biomeName: 'ARCTIC' };
  nf.draw({ save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, ellipse() {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {} }, canvas, 6000, env2);
  assert.equal(nf._cache.get(occupiedIdx).biomeName, 'EMBER', 'already-placed sectors keep their original biome');
});

// --- Draw pass: bounded to what's actually on screen -----------------------

function recordingCtx() {
  const calls = { translate: [], painterInvocations: 0 };
  return {
    calls,
    save() {}, restore() {}, scale() {}, rotate() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, ellipse() {},
    translate(x, y) { calls.translate.push([x, y]); },
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {},
    set globalAlpha(v) {},
  };
}

test('draw() only touches sectors within the visible scrolled window', () => {
  const nf = new NearField(9);
  const canvas = { width: 1280, height: 720 };
  const ctx = recordingCtx();
  const worldX = 50000; // deep into the song
  nf.draw(ctx, canvas, worldX, { tSec: 100, kick: 0, biomeName: BIOME });

  const scroll = worldX * NEARFIELD_RATIO;
  const first = Math.floor((scroll - 400) / SECTOR_PX);
  const last = Math.floor((scroll + canvas.width + 400) / SECTOR_PX);
  const touched = [...nf._cache.keys()];
  for (const idx of touched) {
    assert.ok(idx >= first && idx <= last, `sector ${idx} is outside the visible window [${first},${last}]`);
  }
});

test('the ratio override (Coda delamination) changes which sectors are visible', () => {
  const nf = new NearField(9);
  const canvas = { width: 1280, height: 720 };
  const worldX = 50000;
  nf.draw(recordingCtx(), canvas, worldX, { tSec: 0, kick: 0, biomeName: BIOME, ratio: NEARFIELD_RATIO * 1.5 });
  const scroll = worldX * NEARFIELD_RATIO * 1.5;
  const expectedFirst = Math.floor((scroll - 400) / SECTOR_PX);
  assert.ok(nf._cache.has(expectedFirst) || nf._cache.has(expectedFirst + 1), 'ratio override must actually change the scroll math');
});

// --- Every painter must survive being invoked at foreground scale ---------

test('every biome\'s landmark painters draw at near-field scale without throwing', () => {
  const nf = new NearField(1);
  const canvas = { width: 1280, height: 720 };
  for (const b of BIOMES) {
    const painters = LANDMARKS[b.name];
    for (let pIdx = 0; pIdx < painters.length; pIdx++) {
      for (const hang of [false, true]) {
        const ctx = recordingCtx();
        assert.doesNotThrow(() => {
          nf._drawOne(ctx, canvas, {
            biomeName: b.name, hang, painterIdx: pIdx, flip: false, scale: 5, seed: 777,
          }, 640, { tSec: 3, kick: 0.6, biomeName: b.name });
        }, `${b.name} painter ${pIdx} (hang=${hang}) threw`);
      }
    }
  }
});

function styleRecordingCtx() {
  const styles = [];
  return {
    styles,
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, fillRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
    fill() {}, stroke() {}, arc() {}, ellipse() {},
    set fillStyle(v) { styles.push(v); }, set strokeStyle(v) { styles.push(v); },
    set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalAlpha(v) {},
  };
}

test('every biome\'s landmark painters draw a near-black outline UNDER the real color, same vocabulary MeshDrawer gives the characters', () => {
  const nf = new NearField(1);
  const canvas = { width: 1280, height: 720 };
  for (const b of BIOMES) {
    const painters = LANDMARKS[b.name];
    for (let pIdx = 0; pIdx < painters.length; pIdx++) {
      const ctx = styleRecordingCtx();
      nf._drawOne(ctx, canvas, {
        biomeName: b.name, hang: false, painterIdx: pIdx, flip: false, scale: 5, seed: 777,
      }, 640, { tSec: 3, kick: 0, biomeName: b.name });
      const realColor = nf._colorFor(b.name);
      const firstOutlineAt = ctx.styles.indexOf(OUTLINE_COLOR);
      const firstRealAt = ctx.styles.indexOf(realColor);
      assert.ok(firstOutlineAt !== -1, `${b.name} painter ${pIdx}: outline color never used`);
      assert.ok(firstRealAt !== -1, `${b.name} painter ${pIdx}: real color never used`);
      assert.ok(firstOutlineAt < firstRealAt, `${b.name} painter ${pIdx}: outline must draw UNDER (before) the real color`);
    }
  }
});

test('color darkening is cached per biome and produces a valid, distinct hex', () => {
  const nf = new NearField(1);
  const a = nf._colorFor('JADE');
  const b = nf._colorFor('JADE');
  assert.equal(a, b, 'must be cached, not recomputed');
  assert.match(a, /^#[0-9a-f]{6}$/i);
  const c = nf._colorFor('SOLAR');
  assert.notEqual(a, c, 'different biomes must not collapse to the same near-field tint');
});

test('every biome has a real silhouette color to darken (no crash on an unknown name)', () => {
  const nf = new NearField(1);
  for (const b of BIOMES) {
    assert.doesNotThrow(() => nf._colorFor(b.name));
  }
});

test('world foreground geometry is independent of a generated landmark key', () => {
  for (const kind of ['alpine', 'airless', 'abyssal', 'overgrowth']) {
    const a = new NearField(555, { id: 'custom', kind });
    const b = new NearField(555, { id: 'custom', kind });
    const shapesA = [], shapesB = [];
    for (let i = 1; i < 100; i++) {
      const da = a._sector(i, 'DUNE');
      const db = b._sector(i, 'GEODE');
      if (da) shapesA.push({ kind: da.kind, hang: da.hang, scale: da.scale, painterIdx: da.painterIdx });
      if (db) shapesB.push({ kind: db.kind, hang: db.hang, scale: db.scale, painterIdx: db.painterIdx });
    }
    assert.ok(shapesA.length > 0);
    assert.ok(shapesA.every(d => d.kind === kind), `${kind} descriptors retain physical identity`);
    assert.deepEqual(shapesA, shapesB);
    if (!['overgrowth', 'nave', 'foundry'].includes(kind)) assert.ok(shapesA.every(d => !d.hang));
  }
});

test('foreground occupancy is independent of seek and query order', () => {
  const forward = new NearField(1), backward = new NearField(1);
  for (let i = 1; i <= 100; i++) forward._sector(i, BIOME);
  for (let i = 100; i >= 1; i--) backward._sector(i, BIOME);
  for (let i = 1; i <= 100; i++) {
    assert.deepEqual(backward._sector(i, BIOME), forward._sector(i, BIOME));
    assert.deepEqual(new NearField(1)._sector(i, BIOME), forward._sector(i, BIOME));
    assert.ok(!(forward._sector(i, BIOME) && forward._sector(i + 1, BIOME)));
  }
});

test('world props stay within bounded coverage and stop swaying under reduced motion', () => {
  for (const kind of ['alpine', 'airless', 'abyssal', 'overgrowth']) {
    const nf = new NearField(315, { kind });
    let d;
    for (let i = 1; !d && i < 100; i++) d = nf._sector(i, BIOME);
    const transforms = [];
    const ctx = { ...recordingCtx(), rect() {}, scale: (x, y) => transforms.push([x, y]) };
    nf._drawOne(ctx, { width: 1280, height: 720 }, d, 640, { tSec: 1, reducedMotion: true, biomeName: BIOME });
    const [sx, sy] = transforms[0];
    assert.ok(Math.abs(sx) * 100 <= 1280 * 0.09);
    assert.ok(Math.abs(sy) * 100 <= 720 * nf.identity.foreground.maxHeight);
    assert.equal(ctx.calls.translate[0][0], 640);
  }
});


test('artificial foreground props remain absent for every queried sector', () => {
  for (const kind of ['city', 'strip', 'foundry', 'nave']) {
    const near = new NearField(315, { kind });
    for (let i = 0; i < 100; i++) assert.equal(near._sector(i, 'JADE'), null);
  }
});

// A2: the call boundary. BiomeManager hands NearField `reducedMotion ||
// reducedFlash`: the motion preference for itself, flash for the damping
// it always had.
import { BiomeManager } from '../src/world/BiomeManager.js';

test('non-Landscape foreground landmarks retain their preference damping', () => {
  const seen = [];
  for (const [reducedMotion, reducedFlash] of [[false, false], [true, false], [false, true], [true, true]]) {
    const m = new BiomeManager({
      conductor: { barGrid: [], onBar: () => () => {}, on: () => () => {} },
      durationMs: 60000, canvasWidth: 1280, canvasHeight: 720, groundY: 625, songSeed: 3, worldId: 'farside',
    });
    m.currentBlend = { from: 'TAIGA', to: 'TAIGA', t: 1 };
    m.reducedMotion = reducedMotion;
    m.reducedFlash = reducedFlash;
    m.nearField.draw = (_c, _cv, _x, env) => seen.push(env.reducedMotion);
    const noop = () => {};
    const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop), set: (t, k, v) => { t[k] = v; return true; } });
    m.drawForeground(ctx, { width: 1280, height: 720 }, 0, true);
    m.dispose();
  }
  assert.deepEqual(seen, [false, true, true, true]);
});
