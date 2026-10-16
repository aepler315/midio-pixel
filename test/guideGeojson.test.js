import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guidesFromGeoJSON } from '../src/world/terrain/GuideGeoJSON.js';

const frame = { west: -111, south: 43.55, north: 43.95 };

test('a GeoJSON guide projects lon, lat into meters and keeps the layers apart', () => {
  const guides = guidesFromGeoJSON({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { layer: 'far' },
        geometry: { type: 'LineString', coordinates: [[-110.8, 43.6], [-110.8, 43.9]] },
      },
      {
        type: 'Feature',
        properties: { layer: 'near' },
        geometry: { type: 'MultiLineString', coordinates: [[[-110.3, 43.62], [-110.3, 43.9]]] },
      },
    ],
  }, frame);
  assert.equal(guides.mid, undefined);
  assert.ok(guides.far[1].y > guides.far[0].y);
  assert.ok(guides.near[0].x > guides.far[0].x);
});

test('a guide file rejects a polygon and a second line for the same layer', () => {
  assert.throws(() => guidesFromGeoJSON({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { layer: 'far' },
      geometry: { type: 'Polygon', coordinates: [] },
    }],
  }, frame));
  assert.throws(() => guidesFromGeoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { layer: 'far' }, geometry: { type: 'LineString', coordinates: [[-110.8, 43.6], [-110.8, 43.7]] } },
      { type: 'Feature', properties: { layer: 'far' }, geometry: { type: 'LineString', coordinates: [[-110.8, 43.8], [-110.8, 43.9]] } },
    ],
  }, frame));
});

test('a disconnected MultiLineString is rejected rather than joined across space', () => {
  assert.throws(() => guidesFromGeoJSON({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { layer: 'mid' },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[-110.8, 43.6], [-110.8, 43.7]],
          [[-110.4, 43.8], [-110.4, 43.9]],
        ],
      },
    }],
  }, frame), /disconnected/i);
});

test('the Teton guide file is the crest and the eastern range', () => {
  const geo = JSON.parse(readFileSync(new URL('../data/terrain/tetons-guides.geojson', import.meta.url), 'utf8'));
  const guides = guidesFromGeoJSON(geo, frame);
  assert.ok(guides.far.length >= 2 && guides.near.length >= 2);
  assert.equal(guides.mid, undefined);
  // The crest stays on the Tetons, west of -110.7. The other line stays east of the valley.
  assert.ok(geo.features.find((f) => f.properties.layer === 'far').geometry.coordinates.every((c) => c[0] < -110.7));
  assert.ok(geo.features.find((f) => f.properties.layer === 'near').geometry.coordinates.every((c) => c[0] > -110.5));
});
