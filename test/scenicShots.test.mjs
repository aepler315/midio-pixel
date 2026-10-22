import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateShots, liftToClearance, lineOfSight, railShot, headingOf, subjectMarks, tiltForGridEdge, keepHorizon } from '../tools/lib/scenic-shots.mjs';
import { buildLink, linkVariants, keepParetoLinks, minTurnRadius, dubins, sampleCourse } from '../tools/lib/scenic-links.mjs';
import { samplePath, pathPoseAt, pathTangent } from '../src/world/terrain/ShotPath.js';

// A synthetic landscape: a 1000 m basin floor, a 900 m cone at the origin,
// an east-west ridge 4 km south of it that hides the cone from low eyes,
// and a rim of hills toward the edges.
function landscape() {
  const heightAt = (x, z) => {
    const cone = 900 * Math.max(0, 1 - Math.hypot(x, z) / 1500);
    const ridge = 260 * Math.max(0, 1 - Math.abs(z - 4000) / 300) * (Math.abs(x) < 6000 ? 1 : 0);
    // A rim of hills toward the grid's edges, as real regions have: the
    // horizon is terrain, not the grid's crop edge.
    const r = Math.max(Math.abs(x), Math.abs(z)), rim = 900 * Math.min(1, Math.max(0, (r - 12000) / 5000)) ** 2;
    return 1000 + cone + ridge + rim;
  };
  const grid = { originM: [-20000, -20000], width: 2001, height: 2001, cellSizeM: 20 };
  return {
    grid, heightAt,
    clearance: { floorAt: (x, z) => {
      let h = -Infinity;
      for (const [dx, dz] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]]) h = Math.max(h, heightAt(x + dx, z + dz));
      return h + 70;
    } },
    camera: { eyeStartM: [-1000, 1500, 9000], eyeEndM: [1000, 1500, 9000], targetStartM: [0, 1500, 0], targetEndM: [0, 1500, 0], fovYDeg: 26 },
    lenses: { wide: 36, normal: 26, tele: 16 }, standoffM: 300, boundaryMarginM: 1500,
  };
}
const peak = { id: 'peak-cone', kind: 'peak', name: 'Cone', posM: [0, 1900, 0], radiusM: 1500, heightM: 900 };
const railTarget = { id: 'rail-target', kind: 'rail-target', name: null, posM: [0, 1500, 0], radiusM: 300, heightM: 300 };

test('every generated shot clears the floor along its whole path and stays in the grid', () => {
  const ctx = landscape();
  const shots = generateShots(ctx, [railTarget, peak], { valleys: [], shores: [] }, { landform: 'volcano' }, { azimuths: 6 });
  assert.ok(shots.some((s) => s.move === 'rail'), 'the authored rail is always a shot');
  const moves = new Set(shots.map((s) => s.move));
  for (const m of ['orbit', 'traverse', 'approach', 'pullback']) assert.ok(moves.has(m), `has ${m}`);
  for (const s of shots) {
    if (s.move === 'rail') continue;
    for (let i = 0; i < s.path.s.length; i++) {
      const x = s.path.eye[i * 3], y = s.path.eye[i * 3 + 1], z = s.path.eye[i * 3 + 2];
      assert.ok(y >= ctx.clearance.floorAt(x, z) - 0.5, `${s.id} sample ${i} below the floor`);
      assert.ok(Math.abs(x) < 18500 && Math.abs(z) < 18500, `${s.id} leaves the grid margin`);
    }
    assert.ok(s.payoffFrac > 0 && s.payoffFrac <= 1);
  }
  assert.equal(new Set(shots.map((s) => s.id)).size, shots.length, 'ids are unique');
});

test('a reveal starts with its subject hidden behind a real crest and ends with it visible', () => {
  const ctx = landscape();
  const shots = generateShots(ctx, [railTarget, peak], { valleys: [], shores: [] }, { landform: 'alpine', preferAzimuthDeg: [180] }, { azimuths: 4 });
  const reveals = shots.filter((s) => s.move === 'reveal' && !s.tags.includes('crane') && s.subjectId === peak.id);
  assert.ok(reveals.length > 0, 'the ridge south of the cone yields a reveal');
  for (const r of reveals) {
    const first = pathPoseAt(r.path, 0).eyeM, last = pathPoseAt(r.path, r.lengthM).eyeM;
    assert.equal(lineOfSight(ctx.heightAt, first, subjectMarks(ctx, peak, first).summit), false, 'hidden at the start');
    const end = subjectMarks(ctx, peak, last);
    assert.equal(lineOfSight(ctx.heightAt, last, end.summit) && lineOfSight(ctx.heightAt, last, end.flank), true, 'visible at the end');
  }
});

test('lifting to clearance is smooth and refuses an excessive lift', () => {
  const p = samplePath({ eyes: [[0, 100, 0], [1000, 100, 0], [2000, 100, 0]], aims: [[0, 100, -5000], [1000, 100, -5000], [2000, 100, -5000]], fovs: 30 });
  const floor = (x) => (Math.abs(x - 1000) < 100 ? 300 : 50);
  const lifted = liftToClearance(p, floor);
  for (let i = 0; i < lifted.s.length; i++) assert.ok(lifted.eye[i * 3 + 1] >= floor(lifted.eye[i * 3]) - 1e-6);
  let maxStep = 0;
  for (let i = 1; i < lifted.s.length; i++) maxStep = Math.max(maxStep, Math.abs(lifted.eye[i * 3 + 1] - lifted.eye[(i - 1) * 3 + 1]));
  assert.ok(maxStep < 40, `raised-cosine lift has no cliff (max step ${maxStep.toFixed(1)} m)`);
  assert.equal(liftToClearance(p, () => 5000), null);
});

test('a link joins one shot exit to the next entry exactly, with matching tangents', () => {
  const ctx = landscape();
  const a = { id: 'a', path: samplePath({ eyes: [[-6000, 1800, 6000], [-4500, 1800, 6500], [-3000, 1800, 7000]], aims: [[0, 1500, 0], [0, 1500, 0], [0, 1500, 0]], fovs: 30 }) };
  const b = { id: 'b', path: samplePath({ eyes: [[2000, 1900, 7000], [3500, 1900, 6500], [5000, 1900, 6000]], aims: [[0, 1600, 0], [0, 1600, 0], [0, 1600, 0]], fovs: 22 }) };
  const variants = linkVariants(ctx, a, b);
  assert.ok(variants.length >= 2, 'several variants survive');
  for (const v of variants) {
    const n = v.path.s.length, an = a.path.s.length;
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(v.path.eye[k] - a.path.eye[(an - 1) * 3 + k]) < 0.05, 'starts at the exit');
      assert.ok(Math.abs(v.path.eye[(n - 1) * 3 + k] - b.path.eye[k]) < 0.05, 'ends at the entry');
      assert.ok(Math.abs(v.path.aim[k] - a.path.aim[(an - 1) * 3 + k]) < 0.5, 'keeps the outgoing target');
    }
    assert.ok(Math.abs(v.path.fov[0] - 30) < 1e-3 && Math.abs(v.path.fov[n - 1] - 22) < 1e-3, 'fov joins');
    const ta = pathTangent(a.path, true), tl = pathTangent(v.path, false);
    assert.ok(ta[0] * tl[0] + ta[1] * tl[1] + ta[2] * tl[2] > 0.97, `${v.kind}: leaves along the exit tangent`);
    const tb = pathTangent(b.path, false), te = pathTangent(v.path, true);
    assert.ok(tb[0] * te[0] + tb[1] * te[1] + tb[2] * te[2] > 0.97, `${v.kind}: arrives along the entry tangent`);
    assert.ok(minTurnRadius(v.path) >= 250);
  }
  assert.equal(buildLink(ctx, a, b, 'direct', { linkMaxM: 1000 }), null, 'too far');
});

test('Pareto retention keeps a shorter transit and a more scenic one', () => {
  const v = [{ kind: 'direct', lengthM: 1000, score: { total: 0.4 } }, { kind: 'arc', side: 1, lengthM: 1300, score: { total: 0.7 } },
    { kind: 'arc', side: -1, lengthM: 1400, score: { total: 0.5 } }, { kind: 'high', lengthM: 1200, score: { total: 0.3 } }];
  const kept = keepParetoLinks(v, 2);
  assert.deepEqual(kept.map((k) => `${k.kind}${k.side || ''}`), ['direct', 'arc1']);
});

test('the rail shot reproduces the authored rail and headings use north-up degrees', () => {
  const ctx = landscape();
  const r = railShot(ctx, railTarget);
  const mid = pathPoseAt(r.path, r.lengthM / 2);
  assert.ok(Math.abs(mid.eyeM[0]) < 1 && Math.abs(mid.eyeM[2] - 9000) < 1);
  assert.equal(r.rail, true);
  assert.equal(Math.round(headingOf(0, -1)), 0);
  assert.equal(Math.round(headingOf(1, 0)), 90);
});

test('a foreground pass frames a nearer feature against the subject, and a crane rises to a high payoff', () => {
  const ctx = landscape();
  const near = { id: 'butte-near', kind: 'butte', name: null, posM: [0, 1400, 2600], radiusM: 250, heightM: 300 };
  const h = ctx.heightAt;
  ctx.heightAt = (x, z) => h(x, z) + 300 * Math.max(0, 1 - Math.hypot(x, z - 2600) / 250);
  const shots = generateShots(ctx, [railTarget, peak, near], { valleys: [], shores: [] }, { landform: 'butte' }, { azimuths: 4, maxPerSubject: 200 });
  const passes = shots.filter((s) => s.tags.includes('foreground-pass') && s.subjectId === peak.id);
  assert.ok(passes.length > 0, 'the near butte frames the cone');
  for (const p of passes) {
    assert.equal(p.traits.foregroundSubjectId, near.id);
    for (const at of [0, p.lengthM]) assert.ok(lineOfSight(ctx.heightAt, pathPoseAt(p.path, at).eyeM, [0, 1906, 0]), 'the summit shows over the near feature');
  }
  const cranes = shots.filter((s) => s.tags.includes('crane'));
  assert.ok(cranes.length > 0);
  for (const c of cranes) assert.ok(pathPoseAt(c.path, c.lengthM).eyeM[1] - pathPoseAt(c.path, 0).eyeM[1] > 300, 'rises');
  assert.ok(!shots.some((s) => s.subjectId === railTarget.id && s.move !== 'rail'), 'the rail target seeds the rail only');
});

test('a Dubins course reaches the next shot in its own heading, never turning tighter than its radius', () => {
  for (const [start, end] of [[[0, 0, 0], [3000, 0, 0]], [[0, 0, 0], [-1500, 200, Math.PI]], [[0, 0, Math.PI / 2], [800, -900, -Math.PI / 2]]]) {
    const course = dubins(start, end, 400);
    const pts = sampleCourse(course, 20), last = pts.at(-1);
    assert.ok(Math.hypot(last[0] - end[0], last[1] - end[1]) < 0.01, 'ends where the next shot begins');
    assert.ok(Math.abs(Math.atan2(Math.sin(last[2] - end[2]), Math.cos(last[2] - end[2]))) < 1e-3, 'in its heading');
    assert.ok(course.length >= Math.hypot(end[0] - start[0], end[1] - start[1]) - 1e-6);
    const path = { s: Float32Array.from(pts, (p) => p[3]), eye: Float32Array.from(pts.flatMap((p) => [p[0], 0, p[1]])) };
    assert.ok(minTurnRadius(path, 1) > 399, 'no turn tighter than the radius');
  }
  const turn = [[0, 0, 0], [3000, 900, Math.PI / 2]];
  assert.ok(dubins(...turn, 400, { rank: 1 }).length > dubins(...turn, 400).length, 'the second course is a different, longer one');
  assert.equal(dubins([0, 0, 0], [3000, 0, 0], 400, { rank: 1 }), null, 'a straight run has no second course');
});

test('the grid-edge tilt leaves a view level while its rays leave the grid within the allowed dip', () => {
  // Flat open country +-20 km at 1000 m, the eye 500 m above it at the centre,
  // looking level north with a 26 deg lens: rays just below the horizontal
  // leave the grid; a ray 3 deg down meets the ground 9.5 km out, 1 deg down 28.6 km out.
  const flat = { grid: { originM: [-20000, -20000], width: 2001, height: 2001, cellSizeM: 20 }, heightAt: () => 1000 };
  const eye = [0, 1500, 0], aim = [0, 1500, -5000];
  const pitchOf = (a) => Math.atan2(a[1] - eye[1], Math.hypot(a[0] - eye[0], a[2] - eye[2])) * 180 / Math.PI;
  const strict = tiltForGridEdge(flat, [eye], [aim], 26)[0];
  assert.ok(pitchOf(strict) < -14, `no allowance: tilted until the frame top meets the grid (${pitchOf(strict).toFixed(1)} deg)`);
  assert.deepEqual(tiltForGridEdge({ ...flat, edgeDipDeg: 3 }, [eye], [aim], 26)[0], aim, 'a 3 deg allowance keeps the level view');
  assert.ok(pitchOf(tiltForGridEdge({ ...flat, edgeDipDeg: 1 }, [eye], [aim], 26)[0]) < -14, 'a 1 deg band is too thin for this eye');
});

test('keepHorizon raises a steep look until the horizon is in frame, as far as its subject stays in frame', () => {
  const t = Math.tan(18 * Math.PI / 180); // 36 deg lens
  const rowOf = (eye, aim, elDeg) => {
    const p = Math.atan2(aim[1] - eye[1], Math.hypot(aim[0] - eye[0], aim[2] - eye[2]));
    return 0.5 - 0.5 * Math.tan(elDeg * Math.PI / 180 - p) / t;
  };
  const eye = [0, 2000, 0];
  // 15 deg down: raised until the horizon sits 20% below the top edge.
  const a15 = [0, 2000 - 1000 * Math.tan(15 * Math.PI / 180), -1000], [k15] = keepHorizon([eye], [a15], 36);
  assert.ok(Math.abs(rowOf(eye, k15, 0) - 0.2) < 1e-9, 'horizon on the 20% row');
  assert.ok(Math.abs(Math.hypot(...k15.map((v, i) => v - eye[i])) - Math.hypot(...a15.map((v, i) => v - eye[i]))) < 1e-6, 'aim distance kept');
  assert.ok(Math.abs(k15[0]) < 1e-9 && k15[2] < 0, 'heading kept');
  // 30 deg down: the subject (the original aim point) limits the raise to 10% above the bottom.
  const a30 = [0, 2000 - 1000 * Math.tan(30 * Math.PI / 180), -1000], [k30] = keepHorizon([eye], [a30], 36);
  const el30 = -30;
  assert.ok(Math.abs(rowOf(eye, k30, el30) - 0.9) < 1e-9, 'subject on the 90% row');
  assert.ok(rowOf(eye, k30, 0) < 0.2, 'horizon still above the frame top: partial raise');
  // A view already level enough is returned as is.
  const level = [0, 1900, -1000];
  assert.equal(keepHorizon([eye], [level], 36)[0], level);
});
