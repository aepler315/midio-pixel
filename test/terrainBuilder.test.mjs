import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test('a generic terrain build touches only its requested JSON output', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terrain-builder-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // fileURLToPath, not URL.pathname: on Windows the pathname is "/V:/..." and
  // path.resolve then prefixes the drive again ("V:\V:\...").
  const repo = fileURLToPath(new URL('..', import.meta.url));
  await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src/world'), { recursive: true });
  await fs.copyFile(path.join(repo, 'tools/build-terrain-profile.mjs'), path.join(dir, 'tools/build-terrain-profile.mjs'));
  await fs.cp(path.join(repo, 'src/world/terrain'), path.join(dir, 'src/world/terrain'), { recursive: true });
  const gridPath = path.join(dir, 'grid.json');
  const outPath = path.join(dir, 'out.json');
  const sentinel = path.join(dir, 'src/world/terrain/tetonsFrontData.js');
  const elev = new Float32Array([
    1000, 1200, 1000,
    1100, 1800, 1100,
    1000, 1400, 1000,
  ]);
  await fs.writeFile(gridPath, JSON.stringify({
    west: -111, south: 43, east: -110.9, north: 43.1,
    width: 3, height: 3, cellM: 1000, spacingM: 500,
    distanceM: 2000, cameraElevM: 500, pastM: 500,
    smoothWindowM: 0, curvature: false,
    source: 'test fixture', elevB64: Buffer.from(elev.buffer).toString('base64'),
  }));
  await fs.writeFile(sentinel, 'unchanged\n');
  await exec(process.execPath, ['tools/build-terrain-profile.mjs', gridPath, outPath], { cwd: dir });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged\n');
  const built = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.equal(built.meta.source, 'test fixture');
  assert.match(built.meta.sourceChecksum, /^[a-f0-9]{64}$/);
});
