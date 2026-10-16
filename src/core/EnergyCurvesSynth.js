// Synthesizes continuous per-band EnergyCurves from a discrete NoteEvent[]
// timeline (spec §0.1: "MIDI and raw audio become indistinguishable
// downstream"). The real audio pipeline (Stage 4) derives EnergyCurves from
// actual spectral energy; MIDI/demo timelines have no waveform to analyze,
// so this approximates the same shape from note role/velocity/duration —
// giving Broshi's frequency->anatomy mapping and the Rabid gate (spec §3.2)
// something meaningful to react to regardless of input source.
import { EnergyCurves } from '../audio/EnergyCurves.js';
import { Role, GM_DRUM } from './NoteEvent.js';

export function synthesizeEnergyCurves(timeline, durationMs, rateHz = 50) {
  const ec = new EnergyCurves(durationMs, rateHz);

  const addEnvelope = (bandIdx, tMs, peak, attackMs, releaseMs) => {
    const startFrame = Math.floor((tMs / 1000) * rateHz);
    const attackFrames = Math.max(1, Math.round((attackMs / 1000) * rateHz));
    const releaseFrames = Math.max(1, Math.round((releaseMs / 1000) * rateHz));
    const band = ec.bands[bandIdx];
    for (let i = 0; i < attackFrames + releaseFrames; i++) {
      const f = startFrame + i;
      if (f < 0 || f >= ec.n) continue;
      const v = i < attackFrames ? peak * (i / attackFrames) : peak * (1 - (i - attackFrames) / releaseFrames);
      band[f] = Math.min(1, Math.max(band[f], v));
    }
  };

  for (const e of timeline) {
    if (e.role === Role.RHYTHM) {
      if (e.kick) {
        addEnvelope(0, e.tMs, 0.9 * e.vel, 5, 180);
        addEnvelope(1, e.tMs, 0.5 * e.vel, 5, 150);
      } else if (e.pitch === GM_DRUM.HAT) {
        addEnvelope(5, e.tMs, 0.6 * e.vel, 3, 60);
        addEnvelope(6, e.tMs, 0.4 * e.vel, 3, 60);
      } else {
        addEnvelope(4, e.tMs, 0.7 * e.vel, 4, 120);
      }
    } else if (e.role === Role.BASS) {
      addEnvelope(1, e.tMs, 0.8 * e.vel, 20, Math.max(60, e.durMs * 0.6));
      addEnvelope(0, e.tMs, 0.3 * e.vel, 20, Math.max(60, e.durMs * 0.4));
    } else if (e.role === Role.MELODY) {
      addEnvelope(3, e.tMs, 0.75 * e.vel, 15, Math.max(80, e.durMs * 0.7));
    } else if (e.role === Role.PAD) {
      addEnvelope(2, e.tMs, 0.5 * e.vel, 100, Math.max(200, e.durMs));
      addEnvelope(6, e.tMs, 0.35 * e.vel, 150, Math.max(300, e.durMs));
    }
  }

  return ec;
}
