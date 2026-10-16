import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK, AUTO, TITLE_WORLD_KEY, readTitleWorld, resolveTitleWorldChoice, writeTitleWorld,
} from '../src/ui/TitleWorldChoice.js';

const worlds = ['alpine', 'nave', 'fathom'];

test('a world picked on the title screen starts the song in it', () => {
  assert.deepEqual(resolveTitleWorldChoice('nave', worlds), { mode: 'world', id: 'nave' });
});

test('"Choose for me" and the default keep their meanings', () => {
  assert.deepEqual(resolveTitleWorldChoice(AUTO, worlds), { mode: AUTO });
  assert.deepEqual(resolveTitleWorldChoice(ASK, worlds), { mode: ASK });
  assert.deepEqual(resolveTitleWorldChoice(null, worlds), { mode: ASK });
});

test('a remembered world that no longer exists falls back to the picker', () => {
  assert.deepEqual(resolveTitleWorldChoice('retired-world', worlds), { mode: ASK });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('the choice is remembered', () => {
  const store = memoryStorage();
  assert.equal(readTitleWorld(store), ASK, 'nothing stored yet');
  writeTitleWorld('fathom', store);
  assert.equal(store.m.get(TITLE_WORLD_KEY), 'fathom');
  assert.equal(readTitleWorld(store), 'fathom');
});

test('storage that throws never breaks the title screen', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readTitleWorld(broken), ASK);
  assert.doesNotThrow(() => writeTitleWorld('nave', broken));
  assert.equal(readTitleWorld(null), ASK);
});
