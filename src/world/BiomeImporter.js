// BiomeImporter — derive a playable custom biome profile from a loaded MIDI
// timeline. Pure data out; BiomeManager registers the profile and casts the
// whole song into it so drag-and-drop MIDI becomes a unique world without
// touching the 9 stock biomes.
import { hashSeed } from '../utils/math.js';
import { Role } from '../core/NoteEvent.js';

const PARTICLE_KINDS = [
  'fireflies', 'embers', 'snow', 'pollen', 'antigrav',
  'petals', 'rain', 'flaresparks', 'digitalrain',
  'sand', 'bubbles', 'spores',
];

const FX_BY_TEMP = [
  [0.12, 'aurora'],
  [0.22, 'nebulaBloom'],
  [0.32, 'starTwinkle'],
  [0.44, 'godRays'],
  [0.55, 'petalPile'],
  [0.66, 'canopyDapple'],
  [0.78, 'heatShimmer'],
  [0.90, 'prominence'],
  [1.01, 'lightning'],
];

/** HSL → #rrggbb (components already in 0..360 / 0..100 / 0..100). */
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function pickFx(temp) {
  for (const [hi, fx] of FX_BY_TEMP) {
    if (temp < hi) return fx;
  }
  return 'starTwinkle';
}

/**
 * Build a BiomeProfiles-compatible object from a loaded-song timeline --
 * MIDI or raw audio, both adapters emit the same shapes. Deterministic for
 * the same content (same note set / duration / analysis).
 *
 * The fingerprint reads four layers of the song:
 *   - tonality: dominant pitch class -> hue; major/minor balance tilts the
 *     whole palette radiant or somber (the audio path passes a chroma-
 *     derived `analysis`; MIDI derives the same balance from its notes);
 *   - energy: density + velocity + kick drive -> temperature;
 *   - texture: spectral brightness lifts the sky's hot band, dynamic range
 *     earns the neon ridge line, stereo width airs out the particles;
 *   - orchestration: role mix picks the particle species.
 *
 * @param {{ timeline: Array, tracks?: Array, durationMs?: number, bpm?: number,
 *           analysis?: { tonic?: number, majorness?: number, brightness?: number,
 *                        dynamicRange?: number, stereoWidth?: number } }} data
 * @param {string} [fileName]
 */
export function generateCustomBiomeFromTimeline(data, fileName = 'MIDI') {
  const timeline = data.timeline || [];
  const durationMs = Math.max(1, data.durationMs || 1);
  const bpm = data.bpm || 120;

  let pitchSum = 0;
  let velSum = 0;
  let velSqSum = 0;
  let panAbsSum = 0;
  let kickCount = 0;
  const roleCounts = { [Role.MELODY]: 0, [Role.PAD]: 0, [Role.BASS]: 0, [Role.RHYTHM]: 0 };
  const classHist = new Array(12).fill(0);

  for (const e of timeline) {
    pitchSum += e.pitch ?? 60;
    velSum += e.vel ?? 0.5;
    velSqSum += (e.vel ?? 0.5) ** 2;
    panAbsSum += Math.abs(e.pan ?? 0);
    if (e.kick) kickCount++;
    if (e.role in roleCounts) roleCounts[e.role]++;
    classHist[(e.pitch ?? 60) % 12]++;
  }

  const n = Math.max(1, timeline.length);
  const meanPitch = pitchSum / n;
  const meanVel = velSum / n;
  const density = timeline.length / (durationMs / 1000); // notes/sec
  const kickRate = kickCount / (durationMs / 1000);

  // Dominant pitch class → hue (C=0 → cool violet, F#=6 → amber, …). The
  // audio path's chroma-derived tonic (real spectral evidence) wins over
  // the event-count argmax when present.
  let domClass = 0, domCount = -1;
  for (let i = 0; i < 12; i++) {
    if (classHist[i] > domCount) { domCount = classHist[i]; domClass = i; }
  }
  const a = data.analysis || {};
  const tonic = Number.isFinite(a.tonic) ? a.tonic : domClass;

  // Major/minor balance: chroma-derived when available, else the third
  // balance over the timeline's own pitch classes (relative to the tonic).
  let majorness;
  if (Number.isFinite(a.majorness)) {
    majorness = Math.max(-1, Math.min(1, a.majorness));
  } else {
    const M = classHist[(tonic + 4) % 12], m = classHist[(tonic + 3) % 12];
    majorness = (M - m) / (M + m + 0.5);
  }

  // Texture features: real for audio; honest approximations for MIDI
  // (register -> brightness, velocity spread -> dynamics, authored pans ->
  // width) so both sources move the same palette knobs.
  const brightness = Number.isFinite(a.brightness)
    ? Math.max(0, Math.min(1, a.brightness))
    : Math.max(0, Math.min(1, (meanPitch - 40) / 48));
  const velStd = Math.sqrt(Math.max(0, velSqSum / n - meanVel * meanVel));
  const dynRange = Number.isFinite(a.dynamicRange)
    ? Math.max(0, Math.min(1, a.dynamicRange))
    : Math.max(0, Math.min(1, velStd * 4));
  const width = Number.isFinite(a.stereoWidth)
    ? Math.max(0, Math.min(1, a.stereoWidth))
    : Math.max(0, Math.min(1, (panAbsSum / n) * 2));

  // Minor keys drift the hue cooler; major keys leave it where the tonic
  // put it. Saturation/lightness tilt radiant for major, somber for minor.
  const hue = (tonic * 30 + meanPitch * 0.35 + 12 * Math.min(0, majorness) + 360) % 360;
  const satTilt = 1 + 0.12 * majorness;
  const lightTilt = 5 * majorness;

  // Temperature 0..1 from density + velocity + kick drive (cold ballad → hot banger).
  const temp = Math.max(0, Math.min(1,
    0.25 * Math.min(1, density / 12)
    + 0.35 * meanVel
    + 0.25 * Math.min(1, kickRate / 3)
    + 0.15 * Math.min(1, (bpm - 60) / 120),
  ));

  const skyDark = hslToHex(hue, (55 + temp * 20) * satTilt, 4 + temp * 6 + Math.min(0, lightTilt) * 0.4);
  const skyMid = hslToHex(hue + 18, (50 + temp * 25) * satTilt, 14 + temp * 16 + lightTilt * 0.5);
  const skyHot = hslToHex(hue + 40, (60 + temp * 20) * satTilt, 45 + temp * 25 + lightTilt + 8 * (brightness - 0.5));
  const sil = hslToHex(hue - 10, 40 + temp * 15, 8 + temp * 6);
  const halo = hslToHex(hue + 25, 70 * satTilt, 72 + temp * 12 + lightTilt * 0.6);
  const cel = hslToHex(hue + 30, (65 + temp * 20) * satTilt, 78 + 4 * (brightness - 0.5));
  const particleColor = hslToHex(hue + 50, 75, 80);

  const melodyShare = roleCounts[Role.MELODY] / n;
  const rhythmShare = roleCounts[Role.RHYTHM] / n;
  let kind = PARTICLE_KINDS[Math.floor(temp * (PARTICLE_KINDS.length - 0.01))];
  if (melodyShare > 0.45) kind = temp > 0.5 ? 'petals' : 'fireflies';
  if (rhythmShare > 0.4) kind = temp > 0.55 ? 'digitalrain' : 'rain';
  if (roleCounts[Role.BASS] / n > 0.35) kind = temp > 0.5 ? 'embers' : 'antigrav';

  // Wide mixes air out the particle field; dynamic songs move it faster.
  const count = Math.round(18 + temp * 50 + Math.min(20, density) + width * 14);
  const speed = Math.round(10 + temp * 120 + kickRate * 15 + dynRange * 25);
  const isMoon = meanPitch < 58 || temp < 0.35;
  const radius = Math.round(32 + temp * 40 + (isMoon ? 8 : 0));

  const base = String(fileName || 'MIDI')
    .replace(/\.(mid|midi|mp3|wav|flac|ogg|m4a|aac|opus|webm)$/i, '').slice(0, 28) || 'SONG';
  const seed = hashSeed(`${timeline.length}:${durationMs}:${domClass}:${Math.round(meanPitch * 10)}`);
  const name = `CUSTOM:${base}`.toUpperCase().replace(/[^A-Z0-9:_-]/g, '_').slice(0, 40);

  const profile = {
    name,
    id: `custom-${(seed >>> 0).toString(16)}`,
    sky: [skyDark, skyMid, skyHot],
    silhouette: sil,
    // High-contrast songs earn the neon ridge line even when they aren't hot.
    edgeLight: (temp > 0.65 || (dynRange > 0.6 && temp > 0.45)) ? hslToHex(hue + 80, 90, 60) : undefined,
    celestial: {
      kind: isMoon ? 'moon' : 'sun',
      color: cel,
      radius,
      haloColor: halo,
      veiled: temp > 0.7 && kickRate > 1.5,
      ring: isMoon && melodyShare > 0.3,
      shafts: !isMoon && (temp > 0.55 || brightness > 0.72),
    },
    particles: { kind, color: particleColor, count, speed },
    fx: pickFx(temp),
    // Metadata for HUD / tests (ignored by renderer).
    sourceFile: fileName,
    derived: {
      hue: Math.round(hue),
      temperature: Math.round(temp * 1000) / 1000,
      density: Math.round(density * 100) / 100,
      noteCount: timeline.length,
      dominantClass: domClass,
      tonic,
      majorness: Math.round(majorness * 1000) / 1000,
      brightness: Math.round(brightness * 1000) / 1000,
      dynamicRange: Math.round(dynRange * 1000) / 1000,
      stereoWidth: Math.round(width * 1000) / 1000,
    },
  };

  return profile;
}

/** Back-compat alias: the generator has always been timeline-shaped; the
 *  audio path now feeds it too (with its `analysis` fingerprint attached). */
export const generateCustomBiomeFromMidi = generateCustomBiomeFromTimeline;

/**
 * Register a custom biome onto a live ParamBus history list (capped).
 * Does not affect the KEYS smoothing system.
 */
export function rememberCustomBiome(paramBus, profile, max = 12) {
  if (!paramBus || !profile) return;
  if (!Array.isArray(paramBus.customBiomes)) paramBus.customBiomes = [];
  paramBus.customBiomes = [
    profile,
    ...paramBus.customBiomes.filter((b) => b.id !== profile.id),
  ].slice(0, max);
}
