import { test } from 'node:test';
import assert from 'node:assert/strict';
import { musicMoments } from '../src/world/terrain/ShotMusic.js';
import { anthemSong } from './fixtures/shot-library-fixture.mjs';

const near = (list, t, tol = 100) => list.find((m) => Math.abs(m.timeMs - t) <= tol);

test('anthem: chorus impacts come from the energy rise, not the early detected boundaries', () => {
  const song = anthemSong(), m = musicMoments(song);
  for (const [t, section] of [[48000, 3], [96000, 7], [128000, 9]]) {
    const impact = near(m.impacts, t);
    assert.ok(impact, `impact at ${t}`);
    assert.equal(impact.timeMs, t, 'lands on the downbeat, not the detected start');
    assert.equal(impact.boundary, true);
    assert.equal(impact.sectionIndex, section);
    assert.equal(impact.role, 'chorus');
  }
  assert.ok(!near(m.impacts, 45500, 1000) && !near(m.impacts, 93500, 1000), 'nothing at the detected boundaries');
  for (let i = 1; i < m.impacts.length; i++) assert.ok(m.impacts[i].timeMs - m.impacts[i - 1].timeMs >= 6000, 'impacts at least 6 s apart');
  assert.ok(m.impacts.every((x) => x.strength >= 0 && x.strength <= 1 && Number.isInteger(x.sectionIndex)));
  assert.equal(m.climax.timeMs, 128000);
  assert.equal(m.climax.strength, Math.max(...m.impacts.map((x) => x.strength)));
  assert.ok(m.impacts.includes(m.climax));
  assert.deepEqual(m.phrases, [15500, 37500, 45500, 67500, 75500, 85500, 93500, 113500, 127500, 153500]);
});

test('a misplaced final-chorus label does not move the climax off the strongest late rise', () => {
  const m = musicMoments(anthemSong({ finalChorusIndex: 7 }));
  assert.equal(m.climax.timeMs, 128000);
});

test('the final chorus wins the climax when its rise is within 15% of the strongest', () => {
  const durationMs = 160000, energy = new Float32Array(1601);
  for (let i = 0; i < energy.length; i++) { const t = i * 100; energy[i] = t >= 96000 && t < 114000 ? .9 : t >= 128000 && t < 150000 ? .83 : .2; }
  const sections = [0, 30000, 96000, 114000, 128000, 150000].map((startMs, i, all) => ({ startMs, endMs: all[i + 1] ?? durationMs }));
  const roles = (final) => ['intro', 'verse', 'chorus', 'bridge', 'chorus', 'outro'].map((role, i) => ({ role, finalChorus: i === final, stops: [] }));
  assert.equal(musicMoments({ durationMs, sections, roles: roles(4), energy }).climax.timeMs, 128000);
  assert.equal(musicMoments({ durationMs, sections, roles: roles(-1), energy }).climax.timeMs, 96000);
});

test('calm spans, stops and intensity follow the song', () => {
  const song = anthemSong();
  song.roles[5] = { ...song.roles[5], stops: [{ startMs: 80000, endMs: 82000 }] };
  const m = musicMoments(song);
  assert.deepEqual(m.calm, [{ startMs: 0, endMs: 15500 }, { startMs: 80000, endMs: 82000 }, { startMs: 113500, endMs: 127500 }, { startMs: 153500, endMs: 170000 }]);
  for (let t = 0; t <= 170000; t += 500) { const v = m.intensityAt(t); assert.ok(v >= 0 && v <= 1); }
  assert.ok(m.intensityAt(8000) < .2 && m.intensityAt(120000) < .2, 'intro and bridge are calm');
  assert.ok(m.intensityAt(140000) > .8, 'the final chorus is energetic');
});

test('moments are pure and deterministic; a song without energy has none', () => {
  const strip = (m) => JSON.stringify({ ...m, intensity: [...m.intensity], intensityAt: null });
  assert.equal(strip(musicMoments(anthemSong())), strip(musicMoments(anthemSong())));
  const empty = musicMoments({ durationMs: 60000, sections: [{ startMs: 0, endMs: 60000 }], roles: [{ role: 'verse' }], energy: [] });
  assert.deepEqual(empty.impacts, []);
  assert.equal(empty.climax, null);
  assert.equal(empty.intensityAt(1000), .5);
});

// The real analysed energy (100 ms steps) from 10 s before to 6 s after
// three downbeats, from .smoke/song-structure-v3/structure.json: drop.wav at
// 45.0 and 97.5 s, anthem.wav at 48.0 s, each at index 100. The music dips
// just before each drop, so the 1 s rise peaks 100-200 ms early there.
const DROP_45 = [0.127, 0.084, 0.361, 0.154, 0.204, 0.105, 0.099, 0.269, 0.13, 0.121, 0.085, 0.615, 0.215, 0.118, 0.106, 0.069, 0.344, 0.142, 0.216, 0.096, 0.024, 0.305, 0.151, 0.157, 0.092, 0.542, 0.144, 0.08, 0.092, 0.094, 
  0.386, 0.134, 0.1, 0.092, 0.077, 0.266, 0.113, 0.098, 0.096, 0.554, 0.201, 0.115, 0.087, 0.059, 0.462, 0.136, 0.337, 0.151, 0.105, 0.316, 0.143, 0.322, 0.139, 0.532, 0.257, 0.152, 0.233, 0.147, 0.637, 0.218, 
  0.323, 0.179, 0.116, 0.378, 0.489, 0.21, 0.352, 0.464, 0.319, 0.428, 0.22, 0.264, 0.811, 0.292, 0.319, 0.596, 0.268, 0.541, 0.538, 0.314, 0.461, 0.367, 0.435, 0.395, 0.437, 0.574, 0.935, 0.729, 0.416, 0.434, 
  0.473, 0.71, 0.686, 0.7, 0.628, 0.482, 0.618, 0.564, 0.609, 0.654, 0.986, 0.874, 0.734, 0.707, 0.636, 0.956, 0.722, 0.703, 0.618, 0.432, 0.725, 0.495, 0.494, 0.371, 0.925, 0.61, 0.366, 0.371, 0.253, 0.658, 
  0.404, 0.416, 0.266, 0.135, 0.611, 0.28, 0.522, 0.267, 0.416, 0.354, 0.221, 0.328, 0.175, 0.935, 0.399, 0.331, 0.265, 0.139, 0.583, 0.314, 0.434, 0.229, 0.538, 0.52, 0.253, 0.439, 0.24, 0.561, 0.358, 0.284, 
  0.295, 0.171, 0.784, 0.355, 0.46, 0.24, 0.146, 0.473, 0.257, 0.346, 0.19];
const ANTHEM_48 = [0.51, 0.252, 0.139, 0.127, 0.086, 0.666, 0.251, 0.141, 0.125, 0.088, 0.463, 0.215, 0.103, 0.141, 0.086, 0.682, 0.251, 0.14, 0.136, 0.091, 0.501, 0.185, 0.131, 0.142, 0.129, 0.555, 0.223, 0.152, 0.139, 0.121, 
  0.573, 0.229, 0.158, 0.143, 0.138, 0.611, 0.24, 0.17, 0.131, 0.099, 0.627, 0.219, 0.15, 0.258, 0.159, 0.672, 0.267, 0.165, 0.26, 0.162, 0.739, 0.275, 0.189, 0.296, 0.186, 0.787, 0.309, 0.217, 0.31, 0.17, 
  0.803, 0.292, 0.394, 0.241, 0.296, 0.886, 0.353, 0.438, 0.271, 0.317, 0.901, 0.372, 0.465, 0.293, 0.368, 0.929, 0.426, 0.521, 0.331, 0.361, 0.918, 0.474, 0.431, 0.488, 0.616, 0.924, 0.528, 0.497, 0.536, 0.676, 
  0.913, 0.581, 0.539, 0.578, 0.675, 0.914, 0.618, 0.567, 0.591, 0.667, 0.936, 0.864, 0.764, 0.718, 0.713, 0.948, 0.865, 0.742, 0.707, 0.618, 0.848, 0.692, 0.539, 0.528, 0.433, 0.956, 0.578, 0.395, 0.424, 0.251, 
  0.571, 0.403, 0.304, 0.41, 0.312, 0.971, 0.494, 0.288, 0.41, 0.285, 0.577, 0.434, 0.317, 0.423, 0.301, 0.966, 0.468, 0.296, 0.379, 0.191, 0.571, 0.384, 0.29, 0.432, 0.307, 0.997, 0.495, 0.309, 0.415, 0.297, 
  0.621, 0.466, 0.332, 0.438, 0.309, 0.984, 0.509, 0.319, 0.388, 0.202, 0.525];
const DROP_975 = [0.078, 0.069, 0.065, 0.073, 0.067, 0.033, 0.012, 0.09, 0.084, 0.094, 0.104, 0.089, 0.088, 0.084, 0.083, 0.08, 0.157, 0.124, 0.113, 0.101, 0.092, 0.084, 0.085, 0.062, 0.031, 0.536, 0.141, 0.08, 0.093, 0.094, 
  0.377, 0.133, 0.1, 0.092, 0.077, 0.263, 0.112, 0.098, 0.094, 0.55, 0.199, 0.114, 0.087, 0.059, 0.46, 0.137, 0.349, 0.154, 0.102, 0.314, 0.143, 0.331, 0.139, 0.553, 0.261, 0.15, 0.237, 0.147, 0.627, 0.224, 
  0.332, 0.175, 0.115, 0.365, 0.482, 0.203, 0.34, 0.454, 0.326, 0.429, 0.219, 0.275, 0.814, 0.288, 0.325, 0.595, 0.265, 0.528, 0.515, 0.307, 0.458, 0.362, 0.434, 0.413, 0.432, 0.568, 0.932, 0.707, 0.428, 0.433, 
  0.466, 0.714, 0.688, 0.699, 0.628, 0.487, 0.619, 0.565, 0.607, 0.65, 0.994, 0.861, 0.744, 0.704, 0.645, 0.967, 0.727, 0.73, 0.63, 0.432, 0.709, 0.494, 0.5, 0.382, 0.93, 0.614, 0.369, 0.362, 0.255, 0.691, 
  0.409, 0.437, 0.277, 0.13, 0.615, 0.285, 0.554, 0.281, 0.42, 0.365, 0.23, 0.311, 0.176, 0.952, 0.418, 0.339, 0.252, 0.139, 0.603, 0.327, 0.445, 0.238, 0.532, 0.518, 0.258, 0.463, 0.253, 0.574, 0.367, 0.275, 
  0.29, 0.175, 0.8, 0.37, 0.462, 0.241, 0.144, 0.497, 0.269, 0.356, 0.193];

test('impacts land on the onset where the music dips before the downbeat (real drop.wav and anthem.wav energy)', () => {
  // The excerpts spliced into a quiet 90 s song at 5, 25 and 50 s: downbeats
  // at 15.0, 35.0 and 60.0 s; the detected sections start where the analysis
  // put them in the real songs (the drops 1.9 s late, the chorus 2.5 s early).
  const durationMs = 90000, energy = new Float32Array(901);
  for (let i = 0; i < energy.length; i++) energy[i] = .15 + .03 * Math.sin(2 * Math.PI * i / 5);
  for (const [at, lane] of [[50, DROP_45], [250, ANTHEM_48], [500, DROP_975]]) energy.set(lane, at);
  const starts = [0, 16900, 24000, 32500, 44000, 61900, 72000], names = ['intro', 'drop', 'verse', 'chorus', 'verse', 'drop', 'outro'];
  const sections = starts.map((startMs, i) => ({ startMs, endMs: starts[i + 1] ?? durationMs }));
  const roles = names.map((role, i) => ({ role, finalChorus: i === 5, stops: [] }));
  const m = musicMoments({ durationMs, sections, roles, energy });
  for (const t of [15000, 35000, 60000]) {
    const impact = near(m.impacts, t, 300);
    assert.ok(impact, `an impact near ${t}: ${m.impacts.map((x) => x.timeMs)}`);
    assert.equal(impact.timeMs, t, `on the onset, not the 1 s rise's early peak (${impact.timeMs})`);
    assert.equal(impact.boundary, true);
  }
  assert.equal(m.climax.timeMs, 60000);
});

test('a lone beat spike just before the downbeat is not taken for the onset', () => {
  // Beats every 500 ms (one loud sample each) over a steady level that dips
  // for the last 500 ms; at 10.0 s the level steps up and stays. A spike at
  // 9.7 s jumps further than the downbeat does, but does not hold.
  const durationMs = 20000, energy = new Float32Array(201);
  for (let i = 0; i < energy.length; i++) energy[i] = (i >= 100 ? .82 : .55) + (i % 5 === 0 ? .3 : 0);
  for (let i = 95; i < 100; i++) energy[i] = .45;
  energy[97] = 1.2;
  const sections = [{ startMs: 0, endMs: 8000 }, { startMs: 8000, endMs: 20000 }], roles = [{ role: 'verse' }, { role: 'chorus' }];
  assert.equal(near(musicMoments({ durationMs, sections, roles, energy }).impacts, 10000, 600)?.timeMs, 10000);
});
