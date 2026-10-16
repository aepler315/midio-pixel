// Mouse, keyboard and touch input.
//   wheel                 fly toward (or away from) the point under the cursor
//   left drag             look around from where you are
//   right drag / ctrl     orbit around the point you grabbed
//   middle drag / shift   drag the ground (pan)
//   double click          glide halfway to the point
//   W A S D / Q E         fly; speed follows height above ground
//   arrow keys            look
//   touch                 one finger looks, pinch flies to the midpoint,
//                         two-finger twist/drag orbits
import * as THREE from 'three';
import { v3, clamp } from '../core/geo.js';

export class Controls {
  constructor(canvas, engine, { onUserMove = () => {} } = {}) {
    this.canvas = canvas;
    this.engine = engine;
    this.onUserMove = onUserMove;
    this.enabled = true;
    this.keys = new Set();
    this.dolly = null; // { dir, remaining } in metres along a fixed ray
    this.drag = null;
    this.pointers = new Map();
    this.minAgl = 1.6;
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('dblclick', (e) => this._dbl(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => { if (!isTyping(e)) this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get rig() { return this.engine.rig; }

  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
  }

  _agl() {
    const { lon, lat, h } = this.rig.lonLatH;
    const g = this.engine.groundAt(lon, lat);
    return h - (Number.isFinite(g) ? g : 0);
  }

  // --- Wheel: dolly along the cursor ray -------------------------------------
  _wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    let notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY * 3 : e.deltaY / 100;
    if (e.ctrlKey) notches *= 2.5; // trackpad pinch
    notches = clamp(notches, -4, 4);
    if (e.shiftKey && this.onScrub) { this.onScrub(notches || (e.deltaX ? Math.sign(e.deltaX) : 0)); return; }
    this.onUserMove('wheel');
    this.dollyBy(this._ndc(e), notches);
  }

  /** Move along the ray through ndc; negative notches move in. */
  dollyBy(ndc, notches) {
    const pick = this.engine.pick(ndc[0], ndc[1]);
    const dir = this.rig.rayAt(ndc[0], ndc[1], this.engine.camera.aspect);
    const agl = Math.max(this.minAgl, this._agl());
    let dist = pick ? pick.t : Math.max(agl * 3, 500);
    if (this.dolly && Math.sign(this.dolly.remaining) === Math.sign(-notches)) dist = Math.max(1, dist - this.dolly.remaining);
    const f = Math.pow(0.8, -notches); // < 1 when zooming in
    let move = dist * (1 - f);
    if (!pick && notches > 0) move = -Math.max(agl, 200) * (1 / 0.8 - 1) * notches; // out into the sky: back off
    if (pick && move > 0) move = Math.min(move, pick.t - 1.0);
    const prev = this.dolly && this.dolly.dirKey === key(dir) ? this.dolly.remaining : 0;
    this.dolly = { dir, remaining: prev + move, dirKey: key(dir) };
  }

  // --- Pointer drags -----------------------------------------------------------
  _down(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.classList.add('dragging');
    this.onUserMove('drag');
    if (this.pointers.size === 2) { this._startPinch(); return; }
    let mode = 'look';
    if (e.button === 2 || e.ctrlKey || e.metaKey) mode = 'orbit';
    else if (e.button === 1 || e.shiftKey) mode = 'pan';
    const ndc = this._ndc(e);
    const pick = mode === 'look' ? null : this.engine.pick(ndc[0], ndc[1]);
    if (mode !== 'look' && !pick) mode = 'look';
    this.drag = { mode, x: e.clientX, y: e.clientY, pivot: pick?.point, radius: pick ? v3.len(pick.point) : 0 };
    this.dolly = null;
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pinch) { this._pinchMove(); return; }
    if (!this.drag) return;
    const degPerPx = this.rig.fov / this.canvas.clientHeight;
    if (this.drag.mode === 'look') this.look(-dx * degPerPx, -dy * degPerPx);
    else if (this.drag.mode === 'orbit') this.orbit(this.drag.pivot, -dx * 0.25, -dy * 0.25);
    else if (this.drag.mode === 'pan') this._pan(e);
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) { this.drag = null; this.canvas.classList.remove('dragging'); }
  }

  _dbl(e) {
    const ndc = this._ndc(e);
    const pick = this.engine.pick(ndc[0], ndc[1]);
    if (!pick) return;
    this.onUserMove('dbl');
    this.dolly = { dir: pick.dir, remaining: pick.t * 0.55, dirKey: key(pick.dir) };
  }

  /** Turn the head: yaw about the local vertical, pitch about the camera's right. */
  look(yawDeg, pitchDeg) {
    const rig = this.rig;
    const up = new THREE.Vector3(...rig.radialUp);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, (yawDeg * Math.PI) / 180);
    const right = new THREE.Vector3(...rig.right());
    const fwd = new THREE.Vector3(...rig.forward());
    const elev = Math.asin(clamp(fwd.dot(up), -1, 1));
    const newElev = clamp(elev + (pitchDeg * Math.PI) / 180, -1.55, 1.55);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, newElev - elev);
    rig.q.premultiply(qPitch).premultiply(qYaw);
    rig.level();
  }

  /** Orbit around a world point: yaw about its vertical, pitch about the camera's right. */
  orbit(pivot, yawDeg, pitchDeg) {
    const rig = this.rig;
    const P = new THREE.Vector3(...pivot);
    const up = P.clone().normalize();
    const rel = new THREE.Vector3(...rig.pos).sub(P);
    const right = new THREE.Vector3(...rig.right());
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, (yawDeg * Math.PI) / 180);
    // Keep the orbit between grazing and straight down.
    const elev = Math.asin(clamp(rel.clone().normalize().dot(up), -1, 1));
    const target = clamp(elev - (pitchDeg * Math.PI) / 180, 0.02, 1.5);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -(target - elev));
    const q = qYaw.clone().multiply(qPitch);
    rel.applyQuaternion(q);
    const next = P.clone().add(rel);
    rig.pos = [next.x, next.y, next.z];
    rig.q.premultiply(q);
    rig.level();
    this._clampGround();
  }

  _pan(e) {
    const rig = this.rig, ndc = this._ndc(e);
    const d = rig.rayAt(ndc[0], ndc[1], this.engine.camera.aspect);
    // Where does the new ray meet the sphere through the grabbed point?
    const o = rig.pos, R = this.drag.radius;
    const b = v3.dot(o, d), c = v3.dot(o, o) - R * R, disc = b * b - c;
    if (disc < 0) return;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return;
    const hit = v3.add(o, v3.scale(d, t));
    // Rotate the camera about the Earth's centre so the grabbed point stays under the cursor.
    const a = new THREE.Vector3(...hit).normalize(), p = new THREE.Vector3(...this.drag.pivot).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(a, p);
    const pos = new THREE.Vector3(...rig.pos).applyQuaternion(q);
    rig.pos = [pos.x, pos.y, pos.z];
    rig.q.premultiply(q);
    rig.level();
    this._clampGround();
  }

  _startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.drag = null;
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    const r = this.canvas.getBoundingClientRect();
    const ndc = [((this.pinch.mx - r.left) / r.width) * 2 - 1, -(((this.pinch.my - r.top) / r.height) * 2 - 1)];
    this.pinch.ndc = ndc;
    this.pinch.pivot = this.engine.pick(ndc[0], ndc[1])?.point ?? null;
  }

  _pinchMove() {
    const [a, b] = [...this.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const pz = this.pinch;
    const notches = Math.log(pz.d / d) / Math.log(1 / 0.8);
    if (Math.abs(notches) > 0.02) this.dollyBy(pz.ndc, notches);
    if (pz.pivot) this.orbit(pz.pivot, ((ang - pz.ang) * 180) / Math.PI, -(my - pz.my) * 0.3);
    pz.d = d; pz.ang = ang; pz.mx = mx; pz.my = my;
  }

  _clampGround() {
    const rig = this.rig;
    const { lon, lat, h } = rig.lonLatH;
    const g = this.engine.groundAt(lon, lat);
    if (Number.isFinite(g) && h < g + this.minAgl) {
      const up = rig.radialUp, lift = g + this.minAgl - h;
      rig.pos = v3.add(rig.pos, v3.scale(up, lift));
    }
  }

  /** Per-frame: smooth dolly and keyboard flight. */
  update(dt) {
    if (!this.enabled) { this.dolly = null; return; }
    const rig = this.rig;
    if (this.dolly) {
      const step = this.dolly.remaining * Math.min(1, dt * 9);
      rig.pos = v3.add(rig.pos, v3.scale(this.dolly.dir, step));
      this.dolly.remaining -= step;
      if (Math.abs(this.dolly.remaining) < 0.05) this.dolly = null;
      this._clampGround();
    }
    const k = this.keys;
    if (!k.size) return;
    const agl = Math.max(5, this._agl());
    const speed = clamp(agl * 1.2, 15, 3e6) * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1);
    const up = rig.radialUp;
    const fwd = rig.forward();
    const flatF = v3.norm(v3.sub(fwd, v3.scale(up, v3.dot(fwd, up))));
    const right = rig.right();
    let mv = [0, 0, 0];
    if (k.has('KeyW')) mv = v3.add(mv, flatF);
    if (k.has('KeyS')) mv = v3.sub(mv, flatF);
    if (k.has('KeyD')) mv = v3.add(mv, right);
    if (k.has('KeyA')) mv = v3.sub(mv, right);
    if (k.has('KeyE')) mv = v3.add(mv, up);
    if (k.has('KeyQ')) mv = v3.sub(mv, up);
    if (v3.len(mv) > 0) {
      this.onUserMove('keys');
      rig.pos = v3.add(rig.pos, v3.scale(v3.norm(mv), speed * dt));
      this._clampGround();
    }
    const turn = 50 * dt;
    if (k.has('ArrowLeft')) this.look(turn, 0);
    if (k.has('ArrowRight')) this.look(-turn, 0);
    if (k.has('ArrowUp')) this.look(0, turn * 0.6);
    if (k.has('ArrowDown')) this.look(0, -turn * 0.6);
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].some((c) => k.has(c))) this.onUserMove('keys');
  }
}

const key = (d) => d.map((v) => v.toFixed(3)).join(',');
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
