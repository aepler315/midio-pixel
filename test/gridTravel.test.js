import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cruiseTravel } from '../src/world/redline/Cruise.js';

for (const [name, travel, maxSpeed] of [
  ['Redline', cruiseTravel, 140],
]) {
  for (const at of [10, 180]) for (const falling of [false, true]) {
    test(`${name}: ${falling ? 'falling' : 'rising'} energy at ${at}s cannot jump or reverse travel`, () => {
      const curves = { globalEnergyNorm: (ms) => (ms < at * 1000 ? (falling ? 0.7 : 0.2) : (falling ? 0.2 : 0.7)) };
      const before = travel(at, curves);
      for (let i = 1; i <= 90; i++) {
        const t = at + i / 60;
        const delta = travel(t, curves) - travel(t - 1 / 60, curves);
        assert.ok(delta > 0 && delta <= maxSpeed / 60 + 1e-8, `invalid displacement ${delta}`);
      }
      assert.equal(travel(at, curves), before, 'backward seek changes position');
      assert.equal(travel(at, { ...curves }), before, 'direct seek differs from cached playback');
      assert.equal(travel(at, curves, true), before / 2);
    });
  }
  test(`${name}: a new song has its own travel history`, () => {
    const quiet = { globalEnergyNorm: () => 0.05 };
    const loud = { globalEnergyNorm: () => 0.4 };
    assert.notEqual(travel(180, quiet), travel(180, loud));
    assert.equal(travel(-1, quiet), 0);
    assert.equal(travel(NaN, quiet), 0);
  });
}

// Independent integral: energy is .4, zero-padded 160ms smoothing. Rates at
// 20ms nodes are 10,11,...,18 px/s, then stay at 18. Area to 1s is 17.28px.
test('travel integrates the opening envelope and honors the response window', async () => {
  const { energyTravel } = await import('../src/world/EnergyTravel.js');
  const curves = { globalEnergyNorm: () => 0.4 };
  const rate = (energy) => 10 + 20 * energy;
  assert.ok(Math.abs(energyTravel(1, curves, rate, { smoothingMs: 160 }) - 17.28) < 1e-9);
  assert.ok(energyTravel(1, curves, rate, { smoothingMs: 1200 }) < 17.28);
});

test('travel is causal and identical for direct seek and irregular render intervals', async () => {
  const { energyTravel } = await import('../src/world/EnergyTravel.js');
  const samples = [];
  const curves = { globalEnergyNorm: (ms) => { samples.push(ms); return 0.2 + 0.1 * Math.sin(ms / 800); } };
  const rate = (energy) => 20 + 30 * energy;
  const direct = energyTravel(180.017, curves, rate);
  assert.ok(samples.every(ms => ms <= 180017));
  const replay = { globalEnergyNorm: curves.globalEnergyNorm };
  for (let t = 0; t < 180; t += 0.137) energyTravel(t, replay, rate);
  assert.equal(energyTravel(180.017, replay, rate), direct);
  assert.equal(energyTravel(3.01, curves, rate), energyTravel(3.01, { ...curves }, rate));
});
