// Legacy silhouette geometry and neutral shader uniforms. Runtime peaks
// belong to local cast motes; prepared views no longer allocate giant masks.
import { MIDIO_BODY, MIDIO_EYE_CY, MIDIO_EYE_SOCKET_R, BROSHI_BODY, BROSHI_HEAD, BROSHI_TAIL, MIDASUS_MESH } from '../../render/meshes.js';
import { scenePoseAt, projectPoint } from '../terrain/SceneTravel.js';
import { terrainHeightAt } from './TerrainMesh.js';
import { MIRROR_LEVEL_TOLERANCE_M } from './WaterMirror.js';
const MASK_SIZE = 128;
export const giantMaskBytes = () => MASK_SIZE * MASK_SIZE * 4;
const clamp = x => Math.max(0, Math.min(1, x));
// Peaks now belong to the cast's local lanterns and motes.
export function giantAmounts() { return [0, 0, 0]; }

function polygons(meshes) {
  return meshes.map(m => m.vertices.slice(1).map(v => [v.x, -v.y]));
}
function distanceToEdge(p, a, b) {
  const x = b[0] - a[0], y = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * x + (p[1] - a[1]) * y) / Math.max(1e-8, x*x + y*y));
  return Math.hypot(p[0] - a[0] - t*x, p[1] - a[1] - t*y);
}
function softPolygon(p, poly) {
  let inside = false, d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0]-a[0]) * (p[1]-a[1]) / (b[1]-a[1]) + a[0]) inside = !inside;
    d = Math.min(d, distanceToEdge(p, a, b));
  }
  return clamp(.5 + (inside ? d : -d) / .035);
}
export function giantMaskData() {
  const star = MIDASUS_MESH.vertices;
  const tail = BROSHI_TAIL.vertices;
  const groups = [polygons([MIDIO_BODY]), [...polygons([BROSHI_BODY, BROSHI_HEAD]), tail.map(v => [v.x, -v.y])],
    [star.slice(1,4).map(v => [v.x,-v.y]), star.slice(4,7).map(v => [v.x,-v.y])]];
  let eye = null;
  const normalized = groups.map((polys, g) => {
    const pts = polys.flat(), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs)+Math.max(...xs))/2, cy = (Math.min(...ys)+Math.max(...ys))/2;
    const span = Math.max(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)) / .84;
    // Midio's eye is an open socket in the giant, the one feature that
    // makes the shard read as him.
    if (g === 0) eye = { c: [-cx/span, (-MIDIO_EYE_CY-cy)/span], r: MIDIO_EYE_SOCKET_R*1.05/span };
    return polys.map(poly => poly.map(p => [(p[0]-cx)/span, (p[1]-cy)/span]));
  });
  const out = new Uint8Array(giantMaskBytes());
  for (let y = 0; y < MASK_SIZE; y++) for (let x = 0; x < MASK_SIZE; x++) {
    const p = [(x+.5)/MASK_SIZE-.5, (y+.5)/MASK_SIZE-.5], i = (y*MASK_SIZE+x)*4;
    for (let c = 0; c < 3; c++) out[i+c] = Math.round(255 * Math.max(...normalized[c].map(poly => poly.length === 2
      ? clamp(1 - distanceToEdge(p, poly[0], poly[1]) / .028) : softPolygon(p,poly))));
    out[i] = Math.round(out[i] * clamp((Math.hypot(p[0]-eye.c[0], p[1]-eye.c[1]) - eye.r) / .012 + .5));
    out[i+3] = 255;
  }
  return out;
}
export function giantUniforms(THREE) {
  return { uGiantMask: { value: null }, uGiantPeak: { value: [0,0,0] },
    uSkyGiantCenter: { value: Array.from({length:3}, () => new THREE.Vector3()) },
    uGiantCenter: { value: Array.from({length:3}, () => new THREE.Vector3()) }, uGiantSpan: { value: [5000,5000,8000] },
    uGiantRight: { value: new THREE.Vector3(1,0,0) }, uGiantForward: { value: new THREE.Vector3(0,0,1) },
    uShadowEye: { value: new THREE.Vector3() }, uMidioCloud: { value: 0 }, uGiantTime: { value: 0 },
    uMirrorAspect: { value: 1 }, uSkyGiantSpan: { value: 5000 } };
}
const SIGHT_STEPS = 32;
/** Lake samples given a line-of-sight test, which bounds the synchronous
 *  cost of preparing a view (MAX_SIGHT_TESTS * SIGHT_STEPS height reads). */
const MAX_SIGHT_TESTS = 96;
// Whether ground (with a tree's clearance) hides `p` from `eye`.
// The clearance tapers to nothing at the sample itself.
function seenFrom(data, eye, p) {
  const len = Math.hypot(p[0]-eye[0], p[2]-eye[2]);
  for (let i = 1; i < SIGHT_STEPS; i++) {
    const t = i / SIGHT_STEPS, x = eye[0] + (p[0]-eye[0])*t, z = eye[2] + (p[2]-eye[2])*t;
    const clearance = 25 * Math.min(1, (1-t) * len / 600);
    if (terrainHeightAt(data, x, z) + clearance > eye[1] + (p[1]-eye[1])*t + .5) return false;
  }
  return true;
}
/** Anchors chosen from real samples visible at the reference rail station.
 * Metre sizes follow relief and viewing distance; resizing cannot move them. */
export function giantLayout(data, view, heightRange, waterLevelM) {
  const pose = scenePoseAt(view, { progress01: .5 }), d = pose.targetM.map((v,i) => v - pose.eyeM[i]);
  const l = Math.hypot(d[0], d[2]) || 1, forward = [d[0]/l,0,d[2]/l], right = [-forward[2],0,forward[0]];
  let mountain = null, water = null, best = Infinity;
  const shore = [];
  for (const tile of data.tiles.values()) {
    if (!tile.visible) continue;
    const n = tile.samples, step = Math.max(1, Math.floor(n/16));
    for (let y=0; y<n; y+=step) for (let x=0; x<n; x+=step) {
      const i=y*n+x, h=tile.heightsM[i]; if (!Number.isFinite(h)) continue;
      const p=[data.grid.originM[0]+(tile.ix*data.cells+x*tile.stride)*data.grid.cellSizeM,h,
        data.grid.originM[1]+(tile.iz*data.cells+y*tile.stride)*data.grid.cellSizeM];
      const q=projectPoint(pose,16/9,p);
      if (!q || q.depth < 300 || Math.abs(q.x) > .8 || Math.abs(q.y) > .95) continue;
      if (tile.flowBytes?.[i] === 255 && Number.isFinite(waterLevelM)) {
        // Only the lake the mirror reflects (the terrain shader's gate).
        if (Math.abs(q.x) < .45 && Math.abs(h - waterLevelM) < MIRROR_LEVEL_TOLERANCE_M) shore.push([q.x, q.y, p]);
      } else if (q.depth >= 1800 && Math.abs(q.y) <= .8) {
        const score=(q.x+.12)**2+(q.y-.02)**2;
        if (score<best) { mountain=p; best=score; }
      }
    }
  }
  const every = Math.max(1, Math.ceil(shore.length / MAX_SIGHT_TESTS));
  const wet = shore.filter((w, i) => i % every === 0 && seenFrom(data, pose.eyeM, w[2]));
  // The far shore of the main lake, near the middle of the frame: the
  // reflection hangs from there toward the viewer, in front of the
  // reflected range. A percentile keeps stray far water from winning.
  if (wet.length) {
    const farY = wet.map(w => w[1]).sort((a,b) => a-b)[Math.floor(wet.length*.85)];
    let wetBest = Infinity;
    for (const [x,y,p] of wet) { const score=x*x+(y-farY)**2*4; if (score<wetBest) { water=p; wetBest=score; } }
  }
  mountain ||= [...pose.targetM];
  const relief = Math.max(800, heightRange[1]-heightRange[0]);
  const dist = Math.hypot(...mountain.map((v,i)=>v-pose.eyeM[i]));
  const span = Math.max(relief*2.4, dist*Math.tan(pose.fovYDeg*Math.PI/360)*1.45);
  const cloud = [pose.eyeM[0]+forward[0]*dist*.65, heightRange[0], pose.eyeM[2]+forward[2]*dist*.65];
  const tanHalf = Math.tan(pose.fovYDeg*Math.PI/360);
  const skyCenter = [pose.eyeM[0]+forward[0]*dist, pose.eyeM[1]+d[1]/l*dist+dist*tanHalf*.38, pose.eyeM[2]+forward[2]*dist];
  // The sky figure stands half the frame tall over the range, its lower
  // points behind the peaks; any larger and it is only a glow.
  const skySpan = dist*tanHalf*2*.5/.84;
  // The impossible reflection's virtual source stands just beyond the far
  // shore, in front of the range, so the mountains never hide it.
  const reflection = water ? [water[0]+forward[0]*150,waterLevelM,water[2]+forward[2]*150] : cloud;
  return { centers: [reflection, mountain, cloud], skyCenters: [skyCenter, mountain, skyCenter], spans: [Math.max(relief*3,span*1.5), span, span*1.6], skySpan, right, forward,
    hasLake: !!water && Number.isFinite(waterLevelM) };
}
/** Midio's sheet stays at least `minM` ahead of the live eye along the
 * view's forward axis, so a listener's zoom can never dolly past it. */
export function aheadOfEye(center, eye, forward, minM) {
  const depth = (center[0]-eye[0])*forward[0] + (center[2]-eye[2])*forward[2];
  if (depth >= minM) return center;
  const push = minM - depth;
  return [center[0]+forward[0]*push, center[1], center[2]+forward[2]*push];
}
/** Midio's mirrored sheet, sized to what the lake can show this frame. The
 * reflected ray through the frame's lower edge meets the sheet at this
 * height; Midio fills it, reaching from
 * the far shore to the frame's lower edge, taller in the water than any
 * mirrored peak. `bottomDir` is that ray in world space. */
export function mirrorGiantSpan(eye, bottomDir, center, levelM, lift, fallback) {
  const run = Math.hypot(bottomDir[0], bottomDir[2]);
  if (!(run > 1e-6) || !(bottomDir[1] < 0)) return fallback;
  // The water at the frame's edge lies where that ray meets the lake; the
  // mirror eye sees through it at lift times the real ray's slope.
  const reach = lift * (Math.hypot(center[0]-eye[0], center[2]-eye[2]) * -bottomDir[1] / run - (eye[1] - levelM));
  return reach > 50 ? reach / .9 : fallback;
}
export const GIANT_GLSL = /* glsl */`
  uniform sampler2D uGiantMask;
  uniform float uGiantPeak[3];
  uniform vec3 uGiantCenter[3];
  uniform float uGiantSpan[3];
  uniform vec3 uGiantRight;
  uniform vec3 uGiantForward;
  uniform vec3 uShadowEye;
  uniform float uMidioCloud;
  uniform float uGiantTime;
  float giantMask(vec2 uv, int actor) {
    if (any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0)))) return 0.0;
    vec3 mask=texture(uGiantMask,uv).rgb;
    return actor == 0 ? mask.r : actor == 1 ? mask.g : mask.b;
  }
  // Shadow of a caster plane through the anchor, facing the view, thrown
  // by a lantern at the eye: each receiver looks back along its own ray.
  // Only the range beyond the near ground receives it.
  float broshiShadow(vec3 p) {
    if (uGiantPeak[1] <= 0.0) return 0.0;
    vec3 ray=p-uShadowEye;
    float plane=dot(uGiantCenter[1]-uShadowEye,uGiantForward), depth=dot(ray,uGiantForward);
    if (plane <= 0.0 || depth <= 0.0) return 0.0;
    vec3 d=uShadowEye+ray*(plane/depth)-uGiantCenter[1];
    vec2 uv=vec2(dot(d,uGiantRight),d.y)/uGiantSpan[1]+.5;
    return giantMask(uv,1)*uGiantPeak[1]*smoothstep(.45,.7,depth/plane);
  }
  float giantCloud(vec3 p) {
    float mask=0.0;
    for (int i=0;i<3;i+=2) {
      if (uGiantPeak[i]<=0.0 || (i==0 && uMidioCloud<.5)) continue;
      vec3 d=p-uGiantCenter[i];
      vec2 uv=vec2(dot(d,uGiantRight),dot(d,uGiantForward))/uGiantSpan[i]+.5;
      // Slow advected wisps break the silhouette as it dissolves.
      uv+=vec2(sin(p.z*.003+uGiantTime*.11),cos(p.x*.002+uGiantTime*.09))*.009*(1.0-uGiantPeak[i]);
      mask=max(mask,giantMask(uv,i)*uGiantPeak[i]);
    }
    return mask;
  }
`;
