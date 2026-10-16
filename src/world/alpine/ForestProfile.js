// Half crown width in tree-height units; JS reference mirrors the GPU profile.
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function crownHalfWidth(species, v, id, side) {
  if (v < 0 || v >= 1) return 0;
  const base = species === 0 ? .46 + .06 * id : species === 2 ? .015 : .08;
  const ratio = [ .30, .38, .265, .425 ][species] * (.97 + .03 * id);
  const q = Math.max(0, (v - base) / (1 - base));
  const phase = id * 7 + (side < 0 ? .37 : .03), tiers = 6 + Math.floor(id * 4);
  const t = (v * tiers + phase) % 1, tooth = smooth(0, .15, t) * Math.sqrt(1 - t);
  const rag = 1 + .045 * Math.sin(v * 80 + id * 40 + side * 2.3);
  const crown = ratio * .5 * smooth(base - .015, base + .025, v) * Math.pow(1 - q, .8) * (.87 + .13 * tooth) * rag;
  const leader = .0025 * smooth(.85, .94, v) * Math.max(0, (1 - v) / .06);
  return Math.max(crown, leader);
}

export const CROWN_GLSL = /* glsl */`
  float crownBase(float species, float id) { return species < .5 ? .46 + .06 * id : species > 1.5 && species < 2.5 ? .015 : .08; }
  float crownRatio(float species) { return species < .5 ? .30 : species < 1.5 ? .38 : species < 2.5 ? .265 : .425; }
  float crownHalfWidthFiltered(float species, float v, float id, float side, float dv) {
    float base = crownBase(species, id);
    float q = clamp((v - base) / (1.0 - base), 0.0, 1.0);
    float phase = id * 7.0 + (side < 0.0 ? .37 : .03), tiers = 6.0 + floor(id * 4.0);
    float t = fract(v * tiers + phase);
    // Each detail loses contrast before its own period becomes sub-pixel.
    float teeth = 1.0 - smoothstep(.25, .5, dv * tiers);
    float fine = 1.0 - smoothstep(.25, .5, dv * 80.0 / 6.283185);
    float tooth = smoothstep(0.0, .15, t) * sqrt(1.0 - t);
    float rag = 1.0 + .045 * sin(v * 80.0 + id * 40.0 + side * 2.3) * fine;
    float crown = crownRatio(species) * (.97 + .03 * id) * .5 * smoothstep(base - .015, base + .025, v)
      * pow(1.0 - q, .8) * mix(.935, .87 + .13 * tooth, teeth) * rag;
    float leader = .0025 * smoothstep(.85, .94, v) * max(0.0, (1.0 - v) / .06);
    return max(crown, leader);
  }
  float crownHalfWidth(float species, float v, float id, float side) {
    return crownHalfWidthFiltered(species, v, id, side, 0.0);
  }
`;

