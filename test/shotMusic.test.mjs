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
