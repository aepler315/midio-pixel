import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSurfaceBytes, buildRidgeSurface } from '../src/world/alpine/RidgeSurface.js';

const fixture = (seed = 315, biomeKey = 'RAINFOREST') => ({
  seed, biomeKey, layerKey: 'L3', width: 1024, step: 4, bottomY: 240,
  ridgeYs: Float32Array.from({ length: 257 }, (_, i) => 105 - 42 * Math.sin(i * Math.PI / 256) - 12 * Math.sin(5 * i * Math.PI / 256)),
});

test('features stay deterministic, bounded and attached to source strip geometry', () => {
  const args = fixture(), source = args.ridgeYs.slice();
  const a = buildRidgeSurface(args), b = buildRidgeSurface(args);
  assert.deepEqual(a, b);
  assert.deepEqual(args.ridgeYs, source);
  assert.ok(a.byteLength > 0 && a.byteLength < 1024 * 1024);
  assert.ok(a.facets.length > 0);
  for (const f of a.facets) for (const v of f.vertices) {
    assert.ok(v.sx >= 0 && v.sx <= args.width);
    assert.ok(v.depth01 >= 0 && v.depth01 <= 1);
  }
  assert.notDeepEqual(buildRidgeSurface(fixture(42)), a);
});

test('flat scans keep the skyline and only add restrained panels', () => {
  const flat = fixture();
  flat.ridgeYs.fill(100);
  const original = flat.ridgeYs.slice();
  const surface = buildRidgeSurface(flat);
  assert.deepEqual(flat.ridgeYs, original);
  assert.ok(surface.facets.length > 0);
  assert.ok(surface.facets.every((f) => f.structural && Math.abs(f.intrinsicTone) <= 0.16));
  assert.ok(surface.stands.length > 0, 'forest can grow on a broad plateau');
  const dry = buildRidgeSurface(fixture(315, 'DESERT'));
  assert.equal(dry.stands.length, 0);
});

test('quiet-slope panels share both crest and depth boundaries', () => {
  const flat = fixture();
  flat.ridgeYs.fill(100);
  const panels = buildRidgeSurface(flat).facets.filter((f) => f.id.includes(':panel:'));
  assert.ok(panels.length >= 2);
  for (let i = 1; i < panels.length; i++) {
    const previous = panels[i - 1].vertices;
    const next = panels[i].vertices;
    assert.deepEqual(previous[1], next[0], `crest gap at panel ${i}`);
    assert.deepEqual(previous[2], next.at(-1), `depth gap at panel ${i}`);
  }
});

test('forest cover continues through a long strip instead of ending after early peaks', () => {
  const args = fixture();
  args.width = 8192;
  args.ridgeYs = Float32Array.from({ length: 2049 }, (_, i) => 120 - 30 * Math.sin(i * Math.PI / 250));
  const surface = buildRidgeSurface(args);
  const standSx = (s) => Math.max(...(s.vertices || []).map((v) => v.sx), s.sx || 0);
  assert.ok(surface.stands.some((s) => standSx(s) > 7000), 'late traversal should still have canopy');
  assert.ok(surface.byteLength < 1024 * 1024);
  assert.ok(aggregateSurfaceBytes([surface, surface, surface, surface, surface, surface, surface, surface]) < 1024 * 1024);
});

test('summit detection follows the source peak between former probe positions', () => {
  const ridgeYs = Float32Array.from({ length: 1025 }, (_, x) =>
    160 - 70 * Math.exp(-(((x - 201) / 24) ** 2)));
  const original = ridgeYs.slice();
  const surface = buildRidgeSurface({
    seed: 315, biomeKey: 'CANYON', layerKey: 'L3',
    width: 1024, ridgeYs, step: 1, bottomY: 240,
  });
  assert.deepEqual(Array.from(ridgeYs), Array.from(original));
  assert.equal(surface.version, 2);
  assert.ok(surface.facets.some((f) => f.vertices.some((v) =>
    Math.abs(v.sx - 201) <= 8 && v.depth01 === 0)));
});

test('a long slope and a plateau keep the skyline and gain broad panels', () => {
  const slope = Float32Array.from({ length: 400 }, (_, i) => 40 + i * 0.4);
  const before = slope.slice();
  const surface = buildRidgeSurface({
    seed: 7, biomeKey: 'STEPPE', layerKey: 'L4', width: 1600, ridgeYs: slope, step: 4, bottomY: 200,
  });
  assert.deepEqual(Array.from(slope), Array.from(before));
  assert.ok(surface.facets.some((f) => f.structural && Math.abs(f.intrinsicTone) < 0.2));
});

test('cover and face families do not share a random stream', () => {
  const rain = buildRidgeSurface(fixture(315, 'RAINFOREST'));
  const canyon = buildRidgeSurface(fixture(315, 'CANYON'));
  assert.deepEqual(rain.facets.map((f) => f.vertices), canyon.facets.map((f) => f.vertices));
  assert.notDeepEqual(rain.stands.map((s) => s.kind), canyon.stands.map((s) => s.kind));
});

test('summit facets taper into the upper slope instead of becoming full-height slabs', () => {
  const surface = buildRidgeSurface(fixture());
  const summitFaces = surface.facets.filter((f) => f.id.includes(':face:'));
  assert.ok(summitFaces.length >= 2);
  for (const face of summitFaces) {
    assert.ok(Math.max(...face.vertices.map((v) => v.depth01)) <= .5,
      `${face.id} reaches too deep into the flat body`);
  }
  const [left, right] = summitFaces;
  assert.ok(left.vertices.some((v) => right.vertices.some((w) => v.sx === w.sx && v.depth01 === w.depth01)),
    'paired summit faces lost their shared crest');
});

test('forest descriptors form shallow tapered clusters with irregular spacing', () => {
  const args = fixture();
  args.width = 8192;
  args.ridgeYs = Float32Array.from({ length: 2049 }, (_, i) => 120 - 30 * Math.sin(i * Math.PI / 250));
  const surface = buildRidgeSurface(args);
  assert.ok(surface.stands.length >= 8);
  const centers = [];
  for (const stand of surface.stands) {
    const points = stand.vertices;
    const minX = Math.min(...points.map((p) => p.sx));
    const maxX = Math.max(...points.map((p) => p.sx));
    const minDepth = Math.min(...points.map((p) => p.depth01));
    const maxDepth = Math.max(...points.map((p) => p.depth01));
    assert.ok(maxDepth - minDepth <= .35, `${stand.id} is a canopy tower`);
    const lower = points.filter((p) => p.depth01 > minDepth + .14);
    assert.ok(lower.every((p) => p.sx > minX + 0.1 * (maxX - minX)
      && p.sx < maxX - 0.1 * (maxX - minX)), `${stand.id} has a vertical wall edge`);
    centers.push((minX + maxX) * .5);
  }
  const gaps = centers.slice(1).map((x, i) => x - centers[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 70, 'forest still marches at regular intervals');
});
