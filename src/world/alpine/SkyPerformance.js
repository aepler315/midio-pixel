const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const smooth = value => { const x = clamp(value); return x * x * (3 - 2 * x); };
const fract = value => value - Math.floor(value);
const GLINT_FAMILIES = 32;

/** A small, stateless score for the sky. Event ages come from heard time, so
 * pause, dropped frames, direct seeks and the water mirror all agree. Work
 * is bounded by six notes, never by the full song or the star catalogue. */
export function sampleSkyPerformance(effects, qualityLevel = 0) {
  if (!effects) return null;
  const energy = clamp(effects.energy), bass = clamp(effects.bass), treble = clamp(effects.treble);
  const melody = clamp(effects.melody), lift = clamp(effects.lift);
  const kick = clamp(effects.kick), snare = clamp(effects.snare);
  const glints = new Float32Array(GLINT_FAMILIES), sweeps = [];
  let pulse = 0, travel = 0, admitted = 0;
  const accents = effects.accents || [];
  const sweepLimit = qualityLevel >= 3 ? 0 : qualityLevel >= 2 ? 1 : 2;
  for (let i = 0; i < Math.min(6, accents.length); i++) {
    const note = accents[i], age = note?.ageSec;
    const kind = note?.kind;
    if (!['kick', 'snare', 'melody'].includes(kind)) continue;
    const duration = kind === 'melody' ? 2 : kind === 'snare' ? .8 : 1.1;
    if (!Number.isFinite(age) || age < 0 || age >= duration) continue;
    const strength = clamp(note.strength);
    if (!strength) continue;
    const phase = Number.isFinite(note.seed) ? fract(note.seed * 17.173 + .371) : .371;
    // A crisp onset followed by an exact finite release. No background
    // oscillator can invent percussion or leave a trail after silence.
    const release = 1 - smooth(age / duration);
    const hit = strength * Math.exp(-age * (kind === 'melody' ? 3 : 7)) * release;
    const family = Math.floor(phase * GLINT_FAMILIES);
    glints[family] = Math.max(glints[family], hit);
    glints[(family + 11) % GLINT_FAMILIES] = Math.max(glints[(family + 11) % GLINT_FAMILIES], hit * .72);
    pulse = Math.max(pulse, hit);
    travel += Math.sin(age * 5) * release * strength / 3;
    admitted++;
    if (sweepLimit) {
      // Keep only the strongest few arcs. A dense chorus cannot turn the
      // horizon into a stack of additive, frame-sized flashes.
      const sweep = { age, phase, kind, strength: strength * release * Math.exp(-age * .7) };
      const slot = sweeps.findIndex(other => other.strength < sweep.strength);
      if (slot >= 0) sweeps.splice(slot, 0, sweep);
      else sweeps.push(sweep);
      if (sweeps.length > sweepLimit) sweeps.pop();
    }
  }
  // Envelope-only callers still have a few fixed families, never a global
  // brightness multiplier. Normal playback gets its identities from notes.
  if (!admitted) {
    glints[3] = kick * .8;
    glints[15] = snare * .85;
    glints[26] = melody * treble * .4;
  }
  if (Math.max(energy, bass, treble, melody, lift, kick, snare, pulse, ...sweeps.map(s => s.strength)) < .001) return null;
  return {
    glints, sweeps, pulse,
    open: clamp(.7 * bass + .3 * energy),
    fold: clamp(.8 * melody + .2 * snare),
    travel: Math.max(-1, Math.min(1, travel)),
    radiance: clamp(.42 * energy + .3 * bass + .2 * melody + .08 * lift),
    lift,
    detail: qualityLevel >= 2 ? .7 : 1,
  };
}
