// Shared "Midasus style" helpers. Her single biggest visual signature is a
// pale, pitch-class SPECTRAL color (hue derived from the note, 30deg per
// semitone) laid over heavy additive glow; a second signature is the note
// "slashes" -- bright additive cuts along her motion on each onset that
// extend as they fade. Both are extracted here so Midio, Broshi, and the
// baby stars can wear the exact same treatment and read as the same kind of
// luminous instrument she does.

/** Midasus's core color rule: pitch class -> hue (0..360), 30deg per semitone. */
export function spectralHue(pitch) {
  return ((((Math.round(pitch) || 0) % 12) + 12) % 12) * 30;
}

/** Shortest-path ease of a hue (deg) toward a target by fraction k in [0,1],
 *  so a character's color drifts between notes/keys instead of snapping. */
export function easeHueDeg(cur, target, k) {
  const d = ((target - cur + 540) % 360) - 180; // shortest signed delta in [-180, 180)
  return (cur + d * k + 360) % 360;
}

const SLASH_LIFE_SEC = 0.18;

/** Note "slashes": bright additive cuts along a character's motion on each
 *  onset, lifted from Midasus so every instrument can throw them. Positions
 *  are absolute (screen/world) space; draw() manages its own save/restore. */
export class SlashBurst {
  constructor(max = 8) {
    this.slashes = [];
    this._max = max;
  }

  /** @param {number} x @param {number} y absolute position of the cut's center
   *  @param {number} ang radians @param {number} len px @param {number} hue deg */
  add(x, y, ang, len, hue) {
    this.slashes.push({ x, y, ang, len, hue, age: 0 });
    while (this.slashes.length > this._max) this.slashes.shift();
  }

  update(dtSec) {
    for (const s of this.slashes) s.age += dtSec;
    while (this.slashes.length && this.slashes[0].age >= SLASH_LIFE_SEC) this.slashes.shift();
  }

  draw(ctx) {
    if (!this.slashes.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.slashes) {
      const u = s.age / SLASH_LIFE_SEC;
      ctx.strokeStyle = `hsla(${s.hue.toFixed(0)},70%,80%,${(0.85 * (1 - u)).toFixed(3)})`;
      ctx.lineWidth = 2.6 * (1 - u * 0.6);
      const ext = s.len * (0.4 + 0.6 * u); // the cut extends as it fades
      ctx.beginPath();
      ctx.moveTo(s.x - Math.cos(s.ang) * ext, s.y - Math.sin(s.ang) * ext);
      ctx.lineTo(s.x + Math.cos(s.ang) * ext, s.y + Math.sin(s.ang) * ext);
      ctx.stroke();
    }
    ctx.restore();
  }
}
