// Pure geometric oscillator math for the "resonance" visual layer: modal
// ring vibration (struck-membrane physics for the wireframe characters)
// and hypotrochoid (spirograph) curves for the background mandala. No
// canvas, no DOM -- everything here is unit-testable in Node.
import { mulberry32 } from '../utils/math.js';

const PER_MODE_CAP_PX = 3;

/**
 * Modal vibration of a closed ring, the way a struck cymbal or drumhead
 * actually moves: a sum of circumferential modes, each a traveling wave
 *   d_k(theta, t) = A_k * sin(m_k*theta + s_k*omega_k*t + phi_k)
 * with an inharmonic "stiffened plate" spectrum (omega grows faster than
 * linearly in mode number) and higher modes ringing down faster -- both
 * physically true and what makes the wobble read as material rather than
 * as jello. Amplitudes are in px; excite() strikes it, update() decays it.
 */
export class ModalRing {
  constructor({ modes = 4, baseHz = 8, decaySec = 0.5, seed = 1 } = {}) {
    this.rand = mulberry32(seed);
    this.t = 0;
    this.modes = [];
    for (let k = 0; k < modes; k++) {
      this.modes.push({
        m: k + 2, // wavenumber starts at 2: m=0 is uniform breathing, m=1 is rigid translation
        omega: 2 * Math.PI * baseHz * (1 + 0.62 * k), // stiffened (inharmonic) spectrum
        tau: decaySec / (1 + 0.8 * k), // higher modes die faster
        phase: this.rand() * Math.PI * 2,
        dir: k % 2 === 0 ? 1 : -1, // alternate traveling direction per mode
        A: 0,
      });
    }
  }

  /** Strike the ring: strength is roughly px of total displacement injected. */
  excite(strength) {
    for (const md of this.modes) {
      md.A = Math.min(PER_MODE_CAP_PX, md.A + (strength * (0.5 + 0.5 * this.rand())) / (1 + 0.45 * (md.m - 2)));
      md.phase = this.rand() * Math.PI * 2; // a re-strike scrambles phase, like a real re-hit
    }
  }

  update(dtSec) {
    this.t += dtSec;
    for (const md of this.modes) md.A *= Math.exp(-dtSec / md.tau);
  }

  /** Total live amplitude in px -- used as a cheap early-out gate. */
  get energy() {
    let s = 0;
    for (const md of this.modes) s += md.A;
    return s;
  }

  /** Radial displacement (px) at angular position theta right now. */
  displacementAt(theta) {
    let d = 0;
    for (const md of this.modes) {
      d += md.A * Math.sin(md.m * theta + md.dir * md.omega * this.t + md.phase);
    }
    return d;
  }
}

/**
 * Hypotrochoid (spirograph) point: a circle of radius r rolling inside a
 * circle of radius R, pen at distance d from the rolling center.
 * With R=p, r=q coprime integers the curve closes after theta = 2*pi*q,
 * tracing p-q "petals" -- the classic spirograph rose.
 */
export function hypotrochoid(theta, R, r, d) {
  const k = (R - r) / r;
  return {
    x: (R - r) * Math.cos(theta) + d * Math.cos(k * theta),
    y: (R - r) * Math.sin(theta) - d * Math.sin(k * theta),
  };
}

/**
 * Chladni figure amplitude for a free square plate, normalized coords
 * u,v in [0,1]: the superposition of the (m,n) and (n,m) standing-wave
 * modes. Sand on a real vibrating plate collects along the nodal lines
 * where this is zero -- that's cymatics, sound made literally visible.
 * Antisymmetric under u<->v swap, so the u=v diagonal is always nodal.
 */
export function chladni(u, v, m, n) {
  return Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * v)
       - Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * v);
}

/** Analytic gradient of chladni() -- lets settling particles descend |z|^2 directly. */
export function chladniGrad(u, v, m, n) {
  const mp = m * Math.PI, np = n * Math.PI;
  return {
    du: -mp * Math.sin(mp * u) * Math.cos(np * v) + np * Math.sin(np * u) * Math.cos(mp * v),
    dv: -np * Math.cos(mp * u) * Math.sin(np * v) + mp * Math.cos(np * u) * Math.sin(mp * v),
  };
}

/**
 * Gielis' superformula: one radial equation whose exponents sweep from
 * circles through polygons, stars, and petals --
 *   r(phi) = (|cos(m*phi/4)/a|^n2 + |sin(m*phi/4)/b|^n3)^(-1/n1)
 * Used to give each biome's sun or moon its own silhouette.
 */
export function superformula(phi, m, n1, n2, n3, a = 1, b = 1) {
  const t1 = Math.abs(Math.cos((m * phi) / 4) / a) ** n2;
  const t2 = Math.abs(Math.sin((m * phi) / 4) / b) ** n3;
  const r = (t1 + t2) ** (-1 / n1);
  return Number.isFinite(r) ? r : 0;
}

/**
 * Thomas' cyclically symmetric attractor: x' = sin(y) - b*x (and cyclic).
 * The single damping parameter b is a bifurcation knob: ~0.33 gives
 * gentle limit cycles, ~0.19 is fully chaotic -- so driving b with track
 * energy makes the trajectory literally bifurcate with the music.
 */
export function thomasDeriv(s, b) {
  return {
    x: Math.sin(s.y) - b * s.x,
    y: Math.sin(s.z) - b * s.y,
    z: Math.sin(s.x) - b * s.z,
  };
}

/** Classic RK4 step for a 3D autonomous system s' = f(s, ...args). */
export function rk4Step3(f, s, dt, ...args) {
  const k1 = f(s, ...args);
  const k2 = f({ x: s.x + k1.x * dt / 2, y: s.y + k1.y * dt / 2, z: s.z + k1.z * dt / 2 }, ...args);
  const k3 = f({ x: s.x + k2.x * dt / 2, y: s.y + k2.y * dt / 2, z: s.z + k2.z * dt / 2 }, ...args);
  const k4 = f({ x: s.x + k3.x * dt, y: s.y + k3.y * dt, z: s.z + k3.z * dt }, ...args);
  return {
    x: s.x + (dt / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    y: s.y + (dt / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    z: s.z + (dt / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
  };
}
