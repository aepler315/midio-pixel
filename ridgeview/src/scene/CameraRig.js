// The viewer's camera: an ECEF position kept in float64 (JS numbers) and an
// orientation quaternion in ECEF axes. The three.js camera itself always
// sits at the origin; the world is drawn relative to this position.
import * as THREE from 'three';
import { lonLatToEcef, ecefToLonLat, enuBasis, headingPitchToDirection, directionToHeadingPitch, v3 } from '../core/geo.js';

export class CameraRig {
  constructor() {
    this.pos = [0, 0, 0];
    this.q = new THREE.Quaternion();
    this.fov = 40; // vertical, degrees
  }

  get lonLatH() { return ecefToLonLat(this.pos[0], this.pos[1], this.pos[2]); }
  get radialUp() { return v3.norm(this.pos); }

  /** Unit vectors in ECEF. */
  forward() { return vec(new THREE.Vector3(0, 0, -1).applyQuaternion(this.q)); }
  right() { return vec(new THREE.Vector3(1, 0, 0).applyQuaternion(this.q)); }
  upCam() { return vec(new THREE.Vector3(0, 1, 0).applyQuaternion(this.q)); }

  /** Orient to look along `dir` with the horizon level. */
  lookDir(dir, up = this.radialUp) {
    const f = v3.norm(dir);
    let r = v3.cross(f, up);
    if (v3.len(r) < 1e-6) r = v3.cross(f, Math.abs(f[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    r = v3.norm(r);
    const u = v3.cross(r, f);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...r), new THREE.Vector3(...u), new THREE.Vector3(-f[0], -f[1], -f[2]));
    this.q.setFromRotationMatrix(m);
  }

  lookAt(target) { this.lookDir(v3.sub(target, this.pos)); }

  set(lon, lat, h, heading, pitch) {
    lonLatToEcef(lon, lat, h, this.pos);
    this.lookDir(headingPitchToDirection(heading, pitch, lon, lat));
  }

  headingPitch() {
    const { lon, lat } = this.lonLatH;
    return directionToHeadingPitch(this.forward(), lon, lat);
  }

  /** Re-level the horizon (remove roll) after free rotations. */
  level() { this.lookDir(this.forward()); }

  /** Ray through a pixel (ndc in [-1, 1]) as an ECEF unit direction. */
  rayAt(ndcX, ndcY, aspect) {
    const t = Math.tan((this.fov * Math.PI) / 360);
    const d = new THREE.Vector3(ndcX * t * aspect, ndcY * t, -1).normalize().applyQuaternion(this.q);
    return vec(d);
  }

  apply(camera) {
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(this.q);
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  enu() { const { lon, lat } = this.lonLatH; return enuBasis(lon, lat); }

  clone() {
    const c = new CameraRig();
    c.pos = [...this.pos]; c.q.copy(this.q); c.fov = this.fov;
    return c;
  }
}

const vec = (v) => [v.x, v.y, v.z];
