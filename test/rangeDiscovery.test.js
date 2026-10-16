// Automatic range discovery: the pure rules in tools/lib/rangeDiscovery.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxAround, distanceKm, highestPerCell, localRelief, parseGeonamesRow, rangeNameFor, selectRanges, slugify, uniqueId,
} from '../tools/lib/rangeDiscovery.mjs';

const row = (fields) => {
  const f = Array(19).fill('');
  Object.entries(fields).forEach(([i, v]) => { f[i] = String(v); });
  return f.join('\t');
};

test('parseGeonamesRow keeps summits and prefers the surveyed height', () => {
  const rainier = parseGeonamesRow(row({ 0: 5808079, 1: 'Mount Rainier', 4: 46.853, 5: -121.76, 6: 'T', 7: 'MT', 8: 'US', 10: 'WA', 15: 4392, 16: 4346 }));
  assert.equal(rainier.name, 'Mount Rainier');
  assert.equal(rainier.elevM, 4392);
  assert.equal(parseGeonamesRow(row({ 1: 'x', 4: 1, 5: 1, 6: 'T', 7: 'MT', 16: 812 })).elevM, 812, 'SRTM when unsurveyed');
  assert.equal(parseGeonamesRow(row({ 1: 'Cascade Range', 4: 1, 5: 1, 6: 'T', 7: 'MTS' })), null, 'a named range is not a summit');
  assert.equal(parseGeonamesRow(row({ 1: 'Seattle', 4: 1, 5: 1, 6: 'P', 7: 'PPL' })), null);
});

test('highestPerCell keeps one summit per cell, the highest', () => {
  const s = (name, lat, lon, elevM) => ({ name, lat, lon, elevM });
  const kept = highestPerCell([s('a', 40.1, -110.1, 2000), s('b', 40.2, -110.2, 3000), s('c', 41.1, -110.1, 900), s('d', 42.1, -110.1, 300)]);
  assert.deepEqual(kept.map((k) => k.name).sort(), ['b', 'c'], 'd is under the 500m floor');
});

test('localRelief ignores lone spikes, the sea floor and one-pixel pits', () => {
  const ground = Array.from({ length: 100 }, (_, i) => 1000 + i * 10); // 1000..1990
  assert.equal(localRelief(ground), 1990 - 1100);
  assert.equal(localRelief([...ground, 6000], 2000), 2000 - 1100, 'a spike above the summit is capped');
  const coast = Array.from({ length: 100 }, (_, i) => (i < 40 ? -400 : 1500));
  assert.equal(localRelief(coast, 1500), 1500, 'water counts as sea level');
  assert.ok(Number.isNaN(localRelief([1, 2, 3])));
});

test('boxAround is square on the ground', () => {
  const [w, s, e, n] = boxAround(60, -140, 22);
  const width = distanceKm({ lat: 60, lon: w }, { lat: 60, lon: e });
  const height = distanceKm({ lat: s, lon: -140 }, { lat: n, lon: -140 });
  assert.ok(Math.abs(width - 44) < 0.5 && Math.abs(height - 44) < 0.5, `${width} x ${height}`);
});

// A line of summits a degree of latitude apart (~110km), relief as given.
const line = (reliefs) => reliefs.map((reliefM, i) => ({ geonameId: i, name: `s${i}`, lat: 30 + i, lon: -110, reliefM }));

test('selectRanges keeps picks apart and clear of existing ranges', () => {
  const pool = [
    { geonameId: 1, lat: 40, lon: -110, reliefM: 2500 },
    { geonameId: 2, lat: 40.2, lon: -110, reliefM: 2400 }, // 22km from the first
    { geonameId: 3, lat: 45, lon: -110, reliefM: 2300 },   // inside an existing box
  ];
  const picks = selectRanges(pool, { count: 3, spacingKm: 80, avoidBoxes: [[-110.5, 44.5, -109.5, 45.5]] });
  assert.equal(picks.length, 1, 'the two close summits make one range; the boxed one none');
  assert.ok([1, 2].includes(picks[0].geonameId));
});

test('selectRanges shares the basket across relief bands', () => {
  const pool = line([3000, 2900, 2800, 2700, 2600, 2500, 1500, 1400, 800, 700]);
  const picks = selectRanges(pool, { count: 4 });
  const bands = picks.map((p) => (p.reliefM >= 2000 ? 'high' : p.reliefM >= 1200 ? 'mid' : 'low'));
  assert.ok(bands.includes('mid') && bands.includes('low'), `got ${bands}`);
});

test('selectRanges spreads picks across a band instead of taking its top', () => {
  const pool = line(Array.from({ length: 20 }, (_, i) => 1990 - i * 40)); // 1990..1230, one band
  const picks = selectRanges(pool, { count: 4, bands: [{ minM: 1200, maxM: 2000, share: 1 }] });
  const reliefs = picks.map((p) => p.reliefM).sort((a, b) => b - a);
  assert.ok(reliefs[0] - reliefs[reliefs.length - 1] > 400, `picks span ${reliefs}`);
});

test('an empty band passes its share on', () => {
  const pool = line([800, 750, 700, 650]);
  assert.equal(selectRanges(pool, { count: 4 }).length, 4);
});

test('ids are slugs, unique within the basket', () => {
  assert.equal(slugify('Volcán Pico de Orizaba'), 'volcan-pico-de-orizaba');
  const used = new Set(['pine-mountain']);
  assert.equal(uniqueId('Pine Mountain', 'Oregon, USA', used), 'pine-mountain-oregon-usa');
  assert.equal(uniqueId('Pine Mountain', 'Oregon, USA', used), 'pine-mountain-oregon-usa-2');
});

test('a summit takes the range its recorded neighbours vote for, and none from afar', () => {
  const named = [
    { lat: 45.37, lon: -121.70, range: 'Oregon Cascades' },
    { lat: 45.40, lon: -121.60, range: 'Oregon Cascades' },
    { lat: 45.30, lon: -121.85, range: 'Mount Hood Wilderness' },
    { lat: 46.20, lon: -121.50, range: 'Washington Cascades' },
  ];
  assert.equal(rangeNameFor({ lat: 45.37, lon: -121.69 }, named), 'Oregon Cascades');
  assert.equal(rangeNameFor({ lat: 44.0, lon: -121.7 }, named), null, 'nothing recorded within reach');
});

test('selectRanges takes one summit per named range', () => {
  const pool = line([2900, 2800, 2700, 2600]).map((s, i) => ({ ...s, rangeName: i < 3 ? 'Alaska Range' : 'Brooks Range' }));
  const picks = selectRanges(pool, { count: 4, uniqueBy: 'rangeName', bands: [{ minM: 0, maxM: Infinity, share: 1 }] });
  assert.deepEqual(picks.map((p) => p.rangeName).sort(), ['Alaska Range', 'Brooks Range']);
  const none = selectRanges(pool, { count: 4, uniqueBy: 'rangeName', takenNames: ['Alaska Range', 'Brooks Range'], bands: [{ minM: 0, maxM: Infinity, share: 1 }] });
  assert.equal(none.length, 0, 'a curated range name is already taken');
});
