import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';
import { sampleWorldMusic } from '../src/world/WorldMusic.js';
import {
  boundaryLift01, motifTrust, bayLit, bayAlpha,
} from '../src/world/nave/Resonance.js';

const chorus = {
  meanEnergy: 0.82, relEnergy01: 0.95, startMs: 60000, endMs: 90000,
  provenance: 'detected', label: 1,
};
const verse = {
  meanEnergy: 0.48, relEnergy01: 0.5, startMs: 30000, endMs: 60000,
  provenance: 'detected', label: 0,
};
const chorusReturn = { ...chorus, startMs: 120000, endMs: 150000 };

test('a returning label lights the same bays', () => {
  const first = [0, 1, 2, 3].map((b) => bayLit(chorus.label, b));
  const again = [0, 1, 2, 3].map((b) => bayLit(chorusReturn.label, b));
  assert.deepEqual(again, first);
  const verseBays = [0, 1, 2, 3].map((b) => bayLit(verse.label, b));
  assert.notDeepEqual(verseBays, first);
  assert.ok(first.some(Boolean) && first.some((v) => !v), 'a motif is a pattern, not every bay or none');
});

test('decorative cuts and missing labels do not invent a chorus', () => {
  assert.equal(motifTrust({ provenance: 'decorative', label: 1 }), 0);
  assert.equal(motifTrust({ provenance: 'detected' }), 0);
  assert.equal(motifTrust(null), 0);
  assert.equal(motifTrust(chorus), 1);
  assert.equal(motifTrust({ ...chorus, provenance: 'inferred' }), 0.5);
  const broad = [0, 1, 2, 3].map((i) => bayAlpha({ trust: 0, lit: i === 0, bass: 0.4, reveal: 1 }));
  assert.ok(broad.every((a) => Math.abs(a - broad[0]) < 1e-9), 'broad phrasing treats every bay the same');
});

test('bass raises every bay; a phrase opening only lifts the motif', () => {
  const trust = motifTrust(chorus);
  const quietLit = bayAlpha({ trust, lit: true, bass: 0.1, reveal: 0 });
  const loudLit = bayAlpha({ trust, lit: true, bass: 0.8, reveal: 0 });
  const loudDark = bayAlpha({ trust, lit: false, bass: 0.8, reveal: 0 });
  assert.ok(loudLit > quietLit, 'resonance follows bass');
  assert.ok(loudLit > loudDark, 'unlit bays stay the quiet stone');
  const lift = boundaryLift01(chorus, verse);
  const opened = bayAlpha({
    trust, lit: true, bass: 0.4,
    reveal: sampleWorldMusic({ nowMs: 62000, section: chorus }).reveal * lift,
  });
  const unopened = bayAlpha({
    trust, lit: false, bass: 0.4,
    reveal: sampleWorldMusic({ nowMs: 62000, section: chorus }).reveal * lift,
  });
  assert.ok(opened > unopened + 0.2, `motif bay ${opened.toFixed(3)} vs neighbour ${unopened.toFixed(3)}`);
});

test('a single energy sample cannot flash the glass', () => {
  const burst = new EnergyCurves(4000, 50);
  const low = new EnergyCurves(4000, 50);
  for (let i = 0; i < low.n; i++) {
    low.setFrame(i, [0.8, 0.8, 0, 0, 0, 0, 0]);
    burst.setFrame(i, [i === 100 ? 1 : 0, i === 100 ? 1 : 0, 0, 0, 0, 0, 0]);
  }
  const held = sampleWorldMusic({ nowMs: 2000, energyCurves: low }).bass;
  const tap = sampleWorldMusic({ nowMs: 2000, energyCurves: burst }).bass;
  const heldBay = bayAlpha({ trust: 0, bass: held });
  const tapBay = bayAlpha({ trust: 0, bass: tap });
  assert.ok(heldBay > tapBay * 1.4, `sustained glass ${heldBay.toFixed(3)} vs kick ${tapBay.toFixed(3)}`);
});

test('seeking back to a chorus restores that chorus, and junk stays in range', () => {
  const args = { trust: 1, lit: true, bass: 0.4, reveal: 0.8 };
  const first = bayAlpha(args);
  for (let i = 0; i < 20; i++) bayAlpha({ trust: 1, lit: true, bass: 1, reveal: 1 });
  assert.equal(bayAlpha(args), first);
  for (const v of [0, 1, -1, 9, NaN]) {
    const a = bayAlpha({ trust: v, lit: true, bass: v, reveal: v });
    assert.ok(a >= 0 && a <= 1, `alpha ${a}`);
  }
});
