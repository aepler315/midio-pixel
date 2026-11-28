// Landscape camera tuning in one place: how much land a frame holds and how
// fast the camera may change its mind. Every value here is a named knob for
// review; the camera code reads them and stays a pure function of heard time.
//
// Two goals pull against each other and are tuned together:
//   - more land: a wider standing lens, gentler push-ins, and a Songprint
//     orbit that circles from further out over a longer arc;
//   - no frantic sweeps: musical accents lean in over seconds instead of
//     lunging in under one, and the opening close-up widens at an even
//     perceived rate instead of snapping out at its end.
// tools/camera-motion-report.mjs measures both on the real camera path.

/** Standing lens, as a scale on the authored half-angle tangent. Applied to
 *  authored rails and the Songprint orbit (never to shot tours, Camera
 *  Studio, the glacier or Dual Summits, which own their framing). Terrain
 *  packages are baked for a 2.1:1 frame at 1.2x this tangent ("core"
 *  framing, TerrainTiles VISIBILITY), so 1.15 at 16:9 or the 2.07:1
 *  reference stays inside full-detail coverage. */
export const CAMERA_FRAME = Object.freeze({ wideLensTan: 1.15 });

/** Musical accents on the structural move (CinematicPulse cues). The cue
 *  times and sides come from the shared pulse; the camera uses its own
 *  slower envelope: lean in over `leadMs`, hold, release over `releaseMs`.
 *  Amplitudes are fractions of the rail distance (yaw in radians). The old
 *  accent arrived in 0.9 s and alternated sides, which read as a whip pan. */
export const CAMERA_ACCENT = Object.freeze({
  leadMs: 3200, holdMs: 900, releaseMs: 5600,
  dolly: .018, yaw: .02, crane: .014, truck: .008,
});

/** Structural move amplitudes (RangeCamera keys), as fractions of the rail
 *  distance (yaw in radians). Push-ins are kept short of the old values so
 *  the frame keeps more of the range. Reveals can pull back. */
export const CAMERA_MOVES = Object.freeze({
  limits: Object.freeze({ dolly: [-.08, .1], yaw: [-.045, .045], crane: [0, .04], truck: [-.018, .018] }),
  establishDolly: Object.freeze([.015, .04]),
  pushDolly: Object.freeze([.035, .08]),
  settleDolly: Object.freeze([.01, -.03]),
  revealDolly: Object.freeze([-.01, -.06]),
  revealYaw: Object.freeze([.014, .03]),
  revealTruck: Object.freeze([.004, .01]),
});

/** The reveal lens gathers before a major arrival and opens over five
 *  seconds. Its tightest crop as a half-angle scale (was .84). */
export const REVEAL_CROP = .92;

/** The Songprint orbit: how far from its pivot the eye circles, as fractions
 *  of the rail's home radius at the start and end of the song (was .69 to
 *  .87), the candidate arc extents in radians (largest first), and how long
 *  the hand-off from the rail to the orbit takes when the print arrives
 *  after playback began. */
export const ORBIT_FRAME = Object.freeze({
  radius: Object.freeze([.86, 1.04]),
  sweeps: Object.freeze([1.05, .88, .67, .44]),
  handoffMs: 12000,
  // Rates are smoothed over this window and held within this ratio of their
  // mean, so a loud passage speeds the arc without lurching it.
  rateSmoothMs: 4000,
  rateCeiling: 1.7,
});

/** 2 * atan(tan(fov / 2) * scale), in degrees. */
export function widenLens(fovYDeg, scale = CAMERA_FRAME.wideLensTan) {
  if (!Number.isFinite(fovYDeg) || !(scale > 0) || scale === 1) return fovYDeg;
  return 360 / Math.PI * Math.atan(Math.tan(fovYDeg * Math.PI / 360) * scale);
}
