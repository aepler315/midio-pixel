// One Spectrum (the overhaul): the per-song spectral color language.
//
// Midio's stated design language is spectral -- hue from pitch class,
// glow from deformation (see stellar.js). The characters already wear it
// (`spectralHue(tonic)`), but the world biomes are fixed hand-tuned hex
// postcards and the HUD chrome is static hex, so one composed frame mixes
// three unrelated palettes. This module is the single source of truth that
// unifies them: every color in the frame becomes an ANCHOR color (today's
// tasteful biome hexes, preserved verbatim) hue-rotated as one body by the
// song's key signal.
//
// Core primitive: `rotateHueHex(anchor, deg)` -- rotation by degrees
// preserves saturation/lightness exactly, so the biome keeps its *shape*
// of color (TWILIGHT still reads as purple dusk, ARCTIC as cold blue)
// while its center follows the song. Because we rotate the original hex
// rather than re-deriving through HSL, there is no round-trip loss: at
// zero shift the tokens ARE today's colors, byte-identical.
import { spectralHue } from './stellar.js';
import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex, rotateHueHex } from '../utils/color.js';
import { clamp01 } from '../utils/math.js';

/** Shortest signed hue delta from a to b in degrees, through whichever
 *  direction around the wheel is shorter. */
export function hueDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/** The hue (0..360) of a hex color. */
export function hueOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b).h;
}

/**
 * The per-song spectral shift: how far every biome palette should rotate so
 * its anchor hue lands ON the song's spectral hue. `anchorHue` is the
 * biome's resting hue (its identity-bearing color); `tonic` is the song's
 * detected key (pitch class 0..11). Shift is the shortest-arc delta, so a
 * key change rotates the whole palette as one body -- C-major TWILIGHT and
 * F#-minor TWILIGHT are the same world, tuned to different keys.
 * @param {number} anchorHue the biome's resting hue (0..360)
 * @param {number} tonic pitch class 0..11 (spectralHue maps it to 0..330)
 * @returns {number} degrees to rotate (shortest arc)
 */
export function spectralShiftDeg(anchorHue, tonic) {
  return hueDelta(anchorHue, spectralHue(tonic || 0));
}

/**
 * The full per-song token table. Every token is an anchor hex rotated by
 * (keyShift + keyRotation + sectionHueBias):
 *   - keyShift: the spectral center -- the biome's anchor hue lands on the
 *     song's key (spectralShiftDeg above).
 *   - keyRotation: KeyDirector's continuous slew (quantized 3deg steps
 *     upstream, so the cache stays hot).
 *   - sectionHueBias: SongForm's section signature (a returning chorus
 *     recolors the whole frame, not just the biome).
 * @param {object} args
 * @param {number} args.tonic pitch class 0..11
 * @param {{sky:string[], silhouette:string, haloColor?:string, edgeLight?:string}} args.biome
 * @param {number} [args.anchorHue] the biome's resting hue; defaults to the
 *   halo's hue (or sky[1]'s) so callers without a declared anchor still
 *   key correctly.
 * @param {number} [args.keyRotation=0] KeyDirector.paletteRotation
 * @param {number} [args.sectionHueBias=0] SongForm section hue bias
 * @param {number} [args.amount=1] 0..1 how far the palette rotates toward
 *   the song's key: 0 keeps the biome's own colors exactly (Phase-1
 *   no-op -- the tokens ARE today's hexes, byte-identical), 1 lands the
 *   anchor hue on the key. Reduced-flash or calm can dial it down.
 * @returns {{baseHue:number, shiftDeg:number, sky:string[], silhouette:string,
 *   halo:string, edgeLight:string|null}}
 */
export function spectralTokens({
  tonic = 0,
  biome = null,
  anchorHue = null,
  keyRotation = 0,
  sectionHueBias = 0,
  amount = 1,
} = {}) {
  const baseHue = spectralHue(tonic);
  // The anchor: an explicit per-biome declaration wins; otherwise fall back
  // to the halo's hue (identity-bearing), then the mid sky stop.
  const effAnchor = anchorHue != null
    ? ((anchorHue % 360) + 360) % 360
    : hueOf((biome && biome.celestial && biome.celestial.haloColor) || (biome && biome.sky && biome.sky[1]) || '#ffffff');
  const keyShift = spectralShiftDeg(effAnchor, tonic) * clamp01(amount);
  const deg = Math.round((keyShift + (keyRotation || 0) + (sectionHueBias || 0)) / 3) * 3;
  const rot = (h) => (deg === 0 ? h : rotateHueHex(h, deg));
  const sky = (biome && biome.sky) || ['#1c2248', '#4a4a7a', '#e8a078'];
  const silhouette = (biome && biome.silhouette) || '#4a4068';
  const halo = (biome && biome.celestial && biome.celestial.haloColor) || '#ffdca0';
  const edge = (biome && biome.edgeLight) || null;
  return {
    baseHue,
    shiftDeg: deg,
    sky: sky.map(rot),
    silhouette: rot(silhouette),
    halo: rot(halo),
    edgeLight: edge ? rot(edge) : null,
  };
}

/** The HUD/film family: cool/warm/pad/rhythm accents derived from the
 *  song's current halo color. When the halo is achromatic (ARCTIC's white
 *  sun), the family falls back to the song's spectral base hue so the
 *  chrome still keys to the song instead of washing to gray.
 * @param {string} haloHex the current keyed halo hex
 * @param {number} baseHue the song's spectral hue (fallback for achromatic halos)
 * @returns {{coolHex:string, warmHex:string, padHex:string, rhythmHex:string, familyHue:number}}
 */
export function spectralFamily(haloHex, baseHue = 0) {
  const { r, g, b } = hexToRgb(haloHex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const familyHue = s < 12 ? baseHue : h;
  const hexOf = (hh, ss, ll) => {
    const rgb = hslToRgb(((hh % 360) + 360) % 360, clamp01(ss / 100), clamp01(ll / 100));
    return rgbToHex(Math.round(rgb.r), Math.round(rgb.g), Math.round(rgb.b));
  };
  return {
    coolHex: hexOf(familyHue + 40, Math.min(100, s + 10), Math.min(78, l + 8)),
    warmHex: hexOf(familyHue - 30, Math.max(40, s), Math.max(20, l - 12)),
    padHex: hexOf(familyHue + 100, Math.max(60, s), 70),
    rhythmHex: hexOf(familyHue + 150, Math.max(70, s), 62),
    familyHue,
  };
}

/** CSS custom-property map for the HUD chrome, derived from the live
 *  spectral tokens. Callers write these to :root only when the token
 *  signature changes (cache-gated upstream) so style is never thrashed.
 * @returns {Record<string,string>} e.g. {'--spec-gold': '#ffd76a', ...}
 */
export function cssVarMap(tokens) {
  const fam = spectralFamily(tokens.halo, tokens.baseHue);
  return {
    '--spec-gold': tokens.halo,
    '--spec-cool': fam.coolHex,
    '--spec-warm': fam.warmHex,
    '--spec-pad': fam.padHex,
    '--spec-rhythm': fam.rhythmHex,
    '--spec-hue': `${Math.round(fam.familyHue)}`,
  };
}

/** One-pole ease toward a target hue shift (degrees). The characters
 *  glide their hue the same way (easeHueDeg with a one-pole); the world
 *  uses this so a key change sweeps the whole palette smoothly and
 *  reduced-flash sees a glide, never a snap. Returns the new eased value.
 * @param {number} cur current eased shift (deg)
 * @param {number} target target shift (deg)
 * @param {number} dtSec seconds since last step
 * @param {number} [tauSec=1.5] glide timescale (FORM_HUE_TAU class)
 */
export function easeSpectralShift(cur, target, dtSec, tauSec = 1.5) {
  const k = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
  const next = cur + k * (target - cur);
  // Snap to zero when both are zero (no work to do, keeps caches cold).
  return Math.abs(next) < 0.001 && target === 0 ? 0 : next;
}

/** The fever gauge's three stops, anchored to the song's tonic so the
 *  gauge literally tracks the key (cool -> gold -> hot-pink, but shifted).
 * @returns {{cool:{h:number,s:number,l:number}, warm:{h:number,s:number,l:number}, hot:{h:number,s:number,l:number}}}
 */
export function feverStops(tonic, haloHex = '#ffd76a') {
  const base = spectralHue(tonic || 0);
  const { r, g, b } = hexToRgb(haloHex);
  const { h, s, l } = rgbToHsl(r, g, b);
  return {
    cool: { h: (base + 140) % 360, s: Math.min(100, s * 0.8 + 12), l: 57 },
    warm: { h: base, s, l: Math.max(55, l) },
    hot: { h: (base + 300) % 360, s: 90, l: 78 },
  };
}
