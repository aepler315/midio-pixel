import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FrameCadence } from '../src/render/FrameCadence.js';
const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
test('title scheduler exists when the actual boot call starts the backdrop', () => {
  const declaration='const titleCadence = new FrameCadence();', call='startTitleBackdrop();';
  const fn=main.slice(main.indexOf('function startTitleBackdrop()'),main.indexOf('function stopTitleBackdrop()'));
  const boot=[declaration,call].sort((a,b)=>main.indexOf(a)-main.indexOf(b)).join('\n');
  let requests=0;
  assert.doesNotThrow(()=>vm.runInNewContext(`${fn}\n${boot}`,{FrameCadence,titleRafHandle:null,titleFrame(){},requestAnimationFrame(){requests++;return 1;}}));
  assert.equal(requests,1);
});
