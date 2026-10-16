import test from 'node:test';
import assert from 'node:assert/strict';
import { valleyFogPatches } from '../src/world/alpine/ValleyAtmosphere.js';

test('fog belongs to wet saddles and remains bounded through time', () => {
  const surface = { width: 100, valleys: [{ id: 'v', sx: 50, widthPx: 42, depth01: .4 }] };
  const geom = { bottomY: 300, pts: [{ stripX: 0, x: 0, y: 100 }, { stripX: 100, x: 100, y: 120 }] };
  assert.deepEqual(valleyFogPatches({ surface, geom, terrain: true, moisture: 0, nowMs: 0, maxBanks: 4 }), []);
  const a = valleyFogPatches({ surface, geom, terrain: true, moisture: .85, nowMs: 0, maxBanks: 4 });
  const b = valleyFogPatches({ surface, geom, terrain: true, moisture: .85, nowMs: 2000, maxBanks: 4 });
  assert.equal(a.length, 1);
  assert.ok(a[0].alpha <= .12 && a[0].alpha > 0);
  assert.ok(Math.abs(a[0].x - b[0].x) < 12);
});
