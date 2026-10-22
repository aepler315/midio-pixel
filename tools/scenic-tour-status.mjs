// The per-region completion table for scenic shot tours (docs/scenic-tours.md):
// for every approved view, its tour support in the shipped catalog, the
// library and terrain cost from its last build (.smoke/scenic-tours/<id>/
// fit.json), and its rendered verification record, if any (a JSON map
// viewId -> { status, evidence, notes } passed with --verification).
//
//   node tools/scenic-tour-status.mjs [--verification verification.json] [--markdown]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../src/world/terrain/sceneCatalogData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };

export async function statusRows({ verification = {} } = {}) {
  const config = await readJson(path.join(root, 'data', 'terrain', 'scenic-tours.json'));
  const rows = [];
  for (const v of catalog.views.filter((x) => x.status === 'approved' || config.regions[x.id])) {
    if (!config.regions[v.id]) continue;
    const fit = await readJson(path.join(root, '.smoke', 'scenic-tours', v.id, 'fit.json'));
    const shipped = v.shotsManifestUrl ? await readJson(path.join(root, 'src', 'assets', 'range', 'v2', v.shotsManifestUrl)) : null;
    const check = verification[v.id] || {};
    rows.push({
      view: v.id, biome: v.biome, title: v.title, landform: config.regions[v.id].landform, catalogStatus: v.status,
      tour: shipped ? (v.status === 'approved' ? 'approved' : 'candidate') : 'rail only',
      shots: shipped?.shots.length ?? fit?.shots ?? null, links: shipped?.links.length ?? fit?.links ?? null,
      terrain: fit ? (fit.bake.rebaked ? `re-culled ${fit.bake.budget.shippedTiles}->${fit.bake.budget.tiles} tiles, +${Math.round(fit.bake.budget.addedBytes / 1024)} KiB` : 'shipped package covers it') : 'not built',
      triangles: fit?.bake.budget ? `${(fit.bake.budget.desktopTriangles / 1e6).toFixed(2)} M / ${(fit.bake.budget.mobileTriangles / 1e6).toFixed(2)} M` : null,
      budget: fit ? (fit.failed ? 'over' : 'within') : null, validation: fit ? (fit.bake.validation.ok ? 'no holes, LOD ok' : `${fit.bake.validation.holes} holed poses`) : null,
      rendered: check.status || 'not verified', evidence: check.evidence || null, notes: check.notes || config.regions[v.id].blocker || null,
    });
  }
  return rows;
}

export function markdown(rows) {
  const head = '| View | Landform | Tour | Shots / links | Terrain | Desktop / mobile triangles | Rendered verification | Notes |\n|---|---|---|---|---|---|---|---|';
  return [head, ...rows.map((r) => `| ${r.view} (${r.biome}) | ${r.landform} | ${r.tour} | ${r.shots ?? '-'} / ${r.links ?? '-'} | ${r.terrain} | ${r.triangles ?? '-'} | ${r.evidence ? `[${r.rendered}](${r.evidence})` : r.rendered} | ${r.notes ?? ''} |`)].join('\n');
}

async function main() {
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const verification = opt('--verification') ? await readJson(path.resolve(opt('--verification'))) : {};
  const rows = await statusRows({ verification });
  if (args.includes('--markdown')) console.log(markdown(rows));
  else console.log(JSON.stringify(rows, null, 1));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
