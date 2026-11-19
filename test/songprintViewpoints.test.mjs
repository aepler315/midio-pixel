import test from 'node:test';
import assert from 'node:assert/strict';
import { songprintRailStations, songprintShotPayoffs } from '../src/world/alpine/SongprintViewpoints.js';

const summit = { pointM: [0, 100, -900] };
const ridge = { pointM: [250, 100, -900] };
const terrain = { groundAt: (x, z) => Math.abs(x) < 45 && z < -400 && z > -550 ? 210 : 0 };
const rail = { camera: {
  eyeStartM: [0, 100, 0], eyeEndM: [440, 100, 0],
  targetStartM: [0, 100, -900], targetEndM: [0, 100, -900], fovYDeg: 50,
} };

test('a rail can improve an occluded summit and include the nearby ridge', () => {
  const stations = songprintRailStations(terrain, rail, [summit, ridge]);
  const [summitStations] = stations;
  assert.ok(summitStations.length);
  assert.ok(summitStations.every(({ progress01, score }) => progress01 > 0 && score > 0 && score <= 1));
  const [soloStations] = songprintRailStations(terrain, rail, [summit]);
  assert.ok(summitStations.some((s, i) => s.score > soloStations[i].score));
});

test('only shot payoffs with the summit both in frame and clear score as destinations', () => {
  const shot = (id, x, aimX) => ({ id, payoffS: 100, path: {
    eye: Float32Array.of(x, 100, 0, x, 100, -100),
    aim: Float32Array.of(aimX, 100, -900, aimX, 100, -900),
    fov: Float32Array.of(50, 50),
    s: Float32Array.of(0, 100),
  } });
  const [payoffs] = songprintShotPayoffs(terrain, { shots: [
    shot('offscreen', 440, 1600),
    shot('behind-ridge', 0, 0),
    shot('past-ridge', 440, 0),
  ] }, [summit, ridge]);
  assert.deepEqual(payoffs.map(choice => choice.id), ['past-ridge']);
});
