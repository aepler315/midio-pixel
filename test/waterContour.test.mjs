import test from 'node:test';
import assert from 'node:assert/strict';
import { contourCoverage, contourField } from './helpers/waterContourOracle.mjs';

const at = (field, x, y) => contourCoverage(field.rgba, field.width, field.height, x, y);

test('uniform water and dry terrain retain four fetches; only source shoreline cells use sixteen', () => {
  for (const flow of [0, 254, 255]) {
    const field = contourField(8, 8, () => flow);
    assert.deepEqual(at(field, 3.25, 3.75), { coverage: flow === 255 ? 1 : 0, reads: 4 });
  }
  const bank = contourField(8, 8, x => x >= 4 ? 255 : 0);
  assert.deepEqual(at(bank, 3.5, 3.25), { coverage: .5, reads: 16 });
});

test('straight banks stay at the same physical source position and pan continuously', () => {
  const bank = contourField(8, 8, x => x >= 4 ? 255 : 0);
  for (const y of [0, 1.37, 3, 3.8, 6.99]) assert.equal(at(bank, 3.5, y).coverage, .5);
  const pan = Array.from({ length: 101 }, (_, i) => at(bank, 3.45 + i / 1000, 3.21).coverage);
  assert.ok(pan.every((v, i) => !i || v > pan[i - 1]));
  assert.ok(pan.every((v, i) => !i || v - pan[i - 1] < .002), 'no nearest-source-cell coverage jumps');
  assert.ok(Math.abs(at(bank, 3.5, 2 - 1e-6).coverage - at(bank, 3.5, 2 + 1e-6).coverage) < 1e-6);
});

test('corner tangents are rounded while isolated wet posts, narrow channels and dry islands survive', () => {
  const corner = contourField(8, 8, (x, y) => x >= 4 || y >= 4 ? 255 : 0);
  const x = 3.25, y = 3.25;
  const bilinear = 1 - (1 - .25) ** 2;
  assert.notEqual(at(corner, x, y).coverage, bilinear, 'the corner uses its neighbours rather than a bilinear cell arc');
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (at(corner, 3 + t, 3 + t).coverage > .5) hi = t; else lo = t;
  }
  const shiftM = ((lo + hi) / 2 - (1 - Math.SQRT1_2)) * 20;
  assert.ok(shiftM > .6 && shiftM < 1, 'rounding this synthetic 20 m corner changes its diagonal bank by under one metre');
  for (const make of [(x, y) => x === 4 && y === 4 ? 255 : 0, x => x === 4 ? 255 : 0]) {
    const field = contourField(9, 9, make);
    assert.equal(at(field, 4, 4).coverage, 1);
    assert.equal(at(field, 3, 4).coverage, 0);
    assert.equal(at(field, 5, 4).coverage, 0);
  }
  const island = contourField(9, 9, (x, y) => x === 4 && y === 4 ? 0 : 255);
  assert.equal(at(island, 4, 4).coverage, 0);
  assert.equal(at(island, 3, 4).coverage, 1);
});

test('every source post is retained and contour reconstruction never creates water in uniformly dry cells', () => {
  let seed = 19;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 0; };
  const field = contourField(20, 16, () => random() % 5 === 0 ? 255 : random() % 255);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 20; x++) {
    assert.equal(at(field, x, y).coverage, field.rgba[(y * 20 + x) * 4 + 3] === 255 ? 1 : 0);
    if (x === 19 || y === 15) continue;
    const wet = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([x, y]) => field.rgba[(y * 20 + x) * 4 + 3] === 255);
    for (const dx of [.13, .5, .87]) for (const dy of [.17, .5, .83]) {
      const sample = at(field, x + dx, y + dy);
      assert.ok(sample.coverage >= 0 && sample.coverage <= 1);
      assert.ok(sample.reads === 4 || sample.reads === 16);
      if (wet.every(v => !v)) assert.equal(sample.coverage, 0);
    }
  }
});
