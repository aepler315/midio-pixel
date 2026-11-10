// Which mountain did each part of the song build? (Song range composition,
// Phase 4.) Reads a landscape review run's per-frame range snapshots
// (RangePresentation songRange.rise) and logs, section by section as the app
// detected them, how far each slot of the composed stage climbed, beside the
// generator's intended form when a <song>.form.json sidecar is given.
//
//   node tools/song-range-slot-log.mjs <review-dir> [--form song.form.json] [--out FILE]
//
// The log reports what the running app drew; it judges nothing.
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
if (!dir) throw new Error('usage: song-range-slot-log.mjs <review-dir> [--form FILE] [--out FILE]');
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

const sub = (await fs.readdir(dir, { withFileTypes: true })).find((d) => d.isDirectory());
const report = await readJson(path.join(dir, sub.name, 'report.json'));
const form = opt('--form') ? await readJson(opt('--form')) : null;
const frames = report.songs[0].frames.map((f) => ({ t: f.timeMs, rise: f.range?.songRange?.rise, view: f.range?.viewId, state: f.range?.songRange?.state }))
  .filter((f) => f.rise?.slotRise01);
if (!frames.length) throw new Error('no frame carries a composed stage rise (was the run --song-range force?)');
const slots = Object.keys(frames[0].rise.slotRise01);
const labels = frames.at(-1).rise.labels;
const mode = frames.at(-1).rise.mode;
const intended = (t) => form?.sections.findLast((s) => s.startMs <= t)?.kind ?? null;

// Group consecutive frames by the detected section heard.
const spans = [];
for (const f of frames) {
  const s = f.rise.section, key = s ? `${s.startMs}:${s.label}` : 'none';
  const last = spans.at(-1);
  if (last?.key === key) { last.end = f; continue; }
  spans.push({ key, section: s, start: f, end: f });
}
const pct = (v) => `${Math.round(v * 100)}`.padStart(3);
const lines = [];
lines.push(`# Slot log: ${path.basename(dir)}`, '');
lines.push(`Stage ${frames[0].view} (${frames[0].state}), schedule mode **${mode}**. Frames: ${frames.length}, ${frames[0].t / 1000}-${frames.at(-1).t / 1000} s.`, '');
lines.push('Labels each slot climbs in:', '');
for (const id of slots) lines.push(`- ${id}: ${labels[id]?.length ? labels[id].join(', ') : '(staggered from the scalar curve)'}`);
lines.push('', 'Rise is percent of full relief at the start and end of each detected section; "climbing" lists slots that gained at least 2 points within it.', '');
lines.push(`| detected section | label | intended (sidecar) | ${slots.join(' | ')} | climbing |`);
lines.push(`| --- | --- | --- | ${slots.map(() => '---').join(' | ')} | --- |`);
for (const sp of spans) {
  const a = sp.start.rise.slotRise01, b = sp.end.rise.slotRise01, s = sp.section;
  const climbing = slots.filter((id) => b[id] - a[id] >= 0.02);
  const when = s ? `${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)} s` : `${sp.start.t / 1000} s`;
  lines.push(`| ${when} | ${s?.label ?? '-'} | ${intended(s?.startMs ?? sp.start.t) ?? '-'} | ${slots.map((id) => `${pct(a[id])}→${pct(b[id])}`).join(' | ')} | ${climbing.join(' ') || '-'} |`);
}
const text = `${lines.join('\n')}\n`;
const out = opt('--out') || path.join(dir, 'slot-log.md');
await fs.writeFile(out, text);
process.stdout.write(text);
