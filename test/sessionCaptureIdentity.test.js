import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sessionSongName } from '../src/audio/AudioSessionIdentity.js';
import { exportFileName } from '../src/render/VideoExport.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const finish = main.slice(main.indexOf('function finishRecording('), main.indexOf('\nfunction abortRecording('));

test('actual recording finalization keeps the captured source title across an asynchronous replacement', async () => {
  let settle;
  const stopped = new Promise(resolve => { settle = resolve; });
  const namesUsed = [], downloads = [], order = [];
  const context = vm.createContext({
    sessionSongName,
    songRecorder: { recording: true, stop(options) { assert.equal(options.drain, true); order.push('stop'); return stopped; } },
    pendingCaptureOptions: null, fullSongRecording: true,
    document: { getElementById: () => ({}) }, setTimeout() {},
    captureClock: { release() { order.push('release'); } }, audioEngine: { nowMs: 5000 },
    lastTimelineData: { sourceTrack: { title: 'Source A' }, lyricIdentity: { title: 'Tagged A' }, sourceFileName: 'a.wav' },
    lastSongName: 'legacy-a.wav', syncRecordUI() {}, setExportNote() {}, describeResult: () => 'recorded',
    exportFileName(options) { namesUsed.push(options.songName); return exportFileName(options); },
    downloadBlob(blob, name) { downloads.push({ blob, name }); },
    showErrorBanner(message) { assert.fail(message); }, console,
  });
  vm.runInContext(finish, context);
  context.finishRecording();
  context.lastTimelineData = { sourceTrack: { title: 'Source B' } };
  context.lastSongName = 'legacy-b.wav';
  const blob = {};
  settle({ blob, preset: { id: 'landscape-720' }, candidate: { ext: 'mp4' }, codec: 'H.264' });
  await new Promise(setImmediate);
  assert.deepEqual(order, ['release', 'stop']);
  assert.deepEqual(namesUsed, ['Source A']);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].blob, blob);
  assert.match(downloads[0].name, /Source.A/);
});
