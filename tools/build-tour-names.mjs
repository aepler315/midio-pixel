// Stream/filter the GeoNames US dump for Teton Song Highway authoring.
// GeoNames: https://www.geonames.org/, CC BY 4.0; see NOTICE.
//   node tools/build-tour-names.mjs [--input US.txt|US.zip] [--out FILE]
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { transformTourCoordinates } from './lib/tour-coordinates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://download.geonames.org/export/dump/US.zip';
const CODES = new Set(['PK', 'PKS', 'MT', 'MTS', 'LK', 'LKS', 'GAP', 'PASS', 'VAL']);

export function parseTourName(line, [west, south, east, north]) {
  const f = line.split('\t');
  if (f.length < 17 || !CODES.has(f[7]) || !['T', 'H'].includes(f[6])) return null;
  const lon = Number(f[5]), lat = Number(f[4]);
  if (!f[4] || !f[5] || !Number.isFinite(lon) || !Number.isFinite(lat)
    || lon < west || lon > east || lat < south || lat > north || !f[1].trim()) return null;
  const elevation = [f[15], f[16]].filter(s => s.trim() !== '').map(Number).find(n => Number.isFinite(n) && n !== -9999);
  return { id: f[0], name: f[1].trim(), featureCode: f[7], lonLat: [lon, lat], elevationM: elevation ?? null };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function buildTourNames({
  input = null, out = path.join(root, 'data/terrain/teton-tour-names.json'),
  authoring = path.join(root, 'data/terrain/teton-tour.json'), log = console.log,
} = {}) {
  const view = JSON.parse(await fs.readFile(authoring, 'utf8')), dem = view.dem;
  const offsets = [];
  for (let i = 0; i <= 32; i++) {
    const x = (i / 32 - .5) * dem.extentM[0], z = (i / 32 - .5) * dem.extentM[1];
    offsets.push([x, -dem.extentM[1] / 2], [x, dem.extentM[1] / 2], [-dem.extentM[0] / 2, z], [dem.extentM[0] / 2, z]);
  }
  const envelope = await transformTourCoordinates(offsets, { centerLonLat: dem.centerLonLat, inverse: true });
  const bbox = [Math.min(...envelope.map(p => p[0])) - .002, Math.min(...envelope.map(p => p[1])) - .002,
    Math.max(...envelope.map(p => p[0])) + .002, Math.max(...envelope.map(p => p[1])) + .002];
  if (!input) {
    const dir = path.join(root, '.terrain-cache/geonames');
    await fs.mkdir(dir, { recursive: true });
    input = path.join(dir, 'US.zip');
    try { await fs.access(input); } catch {
      log('Downloading GeoNames US dump');
      const partial = `${input}.part`;
      execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180', '--output', partial, URL], { timeout: 190000 });
      // Validate before caching; an HTTP failure cannot become a usable dump.
      execFileSync('unzip', ['-tq', partial], { timeout: 20000 });
      await fs.rename(partial, input);
    }
  }
  let stream, finished = Promise.resolve();
  if (input.toLowerCase().endsWith('.zip')) {
    const child = spawn('unzip', ['-p', input, 'US.txt']);
    stream = child.stdout;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`GeoNames unzip failed: ${stderr}`)));
    });
    // Mark the rejection handled while the stream is being consumed.
    finished.catch(() => {});
  } else stream = createReadStream(input);
  const rows = new Map();
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    const row = parseTourName(line, bbox);
    if (row) rows.set(row.id, row);
  }
  await finished;
  const names = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const local = await transformTourCoordinates(names.map(n => n.lonLat), { centerLonLat: dem.centerLonLat });
  const selected = names.map((n, i) => ({ ...n, localM: local[i] })).filter(n => Math.abs(n.localM[0]) <= dem.extentM[0] / 2 && Math.abs(n.localM[1]) <= dem.extentM[1] / 2);
  const result = { schema: 'midio.tour-names', version: 1, centerLonLat: dem.centerLonLat,
    extentM: dem.extentM, names: selected, provenance: {
      provider: 'GeoNames', license: 'CC BY 4.0', url: URL, inputFile: path.basename(input),
      sha256: await hashFile(input), builtAt: new Date().toISOString(),
    } };
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n');
  log(`Wrote ${selected.length} GeoNames features to ${out}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--help') { console.log('node tools/build-tour-names.mjs [--input US.txt|US.zip] [--out FILE] [--authoring FILE]'); process.exit(0); }
      if (!['--input', '--out', '--authoring'].includes(arg)) throw new Error(`unknown option ${arg}`);
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    }
    await buildTourNames(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
