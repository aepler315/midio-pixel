// Full-application reference/warp pilot. Evidence stays in a new directory.
// node tools/material-feature-compare.mjs --out .smoke/material-<run>
//   [--browser /usr/bin/chromium] [--audio song.wav] [--view ID]
//   [--times 12000,24000] [--frames 60] [--hardware-gpu]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot, sha256 } from './lib/visual-evaluation-server.mjs';
import { openEvaluationSong, renderEvaluationFrame } from './lib/visual-evaluation-browser.mjs';
import { blankFrame } from './lib/visual-evaluation.mjs';
import { finalizeBrowserDiagnostics } from './lib/browser-diagnostics.mjs';
import { installPilotProbe, runPilotSteady, summarizePilotFrames, comparePilotPngs, readPilotTextureContent } from './lib/pilot-comparison.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFTWARE = /swiftshader|software|llvmpipe|softpipe|basic render driver|\bwarp\b/i;

export function parseMaterialFeatureArgs(argv) {
  const args = { out: null, audio: null, browser: process.env.PLAYWRIGHT_CHROMIUM_PATH || null,
    frames: 60, times: [12000, 24000], view: 'teton-jackson-lake', hardware: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--hardware-gpu') { args.hardware = true; continue; }
    const value = argv[++i]; assert.ok(value && !value.startsWith('--'), `missing value for ${key}`);
    if (['--out', '--audio', '--browser', '--view'].includes(key)) args[key.slice(2)] = value;
    else if (key === '--frames') args.frames = Number(value);
    else if (key === '--times') args.times = value.split(',').map(Number);
    else throw Error(`unknown argument ${key}`);
  }
  assert.ok(args.out, '--out NEW_DIRECTORY is required');
  assert.ok(Number.isInteger(args.frames) && args.frames >= 1 && args.frames <= 600, '--frames must be 1..600');
  assert.ok(args.times.length && args.times.every(t => Number.isFinite(t) && t >= 0), '--times must be nonnegative milliseconds');
  assert.equal(new Set(args.times).size, args.times.length, '--times must be unique');
  assert.ok(/^[a-z0-9-]+$/.test(args.view), 'invalid --view');
  args.times.sort((a, b) => a - b); return args;
}

export function assessMaterialFeatureExercise(uniforms) {
  assert.ok(Number.isFinite(uniforms?.uHasMaterial), 'missing or invalid material uniform');
  assert.ok(Array.isArray(uniforms.uLandRise) && uniforms.uLandRise.length === 2
    && uniforms.uLandRise.every(Number.isFinite) && uniforms.uLandRise[0] >= 0 && uniforms.uLandRise[0] <= 1, 'missing or invalid rise uniform');
  return { exercised: uniforms.uHasMaterial >= .5 && uniforms.uLandRise[0] < 1,
    materialized: uniforms.uHasMaterial >= .5, nonFlat: uniforms.uLandRise[0] < 1, riseSink: uniforms.uLandRise[0] };
}

export function assertMaterialFeatureWasExercised(pairs) {
  assert.ok(pairs.some(p => p.materialExercised === true), 'material features were not exercised: need a matched non-flat materialized capture');
}

export function assertMaterialFeatureActivation(state, expected) {
  assert.ok(['reference', 'warp'].includes(expected), 'invalid expected material feature mode');
  assert.equal(state.activation.mode, expected, 'wrong actual terrain material');
  assert.equal(state.activation.define, expected === 'warp', 'wrong material cache define');
  for (const material of [state.activation, state.activation.river].filter(Boolean)) {
    assert.equal(material.mode, expected, 'wrong actual material');
    assert.equal(material.define, expected === 'warp', 'wrong cache define');
    assert.ok(material.linkedPrograms > 0 && material.allLinked && material.bandsUseMaterial, 'inactive or unlinked material');
  }
  assert.equal(state.drawn.selected, expected, 'wrong drawn selection');
  assert.equal(state.drawn.material, expected, 'wrong drawn material');
  assert.equal(state.requested, expected, 'wrong requested selection');
  assert.equal(state.status.selected, expected, 'wrong preparation selection');
  for (const key of ['uSurface', 'uReceiver']) assert.equal(state.uniforms[key]?.texture, true, `missing generated input ${key}`);
  for (const [key, value] of Object.entries(state.uniforms)) {
    if (!value?.texture || ['uMirror', 'uBackdrop'].includes(key)) continue;
    assert.ok(/^[a-f0-9]{64}$/.test(value.content?.sha256)
      && ['gpu-level-0-rgba8', 'validated-material-asset'].includes(value.content.provenance), `unverified texture content ${key}`);
  }
  const { ledger, entry } = state.memory;
  assert.ok(ledger && entry?.resourceIsPrepared && entry.state === 'live' && entry.bytes > 0, 'missing live GPU owner');
  assert.ok(Number.isFinite(ledger.budgetBytes) && ledger.liveBytes + ledger.pendingBytes <= ledger.budgetBytes, 'graphics budget exceeded');
  if (expected === 'reference') {
    assert.equal(state.cache, null, 'reference allocated a cache');
    assert.equal(state.soil.tag, null, 'reference soil has a cache tag');
    for (const source of [state.status, state.drawn]) {
      for (const key of ['bytes', 'width', 'height']) assert.equal(source[key], 0, 'reference cache metadata drift');
      assert.equal(source.reason, 'off', 'reference preparation fallback');
    }
    assert.ok(state.soil.rawOriginBindings?.length === 2 && state.soil.rawOriginBindings.every(Number.isFinite), 'missing reference slot values'); return;
  }
  const cache = state.cache, tag = state.soil.tag;
  assert.ok(cache && cache.boundToSoil && cache.targetOwnsTexture && cache.plan.eligible, 'cache texture is not actually bound');
  assert.ok(tag?.version === 1 && tag.mode === 'warp' && Array.isArray(tag.originCell)
    && tag.originCell.length === 2 && tag.originCell.every(v => Number.isSafeInteger(v) && Math.abs(v) <= 2 ** 24 - 2), 'invalid cache tag');
  for (const dimension of ['width', 'height']) {
    const n = tag[dimension]; assert.ok(Number.isInteger(n) && n >= 1 && n <= 256, 'invalid cache dimensions');
    for (const source of [state.soil, cache.target, cache.plan, state.status, state.drawn]) assert.equal(source[dimension], n, 'cache dimensions drift');
  }
  assert.deepEqual(cache.plan.originCell, tag.originCell, 'cache origin drift');
  assert.deepEqual(state.soil.rawOriginBindings, tag.originCell, 'wrong cache origin slot bindings');
  const origin = state.uniforms.uGridOrigin;
  assert.ok(Array.isArray(origin) && origin.length === 2 && origin.every(Number.isFinite), 'missing grid origin');
  assert.deepEqual(tag.originCell, [Math.floor(origin[0] / 600) - 1, Math.floor(origin[1] / 600 - 19.7) - 1], 'wrong cache grid origin');
  assert.ok(['rgba8', 'nearest', 'linearData', 'noMips', 'clamped', 'notFlipped', 'noDepth']
    .every(key => state.soil.format?.[key] === true), 'invalid cached texture format');
  const bytes = tag.width * tag.height * 4;
  assert.ok(bytes > 0 && bytes <= 256 * 1024, 'cache exceeds 256 KiB');
  for (const source of [cache, cache.plan, state.status, state.drawn]) assert.equal(source.bytes, bytes, 'cache byte charge drift');
  assert.equal(state.status.reason, null, 'cache fallback or denial');
  assert.equal(state.drawn.reason, null, 'drawn cache fallback or denial');
  assert.ok(entry.bytes >= bytes, 'cache is not charged to GPU owner');
}

export function assertMaterialFeatureFrameMatch(a, b) {
  for (const key of ['timeMs', 'actualTimeMs', 'seed', 'quality', 'audio', 'controls', 'render', 'output', 'dpr', 'camera']) {
    assert.notEqual(a[key], undefined, `missing ${key}`); assert.deepEqual(a[key], b[key], `different ${key}`);
  }
  for (const key of ['requestedLook', 'effectiveLook', 'effectiveGrid', 'pixelScale', 'output', 'working', 'qualityLevel']) {
    assert.notEqual(a.presentation?.[key], undefined, `missing presentation.${key}`);
    assert.deepEqual(a.presentation[key], b.presentation?.[key], `different presentation.${key}`);
  }
  for (const [frame, mode] of [[a, 'reference'], [b, 'warp']]) {
    assert.deepEqual(frame.range?.scene?.pending, [], 'unsettled assets'); assert.equal(frame.range.active, true, 'inactive scene');
    assertMaterialFeatureActivation(frame.materialState, mode);
    assert.deepEqual(frame.materialExercise, assessMaterialFeatureExercise(frame.materialState.uniforms), 'invalid exercise metadata');
  }
  for (const key of ['uniforms', 'geometry', 'camera', 'vertexShaderSha256']) {
    assert.notEqual(a.materialState[key], undefined, `missing ${key}`);
    assert.deepEqual(a.materialState[key], b.materialState[key], `different material ${key}`);
  }
  assert.equal(!!a.materialState.activation.river, !!b.materialState.activation.river, 'river material presence drift');
  assert.equal(a.range.viewId, b.range.viewId, 'different view'); assert.deepEqual(a.range.narrative, b.range.narrative, 'different narrative');
  const x = a.materialState.memory, y = b.materialState.memory, bytes = b.materialState.cache.bytes;
  for (const key of ['key', 'owner', 'state']) assert.equal(x.entry[key], y.entry[key], 'GPU owner drift');
  assert.equal(y.entry.bytes - x.entry.bytes, bytes, 'cache missing from GPU bytes ledger');
  for (const key of ['budget', 'budgetBytes', 'pendingBytes', 'entryCount']) assert.deepEqual(x.ledger[key], y.ledger[key], 'memory budget drift');
  assert.equal(y.ledger.liveBytes - x.ledger.liveBytes, bytes, 'unrelated live memory drift');
  const owners = structuredClone(y.ledger.byOwner); owners[y.entry.owner].live -= bytes;
  assert.deepEqual(x.ledger.byOwner, owners, 'unrelated memory owner drift');
}

async function materialState(page, view) {
  return page.evaluate(async ({ view, textureReaderSource }) => {
    const readTexture = new Function(`return (${textureReaderSource})`)();
    const scene = window.__SMW.sim.biomes.rangePresentation.scene, p = scene.prepared.get(view), THREE = scene.THREE;
    if (!p?.material) throw Error(`no prepared terrain material for ${view}`);
    const gl = scene.renderer.getContext(), snapshot = scene.snapshot();
    const activationOf = material => {
      const programs = [...(scene.renderer.properties.get(material)?.programs?.values() || [])];
      return { mode: material.userData.materialFeatures, define: material.defines?.MATERIAL_FEATURE_CACHE === 1,
        linkedPrograms: programs.length, allLinked: programs.every(v => gl.getProgramParameter(v.program, gl.LINK_STATUS)),
        bandsUseMaterial: ['far', 'mid', 'near'].every(b => material === p.riverMaterial && !p.riverGeometries?.[b]
          || p.scenes[b].children.some(mesh => [].concat(mesh.material).includes(material))) };
    };
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const geometry = {};
    for (const group of ['geometries', 'fringes', 'riverGeometries', 'riverFringeGeometries']) {
      geometry[group] = {};
      for (const [band, geo] of Object.entries(p[group] || {})) {
        if (!geo) continue; geometry[group][band] = {};
        for (const [key, attr] of Object.entries({ ...geo.attributes, index: geo.index })) {
          if (!attr) continue; const a = attr.array;
          geometry[group][band][key] = { count: attr.count, itemSize: attr.itemSize, sha256: await hash(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)) };
        }
      }
    }
    const serialize = value => value?.isTexture ? { texture: true, width: value.image?.width ?? null,
      height: value.image?.height ?? null, userData: value.userData, format: value.format, type: value.type,
      colorSpace: value.colorSpace, wrapS: value.wrapS, wrapT: value.wrapT, minFilter: value.minFilter, magFilter: value.magFilter,
      flipY: value.flipY, generateMipmaps: value.generateMipmaps, premultiplyAlpha: value.premultiplyAlpha,
      anisotropy: value.anisotropy, unpackAlignment: value.unpackAlignment }
      : value?.toArray ? value.toArray() : ArrayBuffer.isView(value) ? [...value] : value;
    // These three existing slots hold the candidate cache and exact origin;
    // their raw values are recorded separately and validated, not matched.
    const uniforms = {}, derivedTextures = {}, materialPack = [...scene.materials.values()].find(m => m.key === p.materialKey);
    for (const [key, uniform] of Object.entries(p.uniforms)) {
      if (['tSoil', 'sSoil', 'sCanopy'].includes(key)) continue;
      const value = uniform.value, metadata = serialize(value); uniforms[key] = metadata;
      if (!value?.isTexture) continue;
      const derived = ['uMirror', 'uBackdrop'].includes(key);
      const asset = !derived && Object.entries(materialPack?.textures.roles || {}).find(([, role]) => role.texture === value);
      let content;
      if (asset) {
        const sha256 = materialPack.pack.manifest.textures[asset[0]]?.sha256;
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error(`unverified material asset ${key}`);
        content = { provenance: 'validated-material-asset', role: asset[0], sha256 };
      } else {
        const textureHandle = scene.renderer.properties.get(value).__webglTexture;
        if (textureHandle) {
          if (value.type !== THREE.UnsignedByteType || ![THREE.RedFormat, THREE.RGBAFormat].includes(value.format)) throw Error(`unsupported texture verification format ${key}`);
          content = await readTexture({ gl, textureHandle, width: value.image.width, height: value.image.height });
        } else throw Error(`unverifiable active texture ${key}`);
      }
      if (derived) derivedTextures[key] = { role: 'derived-render-output', content };
      else metadata.content = content;
    }
    const soil = p.uniforms.tSoil?.value, cache = p.materialFeatureCache, entry = scene.residency?.entries.get(p.gpuKey), c = scene.camera;
    return { requested: snapshot.materialFeatures.requested, drawn: snapshot.materialFeatures.drawn[view], status: p.materialFeatureStatus,
      activation: { ...activationOf(p.material), river: p.riverMaterial ? activationOf(p.riverMaterial) : null }, uniforms, geometry, derivedTextures,
      vertexShaderSha256: await hash(new TextEncoder().encode(p.material.vertexShader)),
      camera: { position: c.position.toArray(), quaternion: c.quaternion.toArray(), projection: c.projectionMatrix.toArray(), matrixWorld: c.matrixWorld.toArray() },
      soil: { width: soil?.image?.width, height: soil?.image?.height, tag: soil?.userData?.materialFeatures ?? null,
        rawOriginBindings: [p.uniforms.sSoil?.value, p.uniforms.sCanopy?.value],
        format: { rgba8: soil?.format === THREE.RGBAFormat && soil?.type === THREE.UnsignedByteType,
          nearest: soil?.minFilter === THREE.NearestFilter && soil?.magFilter === THREE.NearestFilter,
          linearData: soil?.colorSpace === THREE.NoColorSpace, noMips: soil?.generateMipmaps === false,
          clamped: soil?.wrapS === THREE.ClampToEdgeWrapping && soil?.wrapT === THREE.ClampToEdgeWrapping, notFlipped: soil?.flipY === false,
          noDepth: !!cache && !cache.target.depthBuffer && !cache.target.stencilBuffer && cache.target.samples === 0 } },
      cache: cache ? { bytes: cache.bytes, plan: cache.plan, boundToSoil: soil === cache.texture, targetOwnsTexture: cache.target.texture === cache.texture,
        target: { width: cache.target.width, height: cache.target.height } } : null,
      memory: { ledger: scene.residency?.snapshot() ?? null,
        entry: entry ? { key: entry.key, owner: entry.owner, state: entry.state, bytes: entry.bytes, resourceIsPrepared: entry.resource === p } : null },
      preparation: snapshot.prepareLog?.[view] ?? null };
  }, { view, textureReaderSource: readPilotTextureContent.toString() });
}

function summaryMarkdown(report) {
  const v = n => Number.isFinite(n) ? n.toFixed(3) : 'unavailable';
  const lines = ['# Material feature comparison', '', `Status: ${report.status}.`, ...(report.error ? ['', `Failure: ${report.error.split('\n')[0]}`] : []),
    '', `Renderer: ${report.environment?.gl || 'unobserved'}${report.software ? ' (software)' : ''}.`, '',
    '| mode | load / preparation ms | cache bytes | GPU terrain p50 / p95 ms | valid samples | CPU frame submission p50 ms |', '|---|---:|---:|---:|---:|---:|'];
  for (const r of report.runs) lines.push(`| ${r.mode} | ${v(r.loadWallMs)} / ${v(r.captures[0]?.materialState.preparation?.ms)} | ${r.captures[0]?.materialState.status.bytes ?? 'unobserved'} | ${v(r.steady?.gpuTerrainMs?.p50)} / ${v(r.steady?.gpuTerrainMs?.p95)} | ${r.steady?.validGpuSamples ?? 0} | ${v(r.steady?.frameSubmissionMs?.p50)} |`);
  lines.push('', '| time ms | exercised inputs | identical PNG | RGB MAE / RMSE / max | pixels changed >2 |', '|---:|---|---|---:|---:|');
  for (const p of report.comparison) lines.push(`| ${p.timeMs} | ${p.materialExercised} | ${p.identical} | ${v(p.error.meanAbsoluteRgb)} / ${v(p.error.rootMeanSquareRgb)} / ${p.error.maxRgb} | ${(p.error.changedFractionOver2 * 100).toFixed(3)}% |`);
  return [...lines, '', ...report.limitations.map(s => `- ${s}`), ''].join('\n');
}

export async function runMaterialFeatureCompare(args) {
  const out = path.resolve(args.out); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(out);
  const settings = { width: 1280, height: 720, seed: 315, quality: 0, experience: 'landscape', view: args.view, pace: 3, tour: 'off',
    presentation: { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', pixelScale: 'original', scaling: 'fit' } };
  const dt = 1000 / 60, sequence = Array.from({ length: 6 }, (_, i) => args.times.at(-1) + (i + 1) * dt);
  const times = [...new Set([...args.times, ...sequence])].sort((a, b) => a - b);
  const report = { version: 1, status: 'failed', createdAt: new Date().toISOString(), settings, args, runs: [], comparison: [],
    schedule: { checkpointsMs: args.times, sequence: { timesMs: sequence, fps: 60, purpose: 'Matched consecutive rendered images; not live delivery.' },
      captureTimesMs: times, warmupFrames: 30, steadyFrames: args.frames, steadyStartMs: times.at(-1) + 31 * dt },
    limitations: ['One frozen-source view, diagnostic music unless --audio supplied; not genre/device coverage or listener review.',
      'Headless fixed-clock captures; no live playback, physical panel or display compositor measurement.',
      'GPU queries cover terrain scenes including depth/trees/cast, not material features alone or Canvas2D output.',
      'CPU times are submission/wall times, not completed GPU work or delivered FPS. Software timings cannot establish hardware speedup.',
      'One warmed batch per mode, reference then warp; no repeated order-balanced hardware trials.',
      'Non-flat/materialized uniform checks establish exercised inputs, not per-pixel feature visibility. RGB error is not artistic quality.',
      'Generated input level-zero texels are hashed outside timing with at most 32 MiB readback scratch per texture; static assets use validated identity-bound source hashes.',
      'Mirror and backdrop texels are recorded as derived render outputs; their content may change with the cache and is excluded from input equality.',
      'Graphics residency values are ownership estimates, not measured driver VRAM or browser process memory.' ] };
  let server, browser;
  try {
    const audio = path.join(out, `audio${args.audio ? path.extname(args.audio) : '.wav'}`);
    if (args.audio) await fs.copyFile(path.resolve(args.audio), audio);
    else execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), audio, '120', '40']);
    report.song = { file: path.basename(audio), sha256: sha256(await fs.readFile(audio)), generated: !args.audio };
    const snapshot = await snapshotSource(root);
    report.source = { digest: snapshot.digest, hashes: snapshot.hashes,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() };
    server = await serveSnapshot(snapshot); await fs.mkdir(path.join(out, 'frames'));
    report.launchArgs = [...(args.hardware ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--mute-audio'];
    for (const mode of ['reference', 'warp']) {
      const run = { mode, captures: [], errors: [], warnings: [], events: [], loadedFiles: new Set() }; report.runs.push(run);
      let loaded, failed = false;
      try {
        browser = await chromium.launch({ headless: true, ...(args.browser ? { executablePath: args.browser } : {}), args: report.launchArgs });
        if (report.browser) assert.equal(report.browser, browser.version(), 'browser drift'); else report.browser = browser.version();
        const started = performance.now();
        loaded = await openEvaluationSong(browser, { url: server.url, audioPath: audio, settings: { ...settings, debug: { materialFeatures: mode } }, diagnostics: run });
        run.loadWallMs = performance.now() - started; run.environment = loaded.environment; run.durationMs = loaded.durationMs;
        if (report.environment) assert.deepEqual(report.environment, loaded.environment, 'environment drift'); else report.environment = loaded.environment;
        report.software = SOFTWARE.test(loaded.environment.gl || '');
        if (args.hardware) assert.ok(loaded.environment.gl && !report.software, `hardware required, got ${loaded.environment.gl}`);
        assert.ok(times.every(t => t >= 0 && Number.isFinite(t)) && times.at(-1) + (30 + args.frames) * dt < loaded.durationMs, 'capture/sequence/warmup/steady exceeds audio duration');
        for (const timeMs of times) {
          const frame = await renderEvaluationFrame(loaded.page, { timeMs, save: true, checkpoint: args.times.includes(timeMs), clips: [] }, settings);
          assert.equal(blankFrame(frame.thumbnail), false, `blank ${mode}@${timeMs}`);
          frame.materialState = await materialState(loaded.page, args.view); assertMaterialFeatureActivation(frame.materialState, mode);
          frame.materialExercise = assessMaterialFeatureExercise(frame.materialState.uniforms);
          const png = frame.pngData; delete frame.pngData; frame.png = `frames/${mode}-${timeMs}.png`; frame.sha256 = sha256(Buffer.from(png, 'base64'));
          await fs.writeFile(path.join(out, frame.png), Buffer.from(png, 'base64'));
          if (mode === 'warp') {
            const reference = report.runs[0].captures.find(f => f.timeMs === timeMs); assertMaterialFeatureFrameMatch(reference, frame);
            report.comparison.push({ timeMs, reference: reference.png, candidate: frame.png, identical: reference.sha256 === frame.sha256,
              materialExercised: reference.materialExercise.exercised && frame.materialExercise.exercised,
              error: await comparePilotPngs(loaded.page, (await fs.readFile(path.join(out, reference.png))).toString('base64'), png) });
          }
          run.captures.push(frame); await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, (_, v) => v instanceof Set ? [...v].sort() : v, 2));
        }
        run.probe = await loaded.page.evaluate(installPilotProbe);
        run.steadyFrames = await runPilotSteady(loaded.page, { startMs: times.at(-1) + dt, frames: args.frames });
        assert.ok(run.steadyFrames.every(f => f.calls.terrain > 0), 'no terrain draws during timing');
        run.steady = summarizePilotFrames(run.steadyFrames); run.steadyState = await materialState(loaded.page, args.view);
        assertMaterialFeatureActivation(run.steadyState, mode);
      } catch (error) { failed = true; throw error; }
      finally {
        await loaded?.context.close(); await loaded?.browserDiagnostics.dispose(); await browser?.close(); browser = null;
        run.loadedFiles = [...run.loadedFiles].sort(); finalizeBrowserDiagnostics(run, report, { preserveFailure: failed });
      }
    }
    assert.deepEqual(report.runs[0].loadedFiles, report.runs[1].loadedFiles, 'loaded asset drift');
    assert.equal(report.runs[0].durationMs, report.runs[1].durationMs, 'audio duration drift');
    for (const key of ['camera', 'uniforms', 'geometry', 'vertexShaderSha256']) assert.deepEqual(report.runs[0].steadyState[key], report.runs[1].steadyState[key], `steady ${key} drift`);
    const draws = run => run.steadyFrames.map(({ timeMs, calls, triangles }) => ({ timeMs, calls, triangles }));
    assert.deepEqual(draws(report.runs[0]), draws(report.runs[1]), 'timing draw schedule drift');
    assertMaterialFeatureWasExercised(report.comparison);
    report.source.changedDuringRun = (await snapshotSource(root)).digest !== report.source.digest;
    assert.equal(report.source.changedDuringRun, false, 'source changed during capture'); report.status = 'passed';
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    await browser?.close(); await server?.close(); await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(out, 'summary.md'), summaryMarkdown(report));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMaterialFeatureCompare(parseMaterialFeatureArgs(process.argv.slice(2))).then(r => console.log(`${r.status}: ${path.join(r.args.out, 'summary.md')}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
