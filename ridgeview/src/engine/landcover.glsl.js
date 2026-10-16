// Land cover, shared by the terrain shader and the 3D trees so a tree
// stands exactly where the ground shader paints forest. Needs NOISE.
//   tx   tile texel: east slope, north slope, water class, convexity
//   gp   world-locked mercator metres (mod 2048), north-up
//   h    height (m); up: local vertical (ECEF unit)
export const LANDCOVER = /* glsl */ `
uniform float uSnowShift, uTreeShift, uForestDensity, uForestFloor, uDryness;

float table(float x, const float xs[10], const float ys[10]) {
  if (x <= xs[0]) return ys[0];
  for (int i = 1; i < 10; i++) if (x <= xs[i]) return mix(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
  return ys[9];
}
const float LATS[10] = float[10](0.0, 20.0, 30.0, 37.0, 44.0, 50.0, 55.0, 60.0, 66.0, 75.0);
const float TREE[10] = float[10](3900.0, 3900.0, 3700.0, 3400.0, 3050.0, 2300.0, 1600.0, 1050.0, 600.0, 0.0);
const float SNOW[10] = float[10](4800.0, 4800.0, 4500.0, 3900.0, 3500.0, 2900.0, 2400.0, 1900.0, 1300.0, 500.0);

float fbm2(vec2 p, float per) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p, per); p *= 2.0; per *= 2.0; a *= 0.5; }
  return s;
}

struct Cover {
  float rock, scree, forest, snow, alpine, moist, water, sea, poleward, slope, sdeg, cvx;
  float fL, fM, fS, nS, tl, sl;
  vec2 warp;
};

Cover landCover(vec4 tx, vec2 gp, float h, vec3 up) {
  Cover c;
  c.slope = length(tx.xy);
  c.sdeg = degrees(atan(c.slope));
  c.cvx = tx.w;
  c.water = smoothstep(0.2, 0.32, tx.z);
  c.sea = smoothstep(0.7, 0.8, tx.z);
  float lat = degrees(asin(clamp(up.z, -1.0, 1.0)));
  float alat = abs(lat);
  vec2 nh0 = vec2(-tx.x, -tx.y);
  // +1 on poleward-facing slopes (cooler, moister, holds snow)
  c.poleward = (lat >= 0.0 ? -nh0.y : nh0.y) / max(length(nh0), 1e-3) * smoothstep(0.05, 0.3, c.slope);
  // Multi-scale, domain-warped variation (periodic in 2048 m).
  c.warp = vec2(fbm2(gp / 256.0 + 3.7, 8.0), fbm2(gp / 256.0 + 9.2, 8.0));
  c.fL = fbm2(gp / 512.0 + vec2(1.3, 7.1), 4.0);
  c.fM = fbm2(gp / 128.0 + c.warp * 0.9, 16.0);
  c.fS = fbm2(gp / 32.0 + c.warp * 2.5, 64.0);
  c.nS = vnoise(gp / 8.0, 256.0);
  c.tl = table(alat, LATS, TREE) + uTreeShift + c.fL * 120.0;
  c.sl = table(alat, LATS, SNOW) + uSnowShift + c.fL * 200.0 - c.poleward * 260.0 + c.cvx * 50.0;
  // Mostly the real steepness, so outcrops follow cliff bands, not noise blobs.
  float steep = c.sdeg + c.fM * 3.5 + c.fS * 1.5;
  c.alpine = smoothstep(c.tl - 50.0, c.tl + 450.0, h + c.fM * 60.0);
  // Below the treeline forest holds slopes up to ~45 degrees; above it rock shows sooner.
  c.rock = smoothstep(mix(40.0, 33.0, c.alpine), mix(50.0, 43.0, c.alpine), steep);
  c.rock = max(c.rock, c.alpine * smoothstep(17.0, 31.0, steep - c.cvx * 5.0));
  c.rock = max(c.rock, smoothstep(0.6, 1.8, c.cvx) * smoothstep(22.0, 32.0, c.sdeg) * (0.35 + 0.65 * c.alpine));
  c.rock *= 1.0 - c.water;
  c.scree = (1.0 - c.rock) * smoothstep(-0.1, -0.9, c.cvx + c.fS * 0.4) * smoothstep(20.0, 30.0, c.sdeg) * smoothstep(c.tl - 700.0, c.tl - 100.0, h);
  // Forest: elevation band, slope, moisture (poleward slopes and hollows are wetter).
  float band = smoothstep(c.tl + 40.0, c.tl - 380.0, h + c.fM * 120.0) * smoothstep(uForestFloor - 120.0, uForestFloor + 160.0, h + c.fM * 120.0);
  c.moist = 0.6 + c.poleward * (0.12 + 0.35 * uDryness) - c.cvx * 0.1 - uDryness * 0.45;
  float pot = band * (1.0 - smoothstep(40.0, 50.0, c.sdeg)) * (1.0 - c.rock) * (1.0 - c.water);
  // Dry valley floors stay open (sage, grass); wetter climates forest them.
  pot *= mix(1.0, smoothstep(2.0, 7.0, c.sdeg + c.fM * 4.0), clamp(uDryness * 4.0, 0.0, 1.0));
  // Avalanche paths and slide scars: open patches in steep hollows.
  float chute = smoothstep(0.2, 0.55, vnoise(gp / 64.0 + c.warp * 0.8, 32.0))
              * smoothstep(24.0, 32.0, c.sdeg) * smoothstep(-0.2, -0.8, c.cvx + c.fM * 0.4);
  float cover = c.moist + c.fM * 0.32 + c.fS * 0.14 + (uForestDensity - 0.65) * 0.9 - (1.0 - band) * 0.6 - chute * 0.7;
  c.forest = smoothstep(0.36, 0.56, cover) * smoothstep(0.02, 0.25, pot);
  float snowLine = smoothstep(c.sl - 60.0, c.sl + 160.0, h + c.fM * 90.0 + c.nS * 20.0);
  float snowHold = 1.0 - smoothstep(42.0, 58.0, c.sdeg + c.fS * 6.0);
  c.snow = snowLine * snowHold;
  // Couloirs and shaded hollows hold snow well below the snowline.
  float gully = smoothstep(c.sl - 750.0, c.sl - 250.0, h + c.fM * 120.0) * smoothstep(-0.15, -0.9, c.cvx + c.fS * 0.3)
              * smoothstep(-0.2, 0.5, c.poleward) * (1.0 - smoothstep(40.0, 55.0, c.sdeg));
  c.snow = max(c.snow, gully);
  c.snow = max(c.snow, snowLine * 0.35 * smoothstep(52.0, 40.0, c.sdeg)); // dusting on rock
  c.snow *= 1.0 - c.water * (1.0 - smoothstep(-1500.0, -2500.0, uSnowShift)); // lakes freeze only in deep winter
  return c;
}
`;
