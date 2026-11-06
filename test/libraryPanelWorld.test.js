import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryPanel } from '../src/ui/LibraryPanel.js';

// Exercise the pooled DOM rows without a browser or a layout engine. Events
// bubble so clicking the new field follows the panel's real delegated handler.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.title = '';
    this._textContent = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  closest(selector) {
    const matches = selector.startsWith('.')
      ? this.classList.contains(selector.slice(1))
      : selector === '[data-folder-path]' && this.dataset.folderPath != null;
    return matches ? this : this.parentElement?.closest(selector);
  }
  dispatch(type, details = {}) {
    const event = { target: this, preventDefault() {}, ...details };
    for (let node = this; node; node = node.parentElement) {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
    }
  }
  click() { this.dispatch('click'); }
}

const knownWorld = {
  label: 'World: Crater Lake',
  title: 'Landscape — Crater Lake · Experimental',
  state: 'known',
  viewId: 'crater-lake',
  biome: 'alpine',
  experimental: true,
};
const pendingWorld = {
  label: 'World: play to discover',
  title: 'Play this song to discover its world.',
  state: 'pending',
  viewId: null,
  biome: null,
  experimental: false,
};

function makePanel(t, options = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.document = { createElement: tagName => new Element(tagName) };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  return new LibraryPanel({
    root: new Element('div'),
    describeWorld: record => record ? knownWorld : pendingWorld,
    ...options,
  });
}

function field(row, className) {
  return row.children.find(child => child.classList.contains(className));
}

function track(overrides = {}) {
  return {
    key: 'song', path: 'Music/Song.mp3', folder: 'Music', name: 'Song.mp3',
    title: 'Song', artist: 'The Artist', album: 'The Album', durationSec: 125,
    songWorld: { viewId: 'crater-lake' }, ...overrides,
  };
}

test('song rows show the supplied world and preserve song metadata', t => {
  const calls = [];
  const panel = makePanel(t, { describeWorld: record => { calls.push(record); return knownWorld; } });
  const song = track();
  panel.setTracks([song]);
  const row = panel._rowPool[0];
  const world = field(row, 'libraryRowWorld');
  assert.deepEqual(calls, [song.songWorld]);
  assert.equal(world?.textContent, 'World: Crater Lake');
  assert.equal(world.title, knownWorld.title);
  assert.equal(world.classList.contains('isExperimental'), true);
  assert.equal(world.classList.contains('isPending'), false);
  assert.equal(world.classList.contains('hidden'), false);
  assert.equal(field(row, 'libraryRowTitle').textContent, 'Song');
  assert.equal(field(row, 'libraryRowArtist').textContent, 'The Artist');
  assert.equal(field(row, 'libraryRowAlbum').textContent, 'The Album');
  assert.equal(field(row, 'libraryRowTime').textContent, '2:05');
});

test('a recycled unanalysed song replaces the previous world and tooltip', t => {
  const panel = makePanel(t);
  panel.setTracks([track()]);
  const row = panel._rowPool[0];
  panel.setTracks([track({ key: 'pending', path: 'New.mp3', songWorld: undefined })]);
  const world = field(row, 'libraryRowWorld');
  assert.equal(panel._rowPool[0], row);
  assert.equal(world.textContent, 'World: play to discover');
  assert.equal(world.title, pendingWorld.title);
  assert.equal(world.classList.contains('isPending'), true);
  assert.equal(world.classList.contains('isExperimental'), false);
  assert.equal(row.title, 'New.mp3');
  panel.setTracks([track()]);
  assert.equal(world.textContent, 'World: Crater Lake');
  assert.equal(world.classList.contains('isPending'), false);
});

test('folder recycling clears world, song tooltip, and tag styles before restoring a song', t => {
  const panel = makePanel(t);
  panel.setTracks([track({ album: '', tagSource: 'auto' })]);
  const row = panel._rowPool[0];
  const world = field(row, 'libraryRowWorld');
  panel.view = 'folders';
  panel.render();
  assert.equal(panel._rowPool[0], row);
  assert.equal(row.dataset.folderPath, 'Music');
  assert.equal(row.classList.contains('isFolder'), true);
  assert.equal(row.classList.contains('isAutoTagged'), false);
  assert.equal(field(row, 'libraryRowAlbum').classList.contains('isPath'), false);
  assert.equal(row.title, 'Music');
  assert.equal(world.textContent, '');
  assert.equal(world.title, '');
  assert.equal(world.classList.contains('hidden'), true);
  assert.equal(world.classList.contains('isPending'), false);
  assert.equal(world.classList.contains('isExperimental'), false);
  row.click();
  assert.equal(panel.folder, 'Music');
  assert.equal(panel._rowPool[0], row);
  assert.equal(row.dataset.folderPath, undefined);
  assert.equal(row.classList.contains('isFolder'), false);
  assert.equal(world.classList.contains('hidden'), false);
  assert.equal(world.textContent, 'World: Crater Lake');
});

test('world labels retain click and keyboard activation through row reuse', t => {
  const played = [];
  const panel = makePanel(t, { onPlay: song => played.push(song) });
  const original = track();
  panel.setTracks([original]);
  const row = panel._rowPool[0];
  field(row, 'libraryRowWorld').click();
  let prevented = 0;
  row.dispatch('keydown', { key: 'Enter', preventDefault() { prevented++; } });
  const replacement = track({ key: 'replacement', songWorld: null });
  panel.setTracks([replacement]);
  row.dispatch('keydown', { key: ' ', preventDefault() { prevented++; } });
  assert.deepEqual(played, [original, original, replacement]);
  assert.equal(prevented, 2);
  assert.equal(row.tabIndex, 0);
  assert.equal(row.getAttribute('role'), 'listitem');
});
