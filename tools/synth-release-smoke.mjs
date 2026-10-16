// Real Web Audio render of authored sample PAD teardown. No device/listening
// acceptance: save WAVs in .smoke for a human to audition separately.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] || '.smoke/master-implementation/WP08-waveforms');
await mkdir(out, { recursive: true });
const baseline = process.argv.includes('--baseline') ? new Map(
  ['src/audio/SimpleSynth.js', 'src/audio/SoundfontLibrary.js'].map(path =>
    [resolve(root, path), execFileSync('git', ['show', `HEAD:${path}`], { cwd: root })])) : new Map();
const server = createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  if (path === root + sep + 'synth-release-test') {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synth release</title>'); return;
  }
  try {
    const content = baseline.get(path) || await readFile(path);
    res.setHeader('Content-Type', 'text/javascript'); res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium',
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/synth-release-test`);
  page.on('console', message => console.log(message.text()));
  const timeout = setTimeout(() => browser.close(), 90000);
  const result = await page.evaluate(async () => {
    const { SimpleSynth } = await import('/src/audio/SimpleSynth.js');
    const { SynthRouter } = await import('/src/audio/SoundfontLibrary.js');
    const { buildDemoSong } = await import('/src/core/DemoSong.js');
    const { Role } = await import('/src/core/NoteEvent.js');
    const pad = buildDemoSong().timeline.find(evt => evt.role === Role.PAD && evt.durMs === 1920);
    const patch = { type: 'sawtooth', attack: 0.02, release: 0.3, cutoffHz: 3000,
      resonanceQ: 1, unisonGain: 0.3, unisonDetuneCents: 7,
      vibratoDepthCents: 12, vibratoRateHz: 5, peakGain: 0.15 };
    const sampleRate = 48000;
    const renders = [];
    const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / Math.max(1, data.length));
    async function render(name, kind, action, replacementOnly = false) {
      console.log('render ' + name);
      const ctx = new OfflineAudioContext(1, sampleRate * 3, sampleRate);
      const master = ctx.createGain(); master.connect(ctx.destination);
      const synth = new SimpleSynth({ ctx, master });
      const router = new SynthRouter(synth);
      if (kind.startsWith('patch')) synth.setPatches({ 2: patch });
      const event = kind === 'kick' ? { ...pad, role: Role.RHYTHM, pitch: 36 }
        : kind === 'noise' ? { ...pad, role: Role.RHYTHM, pitch: 38 } : pad;
      // Noise comparisons need the same buffer. Deterministic only in the harness.
      let randomState = 11;
      const random = Math.random;
      Math.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
      try { if (!replacementOnly) router.noteOn(event); } finally { Math.random = random; }
      const outgoing = [...(synth._voices || [])];
      const suspended = ctx.suspend(kind.includes('attack') ? 0.002
        : kind === 'kick' || kind === 'noise' ? 0.025 : 0.25);
      const rendered = ctx.startRendering();
      await suspended;
      console.log('suspended ' + name + ' at ' + ctx.currentTime);
      const stoppedAt = ctx.currentTime;
      if (action !== 'natural') {
        if (action === 'hard') master.gain.setValueAtTime(0, stoppedAt);
        else { router.stopAll(); router.stopAll(); }
      }
      if (action === 'seek') {
        router.noteOn({ ...pad, pitch: pad.pitch + 7 });
        // Old ended events fire naturally while the incoming voice plays.
      }
      if (action === 'upload') {
        router.enabled = false;
        router.noteOn(pad);
        const recording = ctx.createOscillator(); recording.frequency.value = 330;
        const recordingGain = ctx.createGain(); recordingGain.gain.value = 0.08;
        recording.connect(recordingGain).connect(master);
        recording.start(stoppedAt); recording.stop(2.8);
      }
      await ctx.resume();
      const buffer = await rendered;
      const samples = Array.from(buffer.getChannelData(0));
      const summary = { name, kind, action, stoppedAt, activeAfterRender: synth._voices?.size ?? null,
        initialVoices: outgoing.length, masterValue: master.gain.value, samples };
      renders.push(summary);
      return summary;
    }
    const metrics = [];
    for (const kind of ['plain', 'patch', 'kick', 'noise', 'plain-attack', 'patch-attack']) {
      const natural = await render(`${kind}-natural`, kind, 'natural');
      const released = await render(`${kind}-title`, kind, 'title');
      const hard = await render(`${kind}-hard-stop`, kind, 'hard');
      const onset = Math.round(released.stoppedAt * sampleRate);
      const end = Math.round((released.stoppedAt + 0.03) * sampleRate);
      const delta = (data, at) => data[at] - data[at - 1];
      const onsetError = Math.max(...[0, 1, 2].map(offset => Math.abs(
        delta(released.samples, onset + offset) - delta(natural.samples, onset + offset))));
      const endStep = Math.max(...[-1, 0, 1, 2].map(offset => Math.abs(delta(released.samples, end + offset))));
      metrics.push({ kind, tailRms: rms(released.samples.slice(end + 2)),
        controlTailRms: rms(natural.samples.slice(end + 2, end + 512)), onsetError, endStep,
        hardStopStep: Math.abs(delta(hard.samples, onset)), activeAfterRender: released.activeAfterRender });
    }
    for (const action of ['seek', 'upload']) {
      const mixed = await render(`sample-${action}`, 'plain', action);
      const incoming = await render(`incoming-${action}-only`, 'plain', action, true);
      const end = Math.round((mixed.stoppedAt + 0.03) * sampleRate) + 2;
      metrics.push({ action, residualRms: rms(mixed.samples.slice(end).map((value, index) => value - incoming.samples[end + index])),
        incomingRms: rms(mixed.samples.slice(end, end + sampleRate)), activeAfterRender: mixed.activeAfterRender,
        masterValue: mixed.masterValue });
    }
    // Return PCM bytes, avoiding millions of JSON float properties.
    const audio = renders.map(({ samples, ...summary }) => {
      const pcm = new Uint8Array(samples.length * 2);
      const view = new DataView(pcm.buffer);
      samples.forEach((value, index) => view.setInt16(index * 2,
        Math.round(Math.max(-1, Math.min(1, value)) * 32767), true));
      let binary = '';
      for (let offset = 0; offset < pcm.length; offset += 8192) binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
      return { ...summary, pcm: btoa(binary) };
    });
    return { samplePadDurationMs: pad.durMs, sampleRate, metrics, renders: audio };
  });
  clearTimeout(timeout);
  const { renders, ...report } = result;
  for (const render of renders) {
    const pcm = Buffer.from(render.pcm, 'base64');
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(result.sampleRate, 24); wav.writeUInt32LE(result.sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    await writeFile(resolve(out, `${render.name}.wav`), wav);
  }
  await writeFile(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.samplePadDurationMs, 1920);
  for (const metric of report.metrics) {
    if (metric.kind) {
      assert.ok(metric.tailRms < 1e-8, `outgoing ${metric.kind} tail must end within 30 ms plus two sample frames`);
      assert.ok(metric.onsetError < 0.0002, `no introduced onset jump: ${metric.kind}`);
      assert.ok(metric.endStep < 0.0002, `no introduced release-end jump: ${metric.kind}`);
    } else {
      assert.ok(metric.residualRms < 1e-8, `old sample must not bleed into ${metric.action}`);
      assert.ok(metric.incomingRms > 0.0001, `incoming ${metric.action} stays audible`);
      assert.equal(metric.masterValue, 1, 'no shared master fade');
    }
    assert.equal(metric.activeAfterRender, 0, JSON.stringify(metric));
  }
  for (const render of renders) assert.equal(render.activeAfterRender, 0, `${render.name} cleaned naturally/after teardown`);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
