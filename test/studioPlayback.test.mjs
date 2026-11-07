import test from 'node:test';
import assert from 'node:assert/strict';
import { studioSongProgress } from '../src/studio/StudioPlayback.js';
test('studio motion uses song duration and bounds replay, seeks and invalid clock input',()=>{
  assert.equal(studioSongProgress(45000,90000),.5);
  assert.equal(studioSongProgress(90000,90000),1);
  assert.equal(studioSongProgress(180000,90000),1);
  assert.equal(studioSongProgress(-1,90000),0);
  assert.equal(studioSongProgress(NaN,90000),0);
  assert.equal(studioSongProgress(15000,0,30),.5);
});
