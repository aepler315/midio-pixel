import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCurrentRoutesArgs, routeGateConfiguration, requireRouteHardwareRenderer, verifyHardwareRoute,
  summarizeConfiguredRun, checkoutIdentity, SWIFTSHADER_ARGS } from '../tools/current-routes-smoke.mjs';
import { CURRENT_ROUTES } from '../tools/lib/current-route-evidence.mjs';
import { isWindowsPath } from '../tools/lib/windows-node.mjs';

// Verbatim renderer strings from the WP03 follow-up's SwiftShader gate and RTX 3060 runs.
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const RTX_3060 = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const WARP = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const LLVMPIPE = 'ANGLE (Mesa, llvmpipe (LLVM 19.1.1, 256 bits), OpenGL 4.5)';

test('route gate options keep the existing ones and add an explicit hardware opt-in', () => {
  assert.deepEqual(parseCurrentRoutesArgs([]), {});
  assert.deepEqual(parseCurrentRoutesArgs(['--site-root', '_site', '--out', 'out', '--audio', 'song.wav', '--timeout-ms', '1000']),
    { siteRoot: '_site', outDir: 'out', audioPath: 'song.wav', timeoutMs: 1000 });
  assert.deepEqual(parseCurrentRoutesArgs(['--hardware-gpu', '--gpu-match', 'RTX 3060', '--browser', 'C:\\chrome.exe', '--out', 'out']),
    { hardwareGpu: true, gpuMatch: 'RTX 3060', browserPath: 'C:\\chrome.exe', outDir: 'out' });
  assert.equal(parseCurrentRoutesArgs(['--gpu-match', 'RTX 3060', '--hardware-gpu']).hardwareGpu, true);
  for (const argv of [['--gpu-match', 'RTX 3060'], ['--hardware-gpu', '--gpu-match'], ['--hardware-gpu', '--gpu-match', '--out', 'out'],
    ['--out'], ['--timeout-ms'], ['--headful'], ['--software-gpu'], ['hardware-gpu']]) {
    assert.throws(() => parseCurrentRoutesArgs(argv), Error, argv.join(' '));
  }
});

test('the default gate keeps its SwiftShader launch; the hardware configuration is separate', () => {
  const saved = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  try {
    process.env.PLAYWRIGHT_CHROMIUM_PATH = '/linux/chrome';
    const standard = routeGateConfiguration();
    assert.deepEqual(standard.args, ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']);
    assert.equal(standard.id, 'swiftshader'); assert.equal(standard.hardwareRequired, false);
    assert.equal(standard.gpuMatch, null); assert.equal(standard.executablePath, '/linux/chrome');
    const hardware = routeGateConfiguration({ hardwareGpu: true, gpuMatch: 'RTX 3060', browserPath: 'C:\\chrome.exe' });
    assert.deepEqual(hardware.args, ['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist']);
    assert.equal(hardware.id, 'hardware-gpu'); assert.equal(hardware.hardwareRequired, true);
    assert.equal(hardware.gpuMatch, 'RTX 3060'); assert.equal(hardware.executablePath, 'C:\\chrome.exe');
    assert.throws(() => routeGateConfiguration({ gpuMatch: 'RTX 3060' }), /requires --hardware-gpu/);
    standard.args.push('--disable-gpu');
    assert.equal(SWIFTSHADER_ARGS.length, 4, 'a configuration cannot change the default flags');
    delete process.env.PLAYWRIGHT_CHROMIUM_PATH;
    assert.equal(routeGateConfiguration().executablePath, undefined);
  } finally {
    if (saved === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_PATH; else process.env.PLAYWRIGHT_CHROMIUM_PATH = saved;
  }
});

test('the hardware check rejects software rasterizers, unverifiable renderers and another GPU', () => {
  assert.doesNotThrow(() => requireRouteHardwareRenderer(RTX_3060));
  assert.doesNotThrow(() => requireRouteHardwareRenderer(RTX_3060, 'rtx 3060'));
  for (const renderer of [SWIFTSHADER, WARP, LLVMPIPE, 'Google SwiftShader', 'WebKit WebGL', '', null, undefined]) {
    assert.throws(() => requireRouteHardwareRenderer(renderer), /Hardware GPU unavailable/, String(renderer));
  }
  assert.throws(() => requireRouteHardwareRenderer(RTX_3060, 'RX 7900'), /does not match RX 7900/);
});

test('a hardware run that renders in software fails even when every route passes playback', () => {
  const hardware = routeGateConfiguration({ hardwareGpu: true, gpuMatch: 'RTX 3060' }), standard = routeGateConfiguration();
  const row = (id, gpu) => ({ id, status: 'passed', errors: [], events: [], samples: [{ gpu }, { gpu }] });
  // Trio draws through Canvas 2D, so its samples carry no WebGL renderer.
  const rows = gpu => CURRENT_ROUTES.map(id => row(id, id === 'trio' ? null : gpu));
  const probe = renderer => ({ before: renderer, after: renderer });

  assert.equal(summarizeConfiguredRun(rows(SWIFTSHADER), standard), 'passed', 'the default gate does not judge its renderer');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), hardware, probe(RTX_3060)), 'passed');
  assert.equal(summarizeConfiguredRun(rows(SWIFTSHADER), hardware, probe(SWIFTSHADER)), 'failed');
  assert.equal(summarizeConfiguredRun(rows(SWIFTSHADER), hardware, probe(RTX_3060)), 'failed');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), hardware, probe(WARP)), 'failed');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), hardware, { before: RTX_3060, after: SWIFTSHADER }), 'failed', 'fallback during the run');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), hardware, { before: RTX_3060 }), 'failed', 'missing final probe');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), hardware), 'failed', 'missing probes');
  assert.equal(summarizeConfiguredRun(rows(RTX_3060), routeGateConfiguration({ hardwareGpu: true, gpuMatch: 'RX 7900' }),
    probe(RTX_3060)), 'failed');

  // Landscape and tours must show their own hardware context; only Trio may lack one.
  const missing = rows(RTX_3060); missing[1].samples[1].gpu = null;
  assert.equal(summarizeConfiguredRun(missing, hardware, probe(RTX_3060)), 'failed');
  assert.throws(() => verifyHardwareRoute(missing[1], 'RTX 3060'), /Hardware GPU unavailable: null/);
  assert.doesNotThrow(() => verifyHardwareRoute(row('trio', null), 'RTX 3060'));
  assert.throws(() => verifyHardwareRoute(row('trio', SWIFTSHADER), 'RTX 3060'), /Hardware GPU unavailable/);
  assert.throws(() => verifyHardwareRoute({ id: 'landscape', samples: [] }), /no playback samples/);

  // Neither configuration turns a failed route into a pass.
  for (const [configuration, gpu] of [[standard, SWIFTSHADER], [hardware, RTX_3060]]) {
    const failed = rows(gpu); failed[2].status = 'failed';
    assert.equal(summarizeConfiguredRun(failed, configuration, probe(RTX_3060)), 'failed');
  }
});

test('checkout identity outside Git is recorded as unavailable instead of failing the run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'route-identity-'));
  try {
    const identity = checkoutIdentity(directory);
    assert.equal(identity.commit, null); assert.equal(identity.dirty, null);
    assert.equal(identity.identity, 'unavailable'); assert.equal(identity.authoritative, 'staged digest');
    assert.match(identity.reason, /\S/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('WSL relaunch keeps Windows paths and translates Linux ones', () => {
  for (const value of ['C:\\Users\\chrome.exe', 'c:/chrome.exe', '\\\\wsl.localhost\\Ubuntu\\tmp']) assert.equal(isWindowsPath(value), true, value);
  for (const value of ['/mnt/c/chrome.exe', '.smoke/out', 'C:chrome.exe']) assert.equal(isWindowsPath(value), false, value);
});
