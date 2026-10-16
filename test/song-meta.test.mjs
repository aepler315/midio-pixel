import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePathMetadata,
  splitVersion,
  dedupeResults,
  formatLength,
} from '../tools/song-meta.mjs';

describe('splitVersion', () => {
  it('keeps instrumental as distinct', () => {
    const v = splitVersion('Midnight City (Instrumental)');
    assert.equal(v.baseTitle, 'Midnight City');
    assert.equal(v.versionKey, 'instrumental');
    assert.match(v.displayTitle, /Instrumental/);
  });

  it('keeps named remixes as distinct', () => {
    const v = splitVersion('One More Time (Daft Punk Remix)');
    assert.equal(v.baseTitle, 'One More Time');
    assert.match(v.versionKey, /^remix:/);
  });

  it('collapses remasters into original', () => {
    const v = splitVersion('Karma Police (2017 Remaster)');
    assert.equal(v.baseTitle, 'Karma Police');
    assert.equal(v.versionKey, 'original');
  });
});

describe('parsePathMetadata', () => {
  it('reads Artist/Album/Title from folder tree', () => {
    const m = parsePathMetadata(
      'Music/Radiohead/OK Computer/01 - Airbag.mp3',
      { size: 8_000_000, bitrate: 320 },
    );
    assert.equal(m.artist, 'Radiohead');
    assert.equal(m.album, 'OK Computer');
    assert.equal(m.baseTitle, 'Airbag');
    assert.ok(m.lengthSec > 0);
    assert.equal(formatLength(m.lengthSec), formatLength(m.lengthSec));
  });

  it('parses Artist - Title flat files', () => {
    const m = parsePathMetadata('Shared/Daft Punk - Around the World.flac');
    assert.equal(m.artist, 'Daft Punk');
    assert.equal(m.baseTitle, 'Around the World');
  });
});

describe('dedupeResults', () => {
  it('shows original + instrumental once each, drops dupe peers', () => {
    const items = [
      {
        artist: 'M83',
        title: 'Midnight City',
        baseTitle: 'Midnight City',
        versionKey: 'original',
        bitrate: 192,
        slots: true,
        ext: 'mp3',
        user: 'a',
      },
      {
        artist: 'M83',
        title: 'Midnight City',
        baseTitle: 'Midnight City',
        versionKey: 'original',
        bitrate: 320,
        slots: true,
        ext: 'mp3',
        user: 'b',
      },
      {
        artist: 'M83',
        title: 'Midnight City (Instrumental)',
        baseTitle: 'Midnight City',
        versionKey: 'instrumental',
        bitrate: 320,
        slots: true,
        ext: 'flac',
        user: 'c',
      },
      {
        artist: 'M83',
        title: 'Midnight City (Instrumental)',
        baseTitle: 'Midnight City',
        versionKey: 'instrumental',
        bitrate: 128,
        slots: false,
        ext: 'mp3',
        user: 'd',
      },
    ];
    const out = dedupeResults(items);
    assert.equal(out.length, 2);
    const keys = out.map((x) => x.versionKey).sort();
    assert.deepEqual(keys, ['instrumental', 'original']);
    // Best quality kept for original
    assert.equal(out.find((x) => x.versionKey === 'original').bitrate, 320);
  });
});
