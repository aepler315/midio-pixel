// Summarize a V8 .cpuprofile (node --cpu-prof, or the profiles
// tools/range-frame-cost.mjs and tools/range-live-callbacks.mjs save): self
// time by function, and the inclusive time of named functions.
//
//   node tools/cpuprofile-top.mjs file.cpuprofile [--top 25] [--inclusive name,name,...]
//
// A profile says where this host's main thread spent its samples. Shares
// between functions carry to other CPUs far better than milliseconds do.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Self milliseconds by "function file:line", and inclusive milliseconds of
 *  the functions named in `inclusive` (outermost frame counts once). */
export function summarizeProfile(profile, { inclusive = [] } = {}) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
  const label = (n) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const functions = new Map();
  let totalMs = 0;
  for (const [id, us] of self) {
    const key = label(byId.get(id));
    functions.set(key, (functions.get(key) || 0) + us / 1000);
    totalMs += us / 1000;
  }
  const parent = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parent.set(child, n.id);
  const named = new Map(inclusive.map((name) => [name, 0]));
  for (const [id, us] of self) {
    const seen = new Set();
    for (let at = id; at != null; at = parent.get(at)) {
      const name = byId.get(at).callFrame.functionName;
      if (named.has(name) && !seen.has(name)) { seen.add(name); named.set(name, named.get(name) + us / 1000); }
    }
  }
  return { totalMs, self: [...functions].sort((a, b) => b[1] - a[1]), inclusive: [...named].sort((a, b) => b[1] - a[1]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
  const file = args.find((a, i) => !a.startsWith('--') && !['--top', '--inclusive'].includes(args[i - 1]));
  if (!file) { console.error('usage: cpuprofile-top.mjs file.cpuprofile [--top 25] [--inclusive name,name,...]'); process.exit(1); }
  const summary = summarizeProfile(JSON.parse(fs.readFileSync(file, 'utf8')), { inclusive: option('--inclusive', '').split(',').filter(Boolean) });
  const row = ([name, ms]) => `${ms.toFixed(0).padStart(8)} ms ${(100 * ms / summary.totalMs).toFixed(1).padStart(5)}%  ${name}`;
  console.log(`total ${summary.totalMs.toFixed(0)} ms sampled`);
  for (const entry of summary.self.slice(0, Number(option('--top', 25)))) console.log(row(entry));
  if (summary.inclusive.length) console.log(`inclusive:\n${summary.inclusive.map(row).join('\n')}`);
}
