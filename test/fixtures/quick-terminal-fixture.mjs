import { packShotPaths, decodeShotLibrary, SHOT_SCHEMA, SHOT_VERSION } from '../../src/world/terrain/ShotLibrary.js';
import { SHOT_MOTION } from '../../src/world/terrain/ShotTimeline.js';

// Three flat shots and two links, with 24 decoded path samples in total.
// The departure link's brief flow peak limits its speed without requiring
// real terrain or audio. After the hero payoff, all three usual quick
// ending candidates clamp to the same infeasible speed; a slower ending
// preserves the opening payoff and the hero climax within the same limits.
export function quickTerminalFixture() {
  const flat = (from, length, count, spike = false) => ({
    s: Float32Array.from({ length: count }, (_, i) => length * i / (count - 1)),
    eye: Float32Array.from(Array.from({ length: count }, (_, i) => [from + length * i / (count - 1), 1000, 0]).flat()),
    aim: Float32Array.from(Array.from({ length: count }, (_, i) => [from + length * i / (count - 1), 1000, -1000]).flat()),
    fov: new Float32Array(count).fill(36),
    flow: Float32Array.from({ length: count }, (_, i) => spike && i === Math.floor(count / 2) ? .002 : .0001),
  });
  const shot = (id, from, length, payoff) => ({
    id, subjectId: id, move: 'traverse',
    path: flat(from, length, Math.max(3, Math.ceil(length / 2000) + 1)),
    lengthM: length, payoffS: payoff, holdS: [payoff, payoff],
    durationMs: { min: length / 120 * 1000, max: length / 4 * 1000 },
    traits: { headingDeg: 0, aglM: 1000, lens: 'wide' }, score: { total: 1 }, tags: [],
  });
  const shots = [shot('opening', 0, 1000, 800), shot('hero', 1100, 6800, 6700), shot('unreached', 9900, 2000, 1000)];
  const links = [
    { id: 'arrive', from: 'opening', to: 'hero', kind: 'direct', path: flat(1000, 100, 2), lengthM: 100, durationMs: { min: 1000, max: 25000 }, score: { total: 1 } },
    { id: 'depart', from: 'hero', to: 'unreached', kind: 'direct', path: flat(7900, 2000, 11, true), lengthM: 2000, durationMs: { min: 20000, max: 500000 }, score: { total: 1 } },
  ];
  const packed = packShotPaths([...shots, ...links]);
  const records = list => list.map(({ path, ...record }) => record);
  const library = decodeShotLibrary({
    schema: SHOT_SCHEMA, version: SHOT_VERSION, viewId: 'quick-terminal-fixture',
    terrainManifestSha256: 'a'.repeat(64), axes: { x: 'east', y: 'up', z: 'south', units: 'metres' },
    motion: { ...SHOT_MOTION, maxSpeedMps: 120, minSpeedMps: 4, maxAccelMps2: 3.5, maxClimbMps: 22, flowCalm: .07, flowEnergetic: .07, maxYawDegPerSec: 20 },
    subjects: shots.map(s => ({ id: s.subjectId, kind: 'landmark', posM: [0, 0, -1000], radiusM: 100, hero: s.id === 'hero' })),
    shots: records(shots), links: records(links),
    payload: { url: 'fixture.bin', byteLength: packed.length, decodedByteLength: packed.length, sha256: 'b'.repeat(64), decodedSha256: 'c'.repeat(64) },
  }, packed);
  const options = {
    durationMs: 168000,
    sections: [{ startMs: 0, endMs: 16000, label: 'intro' }, { startMs: 16000, endMs: 128000, label: 'verse' }, { startMs: 128000, endMs: 168000, label: 'chorus' }],
    roles: [{ role: 'intro' }, { role: 'chorus' }, { role: 'chorus', finalChorus: true }],
    energy: Float32Array.from({ length: 1681 }, (_, i) => i >= 160 && i < 320 ? .8 : i >= 1280 && i < 1400 ? .9 : .2),
    energyStepMs: 100, seed: 0,
  };
  return { library, options };
}
