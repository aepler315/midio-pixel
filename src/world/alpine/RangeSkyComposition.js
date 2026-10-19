import { cameraBasis } from '../terrain/SceneTravel.js';
import { CELESTIAL_RISE_XFRAC, CELESTIAL_SET_XFRAC } from '../DayNight.js';
/** One frame's Range-specific upper-sky ownership. Keep faint star depth
 * behind the live ridge while reserving its body for incidental figures. */
export function createRangeSkyComposition(spaceRidge, canvas, { voyageActive = false } = {}) {
  const corridorAt = spaceRidge.corridor(canvas);
  const allowPoint = (x, y) => {
    const { top, bottom } = corridorAt(x);
    return y < top || y > bottom;
  };
  const starBrightnessAt = (x, y) => {
    const { top, bottom } = corridorAt(x);
    const feather = Math.max(1, canvas.height * 0.025);
    const distance = Math.max(top - y, y - bottom, 0);
    const u = Math.min(1, distance / feather);
    return 0.12 + 0.88 * u * u * (3 - 2 * u);
  };
  return {
    allowPoint,
    starBrightnessAt,
    decorativeAlpha: 0.18,
    showWeaver: !voyageActive,
    weaverOptions: { maxFigures: 1, maxRetained: 0, allowPoint },
    celestialShafts: false,
    biomeRays: false,
  };
}

export function rangeMoonRadius(canvasHeight, scale) {
  return Math.min(Math.max(14, canvasHeight * 0.0361) * scale, canvasHeight * 0.07);
}

// ---------------------------------------------------------------------------
// Range v2 sky hierarchy (Task 13). The reference moon is a secondary object
// about 3.5% of the frame width across, textured and partly crossed by cloud;
// the sky holds sparse, low-contrast cloud banks that leave the SpaceRidge
// corridor and the Dancing Ridge their own space.

/** Moon radius under Range v2: ~3.5% of the frame width across. */
export function rangeV2MoonRadius(canvasWidth, approachScale = 1) {
  return canvasWidth * 0.0175 * Math.min(1.25, Math.max(0.85, approachScale));
}

/** The Range samples a slow, visible part of the lunar orbit over one
 * song. The solar clock's long-song predawn/day/afterglow schedule never
 * enters its moon phase; using that phase hid the moon for the whole song.
 * This angular path has no storm gate, screen offset or ridge displacement. */
export function rangeMoonOrbit(timeMs, durationMs) {
  const p = Math.max(0, Math.min(1, durationMs > 0 ? timeMs / durationMs : 0));
  return { azimuth01: .12 + .76 * p, altitude01: .4 + .35 * Math.sin(Math.PI * p) };
}

const railSkyFrames = new WeakMap();

/** Normal views author sky anchors in the unmoved rail's image. Lift each
 * anchor into that rail's direction basis, then use the actual terrain
 * pose/lens/crop. Both partitions project before a travel blend. */
export function projectRailSky(point, snapshot) {
  let frame = railSkyFrames.get(snapshot);
  if (!frame) {
    const prepare = camera => ({ ...camera, reference: cameraBasis(camera.referencePose),
      tan: Math.tan(camera.referencePose.fovYDeg * Math.PI / 360),
      projection: { basis: cameraBasis(camera.pose), tan: Math.tan(camera.pose.fovYDeg * Math.PI / 360) } });
    // The immutable frame snapshot is shared by every star/cloud/body.
    // Weak ownership releases these bases when that frame is discarded.
    frame = { from: prepare(snapshot.from), to: snapshot.to ? prepare(snapshot.to) : null };
    railSkyFrames.set(snapshot, frame);
  }
  const one = camera => {
    const { pose, aspect, reference: { forward, right, up }, tan, projection } = camera;
    const x = (point.xFrac * 2 - 1) * tan * aspect, y = (1 - point.yFrac * 2) * tan;
    return projectSkyDirection(pose, forward.map((v, i) => v + right[i] * x + up[i] * y), aspect, projection);
  };
  const a = one(frame.from), b = frame.to ? one(frame.to) : a, k = snapshot.mix || 0;
  return { xFrac: a.xFrac + (b.xFrac - a.xFrac) * k, yFrac: a.yFrac + (b.yFrac - a.yFrac) * k,
    visible: k < .5 ? a.visible : b.visible };
}

export function projectRailCelestials(state, snapshot, solar = null) {
  const scaleFor = c => Math.tan(c.referencePose.fovYDeg * Math.PI / 360)
    / Math.tan(c.pose.fovYDeg * Math.PI / 360) / (1 - (c.pose.viewOffset?.fx || 0));
  const k = snapshot.mix || 0, a = scaleFor(snapshot.from), b = snapshot.to ? scaleFor(snapshot.to) : a;
  const bodies = {};
  for (const name of ['sun', 'moon']) bodies[name] = Object.freeze({ ...state[name],
    ...projectRailSky(state[name], snapshot), radiusFrac: state[name].radiusFrac * (a + (b - a) * k) });
  if (solar) bodies.moon = Object.freeze({ ...bodies.moon, illuminant: Object.freeze(projectRailSky(solar, snapshot)) });
  return Object.freeze({ ...state, ...bodies });
}

/** Project both celestial bodies through the terrain's resolved tour pose.
 * Azimuth follows the body's arc continuously; dawn/dusk never flips a
 * compass direction, and bounded elevation avoids a zenith dive through
 * the top edge of a narrow landscape lens. */
export function projectRangeCelestials(state, pose, lensScale = 1, solar = null) {
  const bodies = {};
  for (const name of ['sun', 'moon']) {
    const source = state[name];
    // The published Teton flight looks northeast with a narrow lens and
    // a slightly downward aim. Sample a slow lunar arc over that skyline;
    // a 150-degree orbit or a zenith-height moon stays outside the flight.
    const azimuth = name === 'moon' ? 50 + 30 * (source.azimuth01 ?? .5) : 100 + 150 * (source.azimuth01 ?? .5);
    const worldDirection = tourSkyDirection(azimuth, (name === 'moon' ? 4 : 32) * source.altitude01);
    bodies[name] = Object.freeze({ ...source, radiusFrac: source.radiusFrac / lensScale,
      ...projectSkyDirection(pose, worldDirection, pose.aspect), worldDirection: Object.freeze(worldDirection) });
  }
  if (solar) {
    const azimuth = (solar.xFrac - CELESTIAL_RISE_XFRAC) / (CELESTIAL_SET_XFRAC - CELESTIAL_RISE_XFRAC);
    const sun = tourSkyDirection(100 + 150 * azimuth, 32 * solar.altSigned);
    const moon = bodies.moon.worldDirection, { forward, right, up } = cameraBasis(pose);
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    // Project the direction of sunlight in the moon's tangent plane. This
    // works even when the sun is behind the camera or below the horizon;
    // projecting its point directly would return an offscreen sentinel.
    const depth = dot(moon, forward), sunDepth = dot(sun, forward);
    const dx = dot(sun, right) * depth - dot(moon, right) * sunDepth;
    const dy = dot(sun, up) * depth - dot(moon, up) * sunDepth;
    bodies.moon = Object.freeze({ ...bodies.moon, illuminant: Object.freeze({
      xFrac: bodies.moon.xFrac + dx / (pose.aspect || 16 / 9), yFrac: bodies.moon.yFrac - dy }) });
  }
  return Object.freeze({ ...state, ...bodies });
}

const hash = (i, salt) => {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Lunar maria: a few soft darker basins, fixed on the face (clipped to it). */
export function drawMoonMaria(ctx, cx, cy, R, alpha = 1) {
  const basins = [[-0.28, -0.22, 0.34], [0.12, -0.3, 0.22], [-0.05, 0.1, 0.28], [0.3, 0.18, 0.16], [-0.35, 0.28, 0.14]];
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  for (const [dx, dy, r] of basins) {
    const g = ctx.createRadialGradient(cx + dx * R, cy + dy * R, 0, cx + dx * R, cy + dy * R, r * R);
    g.addColorStop(0, `rgba(96,104,122,${(0.28 * alpha).toFixed(3)})`);
    g.addColorStop(1, 'rgba(96,104,122,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  }
  ctx.restore();
}

/** Cloud drift, as a fraction of the frame width per second of heard time:
 *  one wind for the whole sky, so the banks move together, slowly, the same
 *  way (about seven minutes to cross the frame). */
export const CLOUD_DRIFT_W_PER_SEC = 0.0025;

/**
 * Deterministic cloud banks for a frame: sparse, elongated, drifting slowly
 * in heard time (pure: pause holds, seek reconstructs). Every bank moves
 * with the one wind (nearer, lower banks a little faster), and `panPx` /
 * `panYPx` carry them with the camera's turn and tilt, so they hang in the sky over the
 * land instead of sliding across the screen on their own.
 */
export function rangeCloudBanks({ width, height, tSec = 0, seed = 0, panPx = 0, panYPx = 0, count = 7 }) {
  const banks = [];
  const span = width * 1.6;
  for (let i = 0; i < count; i++) {
    const y01 = hash(i, seed + 3);
    const speed = width * CLOUD_DRIFT_W_PER_SEC * (0.85 + 0.3 * y01);
    const raw = hash(i, seed + 2) * span + tSec * speed + panPx;
    const x = ((raw % span) + span) % span - width * 0.3;
    const y = height * (0.06 + 0.3 * y01) + panYPx;
    const w = width * (0.12 + 0.16 * hash(i, seed + 4));
    banks.push({ id: `bank${i}`, x, y, w, h: w * (0.1 + 0.06 * hash(i, seed + 5)), alpha: 0.28 + 0.14 * hash(i, seed + 6), puffs: 7 });
  }
  return banks;
}

/** How far the sky has turned for a camera pose, as tangents (independent
 *  of any lens): where the direction `refForward` (the unmoved rail's view
 *  direction) lies right of (x) and above (y) the pose's view axis. Divide
 *  by the rendered tan(fovY/2) (times the aspect, for x) to get NDC. */
export function skyTurn(pose, refForward) {
  if (!pose || !refForward) return { x: 0, y: 0 };
  const { forward, right, up } = cameraBasis(pose);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(refForward, forward);
  if (!(depth > 1e-6)) return { x: 0, y: 0 };
  return { x: dot(refForward, right) / depth, y: dot(refForward, up) / depth };
}

/** Paint cloud banks: a dark body with a lit rim toward the light. */
export function drawRangeClouds(ctx, banks, { dark = [52, 60, 78], lit = [196, 176, 168], light = null, allowPoint = null, alpha = 1, directGain = 1 } = {}) {
  ctx.save();
  for (const b of banks) {
    const lx = light ? Math.sign(light.x - b.x) : 0, ly = light ? (light.y < b.y ? -1 : 1) : -1;
    for (let p = 0; p < b.puffs; p++) {
      const u = b.puffs === 1 ? 0.5 : p / (b.puffs - 1);
      const px = b.x - b.w / 2 + u * b.w;
      const py = b.y + Math.sin(u * 9 + (b.phaseWidth ?? b.w)) * b.h * 0.25;
      if (allowPoint && !allowPoint(px, py)) continue;
      const rx = b.h * (1.3 + 0.9 * Math.sin(u * Math.PI)), ry = b.h * (0.55 + 0.35 * Math.sin(u * Math.PI));
      for (const [col, off, a] of [[lit, 0.2, 0.75 * directGain], [dark, -0.06, 1]]) {
        const ox = px + lx * rx * off, oy = py + ly * ry * off;
        const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rx);
        g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${(b.alpha * a * alpha).toFixed(3)})`);
        g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(ox, oy);
        ctx.scale(1, ry / rx);
        ctx.translate(-ox, -oy);
        ctx.beginPath();
        ctx.arc(ox, oy, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

/** Compass azimuth: east +X, north -Z. Celestial directions stay in world space. */
export function tourSkyDirection(azimuthDeg, altitudeDeg) {
  const az=azimuthDeg*Math.PI/180,alt=altitudeDeg*Math.PI/180,c=Math.cos(alt);
  return [Math.sin(az)*c,Math.sin(alt),-Math.cos(az)*c];
}
export function projectSkyDirection(pose,direction,aspect=16/9,projection=null) {
  const {forward,right,up}=projection?.basis || cameraBasis(pose),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const depth=dot(direction,forward),tan=projection?.tan ?? Math.tan(pose.fovYDeg*Math.PI/360);
  if(depth<=0)return {xFrac:-10,yFrac:-10,visible:false};
  let x=dot(direction,right)/(depth*tan*aspect),y=dot(direction,up)/(depth*tan);
  if (pose.viewOffset) {
    const { fx, rx, uy } = pose.viewOffset;
    x = (x - rx / (tan * aspect)) / (1 - fx);
    y = (y - uy / tan) / (1 - fx);
  }
  return {xFrac:(x+1)/2,yFrac:(1-y)/2,visible:Math.abs(x)<1.2&&Math.abs(y)<1.2};
}
/** A complete sky cylinder: camera yaw exposes different persistent banks. */
export function tourCloudBanks({pose,width,height,tSec=0,seed=0,count=36,lensScale=1}) {
  const banks=[];
  for(let i=0;i<count;i++){
    const az=hash(i,seed+2)*360+tSec*CLOUD_DRIFT_W_PER_SEC*40;
    const direction=tourSkyDirection(az,8+hash(i,seed+3)*25);
    const p=projectSkyDirection(pose,direction,width/height);
    if(!p.visible)continue;
    const w=width*(.12+.16*hash(i,seed+4));
    banks.push({id:`worldBank${i}`,x:p.xFrac*width,y:p.yFrac*height,phaseWidth:w,w:w/lensScale,h:w*(.1+.06*hash(i,seed+5))/lensScale,alpha:.28+.14*hash(i,seed+6),puffs:7});
  }
  return banks;
}
