import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClearanceField, clearanceAt, chooseStations, stationFlyability } from '../tools/lib/tour-stations.mjs';
import { syntheticCrestGrid, syntheticCrestPoints } from './fixtures/synthetic-crest-grid.mjs';

function terrain(heightAt = () => 1000, width = 201, cellSizeM = 60) {
  return { width, height: width, cellSizeM, originM: [-width * cellSizeM / 2, -width * cellSizeM / 2],
    heightsM: Float32Array.from({ length: width * width }, (_, i) => heightAt(i % width, Math.floor(i / width))),
    valid: new Uint8Array(width * width).fill(1) };
}

test('clearance includes 35 m trees, 10 m slack and 40 m margin with a 600 m band', () => {
  const grid = terrain(), forestMask = new Uint8Array(grid.heightsM.length).fill(1);
  const field = buildClearanceField(grid, { forestMask });
  const band = clearanceAt(field, 0, 0);
  assert.equal(band.floorY, 1085);
  assert.equal(band.ceilY, 1685);
  assert.ok(field.floor instanceof Uint16Array && field.ceil instanceof Uint16Array);
  assert.equal(field.cellM, 60);
  const bare = buildClearanceField(grid, { forestMask: new Uint8Array(forestMask.length) });
  assert.equal(clearanceAt(bare, 0, 0).floorY, 1050);
  assert.ok(Number.isNaN(clearanceAt(field, 1e8, 0).floorY));
});

test('clearance stays conservative between stored cells and across a narrow summit', () => {
  const grid = terrain((x, z) => x === 100 && z === 100 ? 2600 : 1000, 201, 20);
  const field = buildClearanceField(grid, { forestMask: new Uint8Array(grid.heightsM.length) });
  const x = grid.originM[0] + 100 * grid.cellSizeM, z = grid.originM[1] + 100 * grid.cellSizeM;
  for (let dx = -120; dx <= 120; dx += 10) for (let dz = -120; dz <= 120; dz += 10) {
    if (Math.hypot(dx, dz) > 120) continue;
    assert.ok(clearanceAt(field, x + dx, z + dz).floorY >= 2650);
  }
  assert.equal(clearanceAt(field, 0, 0).ceilY, 3250);
  const broken = { ...grid, valid: grid.valid.slice() }; broken.valid[0] = 0;
  assert.throws(() => buildClearanceField(broken), /coverage/);
});

test('flyability requires safe, roughly opposite 800 m flight directions', () => {
  const grid = terrain(), field = buildClearanceField(grid, { forestMask: new Uint8Array(grid.heightsM.length) });
  assert.ok(stationFlyability(field, [0, 0], 1100).count >= 2);
  assert.equal(stationFlyability(field, [0, 0], 1049).count, 0);
  // One open side at the edge is insufficient for a through pass.
  assert.equal(stationFlyability(field, [field.originM[0], field.originM[1]], 1100).count, 0);
});

test('drop and chorus passes are safe 300–600 m summit passes with two open directions', () => {
  const grid = terrain((x, z) => 1000 + Math.max(0, 1000 - 120 * Math.hypot(x - 100, z - 100)));
  const points = ['drop', 'chorus'].map((role, i) => ({ id: role, role, tier: 'primary', type: 'summit',
    localM: [grid.originM[0] + 100 * grid.cellSizeM, 2000, grid.originM[1] + 100 * grid.cellSizeM],
    grandeur: 1 - i * .1, reliefM: 1000, faceAspectDeg: 90 }));
  const saved = structuredClone(points);
  const result = chooseStations(grid, points, { forestMask: new Uint8Array(grid.heightsM.length),
    scoreEyeFn: (g, p, eye) => ({ score: 1 / (1 + Math.abs(eye[1] - 2000) / 100), headingDeg: 270, pitchDeg: 3, hfovDeg: 55, subjectId: p[0].id }), log: () => {} });
  assert.deepEqual(points, saved);
  for (const point of result.points) {
    const s = point.station, band = clearanceAt(result.clearance, ...s.posM);
    assert.ok(s.ringM >= 300 && s.ringM <= 600);
    assert.ok(s.yM >= band.floorY && s.yM <= band.ceilY);
    assert.ok(s.flyability >= 2);
    assert.ok(Number.isFinite(s.passHeadingDeg));
    assert.ok(Number.isFinite(s.bestAim.headingDeg));
  }
  assert.deepEqual(result, chooseStations(grid, points, { clearance: result.clearance,
    scoreEyeFn: (g, p, eye) => ({ score: 1 / (1 + Math.abs(eye[1] - 2000) / 100), headingDeg: 270, pitchDeg: 3, hfovDeg: 55, subjectId: p[0].id }), log: () => {} }));
});

test('real view scoring chooses a safe station and scenery never gets a station', () => {
  const grid = syntheticCrestGrid({ cellSizeM: 200 }), crest = syntheticCrestPoints(grid);
  const points = crest.map((p, i) => ({ ...p, role: 'chorus', tier: i === 1 ? 'primary' : 'scenery' }));
  const result = chooseStations(grid, points, { water: grid.water, forestMask: new Uint8Array(grid.heightsM.length), log: () => {} });
  const station = result.points[1].station;
  assert.ok(station.bestAim.score > 0);
  assert.ok(station.yM >= clearanceAt(result.clearance, ...station.posM).floorY);
  assert.equal(result.stations.length, 1);
  assert.ok(result.points.filter(p => p.tier === 'scenery').every(p => !p.station));
});

test('a station with no safe through pass rejects authoring instead of accepting a bad view', () => {
  const grid = terrain();
  const points = [{ id: 'unsafe', role: 'chorus', tier: 'primary', type: 'summit', localM: [0, 800, 0], grandeur: 1 }];
  assert.throws(() => chooseStations(grid, points, { log: () => {} }), /unsafe.*safe/i);
});

test('unavailable stations identify the rejected point and role for constrained re-assignment', () => {
  const grid = terrain();
  const points = [{ id: 'unsafe', role: 'chorus', tier: 'backup', type: 'summit', localM: [0, 800, 0], grandeur: 1 }];
  assert.throws(() => chooseStations(grid, points, { log: () => {} }), error =>
    error.code === 'TOUR_STATION_UNAVAILABLE' && error.pointId === 'unsafe' && error.role === 'chorus');
});

test('flyable role assignment replaces a rejected primary and preserves four safe primaries per role', async () => {
  const { assignFlyableStations }=await import('../tools/lib/tour-stations.mjs');
  const { TOUR_ROLES }=await import('../tools/lib/tour-roles.mjs');
  const points=TOUR_ROLES.flatMap((role,r)=>Array.from({length:6},(_,i)=>({
    id:role+'-'+i,role,tier:'scenery',type:['drop','chorus'].includes(role)?'summit':'col',
    localM:[r*3000,role==='interlude'&&i===0?600:1200,i*3000],
    elevationM:role==='interlude'&&i===0?600:1200,prominenceM:200,grandeur:.8,
    suit:Object.fromEntries(TOUR_ROLES.map(k=>[k,k===role?1-i*.01:0])),
  })));
  const grid=terrain(()=>1000,151,600);
  const clearance=buildClearanceField(grid,{cellM:600});
  const result=assignFlyableStations(grid,points,{clearance,scoreEyeFn:()=>({score:1,headingDeg:270,pitchDeg:0,hfovDeg:55}),log:()=>{}});
  assert.equal(result.roleStats.primaries,44);
  assert.ok(result.rejections.some(r=>r.pointId==='interlude-0'));
  assert.equal(result.points.find(p=>p.id==='interlude-0').tier,'scenery');
  for(const role of TOUR_ROLES)assert.equal(result.roles[role].primaries.length,4);
  for(const p of result.points.filter(p=>p.tier!=='scenery')){
    assert.ok(p.station.flyability>=2);
    assert.ok(p.station.yM>=clearanceAt(clearance,...p.station.posM).floorY);
  }
});
