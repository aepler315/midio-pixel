import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = main.indexOf('async function changeExperience(');
const end = main.indexOf('\n}\n', start) + 3;
const implementation = main.slice(start, end);

for (const paused of [false, true]) for (const position of [0, 65000]) {
  test(`Trio to Landscape delegates destination ${position} with paused=${paused} to the full playback gate`, async () => {
    const starts = [], timeline = {}, owner = { songSeed: 315, biomes: {}, setExperience() {} };
    const prepared = { enabled: true, setSong() { throw new Error('old manager prepared'); },
      whenReady() { throw new Error('opening-only readiness used'); } };
    const context = vm.createContext({
      resolveExperience: value => value, experienceRequest: 0, sim: owner, experience: 'trio',
      running: true, paused, experienceControl: {}, experienceStatus: {}, lastTimelineData: timeline,
      bulkExportArmed: false, lastStartExtra: { live: false, songSeed: 1, startAtMs: 999 },
      resolveRangeMode: () => ({ mode: 'v2' }), RangePresentation: function () { return prepared; },
      sharedResidency() {}, residencyBudgetFor: () => ({ name: 'desktop' }),
      rangePresentation: null, renderer: { draw() { throw new Error('coarse destination painted before gate'); } },
      writeExperience() {}, displayStorage() {}, location: { href: 'https://example.test/' },
      history: { replaceState() {} }, URL, fitCanvas() {}, syncRangeTourControl() {},
      applyRangeCaptions() {}, worldSelectEl: null, audioEngine: { nowMs: position },
      startTimeline: (data, options) => starts.push({ data, options }),
    });
    vm.runInContext(implementation, context);
    await context.changeExperience('landscape');
    assert.equal(context.experienceStatus.textContent, '', 'the transition must not swallow an integration error');
    assert.equal(context.experience, 'landscape');
    assert.equal(context.rangePresentation, prepared);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].data, timeline);
    const options = starts[0].options;
    assert.equal(options.startAtMs, position);
    assert.equal(options.songSeed, 315);
    assert.equal(options.keepAudio, true);
    assert.equal(options.keepUserCamera, true);
    assert.equal(options.preservePause, paused);
    assert.equal(options.chapterState, null);
  });
}
