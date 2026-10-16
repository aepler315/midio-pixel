import { Simulation } from '../../src/sim/Simulation.js';
import { Renderer } from '../../src/render/Renderer.js';
import { Conductor } from '../../src/core/Conductor.js';
import { ParamBus } from '../../src/core/ParamBus.js';
import { Role } from '../../src/core/NoteEvent.js';

// Only the native drawing surface is replaced in Node. The event producers,
// fixed-step Simulation, finishing passes and reel admission all run for real.
class Canvas {
  constructor(width = 0, height = 0) {
    this.width = width; this.height = height; this.frame = 0;
    const noop = () => {};
    this.ctx = new Proxy({ canvas: this, drawImage: source => { this.frame = source.frame; } }, {
      get: (target, key) => {
        if (key in target) return target[key];
        if (/^create(Linear|Radial|Conic)Gradient$/.test(key)) return () => ({ addColorStop: noop });
        if (key === 'createPattern') return () => ({ setTransform: noop });
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, transformPoint: p => p });
        if (key === 'createImageData' || key === 'getImageData') return (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) });
        return noop;
      },
      set: (target, key, value) => { target[key] = value; return true; },
    });
  }
  getContext() { return this.ctx; }
  toDataURL() { return `data:image/jpeg;base64,${Buffer.from(String(this.frame)).toString('base64')}`; }
}
globalThis.document = { createElement: () => new Canvas() };
globalThis.OffscreenCanvas = Canvas;
globalThis.Path2D = class { constructor() { return new Proxy({}, { get: () => () => {} }); } };

export function energyFixture(value = () => .1) {
  return { sample: (_band, time) => value(time), sampleAll: time => Array(7).fill(value(time)),
    globalEnergy: value, globalEnergyNorm: value };
}

export function rendererFixture({ cues = [{ id: 'drop', tMs: 5000, kind: 'drop', value: 1 }],
  durationMs = 24000, lastImpactMs = 22000, energyCurves = energyFixture(), timeline = null, quality = 0,
  ridgeMusicSession = null } = {}) {
  const conductor = new Conductor();
  conductor.load({ durationMs, bpm: 120,
    timeline: timeline ?? [1000, lastImpactMs].map((tMs, i) => ({ id: `note:${i}`, tMs, durMs: 80,
      role: Role.RHYTHM, kick: true, vel: .8, pitch: 36 })),
    barGrid: Array.from({ length: Math.ceil(durationMs / 2000) }, (_, i) => ({ ms: i * 2000, tick: i * 4,
      numerator: 4, denominator: 4 })) });
  const sim = new Simulation(conductor, new ParamBus(), { worldId: 'understory', songSeed: 315,
    energyCurves, conductorCues: { liveCues: cues, scheduleCues: [] }, ridgeMusicSession });
  // Background strip prerendering is unrelated to the highlight contract.
  sim.biomes.pumpStripPrewarm = () => {};
  sim.step(0, 0); sim.perf.setFixtureLevel(quality);
  const canvas = new Canvas(640, 360), renderer = new Renderer(canvas);
  const step = 1000 / 120;
  let tick = 0;
  return { sim, renderer, canvas,
    drawAt(timeMs) {
      while ((tick + 1) * step <= timeMs + 1e-7) { tick++; sim.step(step, tick * step); }
      canvas.frame = sim.timeMs; renderer.draw(sim, 1);
      return sim.highlightReel;
    },
    seekTo(timeMs) { sim.startAt(timeMs); tick = Math.floor(timeMs / step); },
    dispose() { renderer.dispose(); sim.dispose(); },
  };
}
