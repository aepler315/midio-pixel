// A map-drawn ridge guide. GeoJSON LineStrings, coordinates in lon, lat.
// properties.layer is far, mid, or near. One line per layer. The builder
// projects them into the elevation grid's meter space. Playback never
// reads this file.

import { projectLatLon } from './LatLonDem.js';

const LAYERS = new Set(['far', 'mid', 'near']);

function positionsOf(geometry) {
  if (!geometry) throw new Error('guide feature is missing geometry');
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') {
    if (geometry.coordinates?.length !== 1) {
      throw new Error('disconnected MultiLineString guides are not supported');
    }
    return geometry.coordinates;
  }
  throw new Error('guide geometry must be a LineString');
}

/** FeatureCollection → { far, mid, near } polylines in projected meters. */
export function guidesFromGeoJSON(geo, frame) {
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('guide file must be a FeatureCollection');
  }
  if (!(frame?.north > frame?.south) || !Number.isFinite(frame?.west)) {
    throw new Error('guide projection needs the grid frame');
  }
  const out = {};
  for (const feature of geo.features) {
    if (!feature || feature.type !== 'Feature') throw new Error('guide feature is not a Feature');
    const layer = feature.properties?.layer;
    if (!LAYERS.has(layer)) throw new Error('guide feature needs properties.layer of far, mid, or near');
    if (out[layer]) throw new Error(`two guides for ${layer}`);
    const pts = [];
    for (const line of positionsOf(feature.geometry)) {
      if (!Array.isArray(line) || line.length < 2) throw new Error('a guide line needs two positions');
      for (const coord of line) {
        if (!Array.isArray(coord) || coord.length < 2
          || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
          throw new Error('a guide position must be lon, lat');
        }
        pts.push({ lon: coord[0], lat: coord[1] });
      }
    }
    out[layer] = projectLatLon(pts, frame);
  }
  if (!out.far && !out.mid && !out.near) throw new Error('guide file has no ridges');
  return out;
}
