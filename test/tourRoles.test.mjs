import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_ROLES, roleSuitabilities, assignRoles } from '../tools/lib/tour-roles.mjs';

function rolePool() {
  const chorus = ['Mount Owen', 'Middle Teton', 'Mount Moran', 'Teewinot', 'Mount Saint John', 'Buck Mountain'];
  return TOUR_ROLES.flatMap((role, r) => Array.from({ length: 20 }, (_, i) => ({
    id: `${role}-${String(i).padStart(2, '0')}`, name: role === 'drop' && i === 0 ? 'Grand Teton' : role === 'chorus' ? chorus[i] : undefined,
    localM: [r * 9000, 2000 + r * 100 + i, i * 5000], elevationM: 2000 + r * 100 + i,
    grandeur: role === 'drop' ? 1 - i * .005 : .6, prominenceM: 200,
    suit: Object.fromEntries(TOUR_ROLES.map(k => [k, k === role ? 1 - i * .01 : 0])),
  })));
}

test('each role has four distinct primaries, two north/south thirds, and its required spacing', () => {
  const result = assignRoles(rolePool());
  const primaries = result.points.filter(p => p.tier === 'primary');
  assert.equal(primaries.length, 44);
  assert.equal(new Set(primaries.map(p => p.id)).size, 44);
  for (const role of TOUR_ROLES) {
    const group = primaries.filter(p => p.role === role);
    assert.equal(group.length, 4, role);
    assert.ok(new Set(group.map(p => Math.min(2, Math.floor(p.localM[2] / 95000 * 3)))).size >= 2, role);
    for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) {
      assert.ok(Math.hypot(group[a].localM[0] - group[b].localM[0], group[a].localM[2] - group[b].localM[2]) >= (role === 'drop' ? 1500 : 2500));
    }
  }
  assert.ok(primaries.some(p => p.role === 'drop' && p.name === 'Grand Teton'));
  assert.ok(primaries.filter(p => p.role === 'chorus' && ['Mount Owen', 'Middle Teton', 'Mount Moran', 'Teewinot', 'Mount Saint John', 'Buck Mountain'].includes(p.name)).length >= 2);
});

test('backups are capped, have sufficient suitability, and stay at least 800 metres apart', () => {
  const result = assignRoles(rolePool());
  assert.ok(result.points.filter(p => p.tier !== 'scenery').length <= 198);
  for (const role of TOUR_ROLES) {
    const backups = result.points.filter(p => p.role === role && p.tier === 'backup');
    const weakest = Math.min(...result.points.filter(p => p.role === role && p.tier === 'primary').map(p => p.suit[role]));
    assert.equal(backups.length, 14);
    for (const p of backups) assert.ok(p.suit[role] >= .5 * weakest);
    for (let a = 0; a < backups.length; a++) for (let b = a + 1; b < backups.length; b++) {
      assert.ok(Math.hypot(backups[a].localM[0] - backups[b].localM[0], backups[a].localM[2] - backups[b].localM[2]) >= 800);
    }
  }
});

test('assignment is deterministic regardless of input order and does not mutate the source points', () => {
  const source = rolePool(), before = structuredClone(source);
  const forward = assignRoles(source), reverse = assignRoles([...source].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(source, before);
});

test('unsatisfiable primary spread is rejected rather than silently weakening the constraints', () => {
  const points = rolePool();
  for (const p of points.filter(p => p.suit.drop > 0)) p.localM[2] = 0;
  assert.throws(() => assignRoles(points), /drop.*primary/);
});

test('role formulas are bounded, distinguish prominence and approach, and preserve a skyline-visible satellite', () => {
  const defaults = { type: 'summit', prominenceM: 200, sharpness: .1, meanSlope300Deg: 20,
    skyOpenness: .1, viewshedKm2: 100, side: 'east', faceAspectDeg: 90, distanceToCrestM: 1000, waterWithin2km: 0 };
  const points = [
    { ...defaults, id: 'grand', name: 'Grand Teton', localM: [0, 4199, 0], elevationM: 4199, grandeur: 1, distanceToCrestM: 0 },
    { ...defaults, id: 'approach', localM: [1000, 3799, 0], elevationM: 3799, grandeur: .6, bigNeighbourVisible: true },
    { ...defaults, id: 'above', localM: [-1000, 4299, 0], elevationM: 4299, grandeur: .6 },
    { ...defaults, id: 'low-prom', localM: [2000, 3799, 0], elevationM: 3799, grandeur: .9, prominenceM: 100 },
  ];
  const scored = roleSuitabilities(points);
  for (const p of scored) {
    assert.deepEqual(Object.keys(p.suit), TOUR_ROLES);
    assert.ok(Object.values(p.suit).every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  }
  assert.equal(scored.find(p => p.id === 'grand').suit.drop, 1);
  assert.equal(scored.find(p => p.id === 'low-prom').suit.drop, 0);
  assert.ok(scored.find(p => p.id === 'approach').suit['pre-chorus'] > scored.find(p => p.id === 'above').suit['pre-chorus']);
  assert.ok(scored.find(p => p.id === 'approach').suit['post-chorus'] > 0);
  assert.equal(scored.find(p => p.id === 'above').suit['post-chorus'], 0);
});

test('station-rejected role pairs cannot return as primaries or backups, without weakening pool constraints', () => {
  const source=rolePool(), pair='verse:verse-00';
  assert.equal(assignRoles(source).points.find(p=>p.id==='verse-00').tier,'primary');
  const result=assignRoles(source,{excludedStationPairs:new Set([pair])});
  assert.equal(result.points.find(p=>p.id==='verse-00').tier,'scenery');
  assert.equal(result.stats.primaries,44);
  assert.deepEqual(result,assignRoles([...source].reverse(),{excludedStationPairs:new Set([pair])}));
  const all=new Set(source.filter(p=>p.suit.verse>0).map(p=>'verse:'+p.id));
  assert.throws(()=>assignRoles(source,{excludedStationPairs:all}),/verse.*primary/);
});

test('reviewed backup allowlists trim surplus stations while retaining primary constraints', () => {
  const input=rolePool(),full=assignRoles(input);
  const backupPointIds=full.points.filter(p=>p.tier==='backup').filter((_,i)=>i%4===0).map(p=>p.id);
  const trimmed=assignRoles(input,{tunables:{backupPointIds}});
  assert.equal(trimmed.stats.primaries,44);
  assert.ok(trimmed.points.filter(p=>p.tier==='backup').every(p=>backupPointIds.includes(p.id)));
  assert.ok(trimmed.stats.backups<full.stats.backups);
});
