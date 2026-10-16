// Ballistic flight between viewpoints. The camera lifts off, climbs until
// (for long jumps) the curve of the Earth fills the frame, arcs along the
// great circle and dives, swinging into the destination's composed view.
// The gaze leads the body: mid-flight it looks ahead and down at where it
// is going, and both converge exactly on the destination framing.
import { lonLatToEcef, ecefToLonLat, slerpLonLat, distance, clamp, v3, headingPitchToDirection } from '../core/geo.js';

const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class Flight {
  /**
   * from     CameraRig (copied)
   * to       { lon, lat, h, heading, pitch, fov, lookDist }
   * options  { heightAt(lon, lat) -> m, lookDist0 }
   */
  constructor(from, to, { heightAt = () => 0, lookDist0 = 15000 } = {}) {
    this.from = from.clone();
    this.to = to;
    this.heightAt = heightAt;
    const a = this.from.lonLatH;
    this.a = a;
    // Where we are looking now, and where we will look at the end.
    const f0 = this.from.forward();
    const look0 = v3.add(this.from.pos, v3.scale(f0, lookDist0));
    this.l0 = ecefToLonLat(...look0);
    const end = lonLatToEcef(to.lon, to.lat, to.h);
    const dir1 = headingPitchToDirection(to.heading, to.pitch, to.lon, to.lat);
    this.l1 = ecefToLonLat(...v3.add(end, v3.scale(dir1, to.lookDist ?? 12000)));
    this.dist = distance(a.lon, a.lat, to.lon, to.lat);
    const travel = Math.max(this.dist, Math.abs(a.h - to.h) * 0.6);
    this.duration = clamp(2.6 + 1.25 * Math.log10(1 + travel / 1500), 2.6, 8.5);
    // Peak altitude: high enough to see the planet's curve on long jumps and
    // to clear any terrain between nearby viewpoints.
    let clear = 0;
    for (let i = 1; i < 16; i++) {
      const u = i / 16, [lon, lat] = slerpLonLat(a.lon, a.lat, to.lon, to.lat, u);
      const g = heightAt(lon, lat);
      if (Number.isFinite(g)) clear = Math.max(clear, g + 600 - (a.h + (to.h - a.h) * u));
    }
    this.peak = Math.max(clamp(this.dist * 0.42, 1200, 2.8e6), clear / 0.9);
    this.fovBoost = clamp(Math.log10(1 + this.dist / 5000) * 8, 0, 18);
    this.t = 0;
    this.done = false;
    this.rig = this.from.clone();
    this.speed = 0;
    this._last = [...this.from.pos];
  }

  skip() { if (this.t < this.duration - 0.45) this.t = this.duration - 0.45; }

  update(dt) {
    this.t = Math.min(this.duration, this.t + dt);
    const u = this.t / this.duration;
    const s = smoother(u);
    const a = this.a, b = this.to;
    const [lon, lat] = slerpLonLat(a.lon, a.lat, b.lon, b.lat, s);
    const bump = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.04)), 1.15);
    let h = a.h + (b.h - a.h) * s + this.peak * bump;
    // Stay clear of the ground on the way (not on the final approach).
    const g = this.heightAt(lon, lat);
    if (Number.isFinite(g)) h = Math.max(h, g + 40 * (1 - smoother(clamp((u - 0.8) / 0.2, 0, 1))) + 2);
    const rig = this.rig;
    lonLatToEcef(lon, lat, h, rig.pos);
    // Gaze leads the body.
    const ul = smoother(clamp(u * 1.18, 0, 1));
    const [llon, llat] = slerpLonLat(this.l0.lon, this.l0.lat, this.l1.lon, this.l1.lat, ul);
    const lh = this.l0.h + (this.l1.h - this.l0.h) * ul;
    const look = lonLatToEcef(llon, llat, lh);
    if (u >= 1) {
      rig.set(b.lon, b.lat, b.h, b.heading, b.pitch);
    } else {
      rig.lookAt(look);
    }
    rig.fov = this.from.fov + ((b.fov ?? this.from.fov) - this.from.fov) * s + this.fovBoost * bump;
    const moved = v3.len(v3.sub(rig.pos, this._last));
    this._last = [...rig.pos];
    const alt = Math.max(50, h - (Number.isFinite(g) ? g : 0));
    this.speed = dt > 0 ? clamp((moved / dt / alt) * 0.08, 0, 1) * bump : 0;
    this.altitude = h;
    if (u >= 1) this.done = true;
    return rig;
  }
}

