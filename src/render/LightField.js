// Movement VII (The Light): one source of truth for "where the sun/moon is
// and how strong it is" -- pure data, no drawing. BiomeManager already knows
// the celestial's screen position (used to draw it) and its crossfaded halo
// color (used by HUD-level effects); this module turns that into a light
// every other draw call can react to, instead of each consumer re-deriving it.

/** The celestial body's screen anchor -- shared by _drawCelestial and
 *  computeLight so the light is always exactly where the sun/moon is drawn.
 *
 *  `celestialXFrac` is the body's horizontal position along its arc (see
 *  DayNight.celestialXFracFor). It used to be pinned at a constant 0.78,
 *  which meant the sun and moon rose and set vertically at one fixed spot
 *  instead of crossing the sky -- and, because every shadow and rim light in
 *  the scene is thrown FROM this point (lightDirTo), it also meant the light
 *  came from the same direction at dawn, noon and dusk. Defaulted to the old
 *  constant so a caller that hasn't opted in is unchanged. */
export const CELESTIAL_DEFAULT_XFRAC = 0.78;
export function celestialScreenPos(canvasWidth, canvasHeight, celestialYFrac = 0.22, celestialXFrac = CELESTIAL_DEFAULT_XFRAC) {
  return { x: canvasWidth * celestialXFrac, y: canvasHeight * celestialYFrac };
}

/**
 * @param {object} p
 * @param {number} p.canvasWidth
 * @param {number} p.canvasHeight
 * @param {number} p.celestialYFrac  vertical position from Dramaturgy's day arc
 * @param {number} [p.celestialXFrac] horizontal position along the body's arc
 *   (DayNight.celestialXFracFor) -- this is what swings the light, and every
 *   shadow thrown from it, across the sky over the course of the cycle
 * @param {string} p.haloColorHex    crossfaded biome halo color (currentHaloColor())
 * @param {number} p.budget          intensityBudget(progress), 0..1
 * @param {number} [p.unravel]       CodaDirector.unravel, 0..1 -- the light goes out with the ending
 * @param {number} [p.dayArcAlpha]   combined dawn/dusk wash alpha, dims the light during transitions
 * @param {boolean} [p.reducedFlash] accessibility toggle -- compresses intensity swings toward a steady
 *   baseline instead of capping a peak, since nothing here is a single flash to clamp
 * @returns {{x:number, y:number, colorHex:string, intensity:number, dirX:number, dirY:number, celestialYFrac:number}}
 */
const REDUCED_FLASH_BASELINE = 0.6;

export function computeLight({
  canvasWidth, canvasHeight, celestialYFrac = 0.22, haloColorHex = '#ffffff',
  budget = 1, unravel = 0, dayArcAlpha = 0, reducedFlash = false,
  celestialXFrac = CELESTIAL_DEFAULT_XFRAC, celestialState = null,
}) {
  const body = celestialState && celestialState[celestialState.activeBody];
  if (body) { celestialXFrac = body.xFrac; celestialYFrac = body.yFrac; haloColorHex = body.colorHex; }
  const { x, y } = celestialScreenPos(canvasWidth, canvasHeight, celestialYFrac, celestialXFrac);
  let intensity = Math.max(0, budget * (1 - unravel) * (1 - 0.5 * dayArcAlpha));
  if (reducedFlash) intensity = 0.5 * intensity + 0.5 * REDUCED_FLASH_BASELINE;
  if (celestialState) intensity *= body?.directGain || 0;
  // Generic downward-ish direction toward the ground, for consumers that
  // want "which way the light falls" without a specific subject position.
  const dir = lightDirTo({ x, y }, canvasWidth * 0.5, canvasHeight);
  return { x, y, colorHex: haloColorHex, intensity, dirX: dir.x, dirY: dir.y, celestialYFrac };
}

/** Normalized vector pointing FROM the light TOWARD a screen point -- the direction light travels to reach it. */
export function lightDirTo(light, x, y) {
  const dx = x - light.x, dy = y - light.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// How far around the frame a crest rim keeps its strength, as a fraction of
// canvas width, and how much of it survives on the far side. The floor is not
// zero on purpose: a ridge whose rim vanished entirely on its dark side would
// lose the edge that makes it readable against the range behind it. This is a
// lighting falloff, not an on/off mask.
const RIM_REACH_FRAC = 0.55;
const RIM_FAR_FLOOR = 0.18;

/**
 * How brightly a backlit crest rim should burn at one screen x.
 *
 * A rim is LIGHT spilling over an edge, so its strength depends on where the
 * source is. Stroked at a constant alpha all the way across the frame -- which
 * is what this used to be -- it stops reading as light at all and becomes
 * neon piping drawn around the mountain: a uniform saturated outline is the
 * one thing a real rim never looks like.
 *
 * Falls off with horizontal distance from the light, squared so the bright
 * region stays tight around the source rather than smearing halfway across
 * the sky.
 *
 * @param {number} screenX
 * @param {number} lightX  the celestial's own screen x (see computeLight)
 * @param {number} canvasWidth
 * @returns {number} 0..1 multiplier, never below RIM_FAR_FLOOR
 */
export function rimGain(screenX, lightX, canvasWidth) {
  const w = Math.max(1, canvasWidth);
  const d = Math.abs(screenX - lightX) / w / RIM_REACH_FRAC;
  const near = Math.max(0, 1 - Math.min(1, d) ** 2);
  return RIM_FAR_FLOOR + (1 - RIM_FAR_FLOOR) * near;
}

// Secondary lights: the celestial above is the only thing that has ever
// illuminated anything else in this scene -- every character and event
// (Midasus's core, a kick-synced ground pulse) reads as bright on its own,
// but none of them casts light. These are small, local, falloff-limited
// sources (see MeshDrawer's `lights` param) that fix that in kind, not in
// scale: they light up whoever's nearby, they don't relight the world.

const GLOW_LIGHT_RADIUS_PX = 130; // a ground pulse's reach -- roughly one slice's neighbors, not the whole screen
const GLOW_LIGHT_INTENSITY_MUL = 0.55; // modest next to the celestial's own budget-scaled intensity

/** Kick-synced ground-glow pulses as MeshDrawer light sources, in screen
 *  space. `glows` is GroundField.activeGlowScreenLights()'s own output
 *  (already resolved to screen x/y + current 0..1 envelope) -- this just
 *  reshapes each into the {x,y,colorHex,intensity,radius} MeshDrawer
 *  expects. Empty in, empty out: silent (zero cost) whenever no pulse is
 *  active, same discipline as the glow itself. */
export function groundGlowLights(glows, haloColorHex) {
  if (!glows || !glows.length) return [];
  const out = [];
  for (const g of glows) {
    const intensity = GLOW_LIGHT_INTENSITY_MUL * g.intensity;
    if (intensity > 0.02) out.push({ x: g.x, y: g.y, colorHex: haloColorHex, intensity, radius: GLOW_LIGHT_RADIUS_PX });
  }
  return out;
}

const CHARACTER_LIGHT_RADIUS_PX = 100;

/** A character's own glow as a light on whoever else is nearby -- e.g.
 *  Midasus's core lighting up Midio when she's drawing close beside him,
 *  not just glowing at him. `hueDeg` (not colorHex) since characters
 *  already work in hue-degrees internally; MeshDrawer reads either.
 *  Returns null below a negligible intensity so callers can push the
 *  result straight into a lights array with a plain truthy filter. */
export function characterGlowLight(x, y, hueDeg, intensity, radius = CHARACTER_LIGHT_RADIUS_PX) {
  if (!(intensity > 0.02)) return null;
  return { x, y, hueDeg, intensity, radius };
}
