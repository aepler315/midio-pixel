// SoulseekSearch on a static host (GitHub Pages): /api/soulseek/* doesn't
// exist there, so the panel must hide itself instead of announcing
// "Server unreachable" to a visitor who never ran a server. See
// SoulseekSearch._setUnavailable() for the fix this covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  _data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
};

function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function fakeRoot() {
  const divider = { classList: fakeClassList() };
  const root = {
    classList: fakeClassList(),
    querySelector: (sel) => (sel === '.slskDivider' ? divider : null),
    parentElement: null,
  };
  root.parentElement = { querySelector: (sel) => (sel === '.slskDivider' ? divider : null) };
  return { root, divider };
}

const { SoulseekSearch } = await import('../src/soulseek/SoulseekSearch.js');

test('a 404 status response marks the bridge unavailable and hides the panel', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const { root, divider } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.unavailable, true);
  assert.ok(root.classList.contains('hidden'), 'the panel itself should be hidden');
  assert.ok(divider.classList.contains('hidden'), 'the "or load your own file" divider should be hidden too');
});

test('a 405 status response is treated the same as a missing route', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 405 });
  const { root } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.unavailable, true);
});

test('a thrown fetch (connection refused) is treated the same as a 404', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const { root } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.unavailable, true);
  assert.ok(root.classList.contains('hidden'));
});

test('unavailable never sets the old "Server unreachable" developer message', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const { root } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.status.note, '', 'no developer-facing note should be shown for a missing bridge');
});

test('a real bridge response (200 JSON) leaves the panel visible and unavailable false', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ mode: 'free', connected: true, needsLogin: false, note: 'Free music ready.' }),
  });
  const { root } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.unavailable, false);
  assert.ok(!root.classList.contains('hidden'));
  assert.equal(s.status.mode, 'free');
});

test('search() is a no-op once the bridge has been marked unavailable', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const { root } = fakeRoot();
  const s = new SoulseekSearch({ root, onFiles: () => {} });
  await s.refreshStatus();
  assert.equal(s.unavailable, true);

  let searchWasAttempted = false;
  globalThis.fetch = async () => { searchWasAttempted = true; return { ok: true, status: 200, json: async () => ({}) }; };
  await s.search('some song');
  assert.equal(searchWasAttempted, false, 'search must not hit the network once marked unavailable');
});
