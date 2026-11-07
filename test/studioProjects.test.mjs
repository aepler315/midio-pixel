import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioProjects, STUDIO_STORAGE_KEY, MAX_STUDIO_BYTES } from '../src/studio/StudioProjects.js';

const candidate = (id, signature = `sig-${id}`) => ({ id, signature, camera: { eye: { lon: -115, lat: 44, aboveGroundM: 150 }, headingDeg: 90, pitchDeg: 0, hfovDeg: 55 } });
const a = candidate('a');
const b = candidate('b');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
const create = (options = {}) => new StudioProjects({ candidates: [a, b], storage: storage(), ...options });

// Rejecting a corrupt envelope must never erase the user's current edits.
test('malformed or oversized imports leave existing work intact', () => {
  const projects = create();
  projects.edit(a, { headingDeg: 120 });
  projects.savePreset(a, 'North ridge');
  const before = projects.snapshot();
  for (const raw of ['{broken', null, {}, { schema: 'midio.terrain-studio', version: 2, drafts: [], presets: [] }, '{'.repeat(MAX_STUDIO_BYTES + 1)]) {
    assert.throws(() => projects.import(raw));
    assert.deepEqual(projects.snapshot(), before);
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => projects.import(cycle));
  assert.deepEqual(projects.snapshot(), before);
});

test('drafts and named presets round trip with exact source signatures', () => {
  const local = storage();
  const projects = create({ storage: local });
  projects.edit(a, { headingDeg: 120, aboveGroundM: 300 });
  const preset = projects.savePreset(a, '  North ridge  ');
  assert.equal(preset.name, 'North ridge');
  assert.equal(preset.candidateId, 'a');
  assert.equal(preset.signature, a.signature);
  assert.ok(local.values.has(STUDIO_STORAGE_KEY));
  const again = create({ storage: local });
  assert.equal(again.load().warning, '');
  assert.equal(again.draft('a').headingDeg, 120);
  assert.equal(again.presets('a').length, 1);
  again.edit(a, { headingDeg: 160 });
  assert.equal(again.applyPreset(preset.id, a).headingDeg, 120);
  assert.throws(() => again.applyPreset(preset.id, b), /source|candidate/i);
  const changed = create({ candidates: [candidate('a', 'new-source'), b] });
  const report = changed.import(projects.snapshot());
  assert.equal(report.accepted, 0);
  assert.equal(report.ignored, 2);
  assert.equal(changed.presets().length, 0);
  assert.equal(changed.draft('a').headingDeg, 90);
});

test('locks survive save/import and prevent edits to only the locked fields', () => {
  const projects = create();
  assert.deepEqual(projects.toggleLock(a, 'headingDeg'), ['headingDeg']);
  projects.edit(a, { headingDeg: 120, aboveGroundM: 275 });
  assert.equal(projects.draft(a).headingDeg, 90);
  assert.equal(projects.draft(a).aboveGroundM, 275);
  assert.throws(() => projects.toggleLock(a, '__proto__'));
  const preset = projects.savePreset(a, 'Locked bearing');
  const copy = create();
  assert.deepEqual(copy.import(JSON.stringify(projects.snapshot())), { accepted: 2, ignored: 0 });
  assert.deepEqual(copy.locks(a), ['headingDeg']);
  copy.toggleLock(a, 'headingDeg');
  copy.applyPreset(preset.id, a);
  assert.deepEqual(copy.locks(a), ['headingDeg']);
  assert.deepEqual(copy.toggleLock(a, 'headingDeg'), []);
});

test('coalesced edits undo in one step and keep candidates independent', () => {
  const projects = create();
  projects.edit(a, { headingDeg: 100 });
  projects.edit(a, { headingDeg: 110 }, { coalesce: true });
  projects.edit(a, { headingDeg: 120 }, { coalesce: true });
  projects.edit(b, { headingDeg: 45 });
  assert.equal(projects.undo(a).headingDeg, 90);
  assert.equal(projects.canUndo(a), false);
  assert.equal(projects.draft(b).headingDeg, 45);
  assert.equal(projects.canRedo(a), true);
  assert.equal(projects.redo(a).headingDeg, 120);
  projects.undo(a);
  projects.edit(a, { pitchDeg: 10 });
  assert.equal(projects.canRedo(a), false);
  assert.equal(projects.undo(a).pitchDeg, 0);
  assert.equal(projects.undo(a).headingDeg, 90);
});

test('undo history is bounded while no-op edits do not consume steps', () => {
  const projects = create();
  for (let i = 1; i <= 80; i++) projects.edit(a, { aboveGroundM: 150 + i });
  let undos = 0;
  while (projects.canUndo(a)) { projects.undo(a); undos++; }
  assert.equal(undos, 60);
  assert.equal(projects.draft(a).aboveGroundM, 170);
  projects.edit(a, { aboveGroundM: 170 });
  assert.equal(projects.canUndo(a), false);
});

test('a final unchanged edit closes a coalesced drag without adding history', () => {
  const projects = create();
  projects.edit(a, { headingDeg: 100 }, { coalesce: true });
  projects.edit(a, { headingDeg: 110 }, { coalesce: true });
  projects.edit(a, { headingDeg: 110 });
  projects.edit(a, { headingDeg: 120 }, { coalesce: true });
  assert.equal(projects.undo(a).headingDeg, 110);
  assert.equal(projects.undo(a).headingDeg, 90);
});

test('editing above-ground height replaces authored absolute height and undo restores it', () => {
  const authored = { ...a, camera: { ...a.camera, eye: { ...a.camera.eye, heightM: 2100 } } };
  const projects = create({ candidates: [authored] });
  assert.equal(projects.draft(authored).heightM, 2100);
  assert.equal('heightM' in projects.edit(authored, { aboveGroundM: 400 }), false);
  assert.equal(projects.undo(authored).heightM, 2100);
});

test('quota and unavailable storage warn without disabling portable projects', () => {
  const projects = create({ storage: { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota exceeded'); } } });
  assert.match(projects.load().warning, /local|storage|sav/i);
  projects.edit(a, { headingDeg: 115 });
  assert.equal(projects.save(), false);
  assert.match(projects.warning, /quota|storage|sav/i);
  const copy = create({ storage: null });
  assert.equal(copy.import(projects.snapshot()).accepted, 1);
  assert.equal(copy.draft(a).headingDeg, 115);
  assert.equal(copy.save(), false);
  assert.match(copy.warning, /local|storage|sav/i);
});

test('imports strip unknown fields and skip invalid or stale records', () => {
  const projects = create();
  const settings = projects.draft(a);
  const raw = { schema: 'midio.terrain-studio', version: 1, approval: true, drafts: [
    { candidateId: 'a', signature: a.signature, settings: { ...settings, approved: true }, locks: ['headingDeg', 'approved'] },
    { candidateId: 'b', signature: b.signature, settings: { ...settings, headingDeg: 'bad' }, locks: [] },
    { candidateId: 'missing', signature: 'sig-missing', settings, locks: [] },
  ], presets: [] };
  assert.deepEqual(projects.import(raw), { accepted: 1, ignored: 2 });
  const saved = projects.snapshot();
  assert.equal('approval' in saved, false);
  assert.equal('approved' in saved.drafts[0].settings, false);
  assert.deepEqual(saved.drafts[0].locks, ['headingDeg']);
});

test('returned settings and presets cannot mutate stored work', () => {
  const projects = create();
  const settings = projects.draft(a);
  settings.headingDeg = 0;
  assert.equal(projects.draft(a).headingDeg, 90);
  const preset = projects.savePreset(a, 'Original');
  preset.settings.headingDeg = 0;
  const list = projects.presets();
  list[0].settings.headingDeg = 1;
  assert.equal(projects.presets()[0].settings.headingDeg, 90);
  assert.equal(projects.deletePreset(preset.id), true);
  assert.equal(projects.deletePreset(preset.id), false);
  assert.equal(projects.presets().length, 0);
});

test('import cannot replace a preset with the same ID from a different source', () => {
  const projects = create();
  const preset = projects.savePreset(a, 'Keep this ridge');
  const other = create();
  const differentSource = { ...other.savePreset(b, 'Another ridge'), id: preset.id };
  const report = projects.import({ schema: 'midio.terrain-studio', version: 1, drafts: [], presets: [differentSource] });
  assert.deepEqual(report, { accepted: 0, ignored: 1 });
  assert.deepEqual(projects.presets(), [preset]);
});
