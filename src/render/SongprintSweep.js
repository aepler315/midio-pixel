import { createSweepAudio } from '../audio/SongprintSweepAudio.js';
import { clamp, lerp } from '../utils/math.js';
import { sliceInks } from './SongprintFable.js';

const TAU = 2 * Math.PI;

/** Read the exact crossings of one ray through the finished print. Samples are
 * scratch views; the four slots accommodate a frame and its two delayed folds.
 * Sampling in any order (including after a seek) returns the same measurements. */
export function createSongprintSweep(descriptor, growth, sim, lab) {
  const { rays, slices, field, stride } = growth;
  const colors = sliceInks(descriptor, lab);
  const last = descriptor.lastFraction ?? 1;
  const total = slices - 1 + last;
  const offset = descriptor.offsetSeconds ?? 0;
  // Old cached Fable printouts discarded their leading trim. Match the
  // previous normalized playback mapping when no origin is available.
  const recordingMs = sim.conductor?.durationMs || sim.durationMs || sim.biomes?.durationMs;
  const sourceDuration = descriptor.offsetSeconds == null && recordingMs > 0 ? recordingMs / 1000
    : total * descriptor.sliceSeconds;
  const seconds = sourceDuration / total;
  const songSeconds = recordingMs > 0 ? recordingMs / 1000 : offset + sourceDuration;
  const audioAt = createSweepAudio(sim, descriptor);
  let meanGap = 0;
  for (let j = 0; j < rays; j++) meanGap += field[j * stride + slices];
  meanGap /= rays * total;
  const spread = Math.max(1, Math.round(rays / 32));
  const slots = [];
  function createSlot() {
    return { rows: colors.map((color, i) => ({ i, color, r0: 0, r1: 0, bend: 0, gap: 0, focus: 0 })) };
  }
  return (timeSec, { periodSec, withAudio = true } = {}) => {
    const time = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
    const loopSeconds = Number.isFinite(periodSec) && periodSec > 0 ? periodSec : null;
    for (let i = 0; i < slots.length; i++) {
      const hit = slots[i];
      if (hit.time === time && hit.periodSec === loopSeconds && hit.withAudio === withAudio) {
        // A seek can revisit the oldest slot. Keep it alive while the two
        // delayed impressions borrow their own row buffers for this frame.
        slots.splice(i, 1);
        slots.push(hit);
        return hit;
      }
    }
    const out = slots.length < 4 ? createSlot() : slots.shift();
    slots.push(out);
    // Angular position follows the full recording. Only the radial playhead
    // below uses the print's audible trim. Numeric periods opt into a loop.
    let turn = clamp(time / songSeconds, 0, 1);
    if (loopSeconds !== null) {
      const periodUs = Math.max(1, Math.round(loopSeconds * 1e6));
      turn = (Math.round(time * 1e6) % periodUs) / periodUs;
    }
    const angle = turn * rays;
    const index = Math.floor(angle);
    const j = index % rays, k = (j + 1) % rays, mix = angle - index;
    const a = j * stride, b = k * stride;
    const al = ((j + rays - spread) % rays) * stride, bl = ((k + rays - spread) % rays) * stride;
    const ar = ((j + spread) % rays) * stride, br = ((k + spread) % rays) * stride;
    const elapsed = clamp((time - offset) / seconds, 0, total);
    const active = Math.min(slices, elapsed <= slices - 1 ? elapsed : slices - 1 + (elapsed - slices + 1) / last);
    const activeSlice = Math.min(slices - 1, Math.floor(active));
    Object.assign(out, { time, periodSec: loopSeconds, phase: turn * TAU, activeIndex: active, withAudio });
    if (withAudio) audioAt(out, time * 1000, time >= offset && time <= offset + sourceDuration, activeSlice);
    else Object.assign(out, { attack: 0, energy: .5, audible: 1, sustained: 0, beatPosition: null, beatConfidence: 0 });
    let r0 = 0, left = 0, right = 0;
    for (let i = 0; i < slices; i++) {
      const end = i + 1, row = out.rows[i];
      const r1 = lerp(field[a + end], field[b + end], mix);
      const leftEnd = lerp(field[al + end], field[bl + end], mix);
      const rightEnd = lerp(field[ar + end], field[br + end], mix);
      const wl = leftEnd - left, wr = rightEnd - right;
      const span = i === slices - 1 ? last : 1;
      const distance = (offset + (i + .5 * span) * seconds - time) / 1.05;
      row.r0 = r0; row.r1 = r1;
      row.gap = Math.min(5, (r1 - r0) / (meanGap * span));
      row.bend = (wr - wl) / Math.max(1e-12, wr + wl);
      row.focus = withAudio && Math.abs(distance) < 4 ? out.audible * Math.exp(-.5 * distance ** 2) : 0;
      r0 = r1; left = leftEnd; right = rightEnd;
    }
    const head = out.rows[activeSlice];
    out.activeRadius = lerp(head.r0, head.r1, active - activeSlice);
    out.outerRadius = r0;
    return out;
  };
}
