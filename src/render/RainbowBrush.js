// The Mario Paint rainbow pen, repurposed: while Midio is airborne his
// trajectory is painted as a trail of chunky square dabs cycling through
// the hue wheel, world-locked so the stroke stays where he drew it and
// scrolls away with the terrain. Deliberately unsmoothed -- crisp square
// dabs snapped to pixels are the whole aesthetic.
import { flashCompositeOp } from '../ui/Accessibility.js';

const MAX_DABS = 320;
const LIFE_MS = 3200;
const SPACING_PX = 8;
const HUE_STEP_DEG = 16;

export class RainbowBrush {
  constructor() {
    this.dabs = [];
    this._hueIdx = 0;
    this._lastX = NaN;
    this._lastY = NaN;
  }

  /** Feed Midio's world-space position each frame; dabs drop at fixed stroke
   *  spacing, widened under perf pressure (`particleMul`) so a shed device
   *  spawns a sparser trail instead of paying for the full dab count. */
  update(nowMs, airborne, wx, y, particleMul = 1) {
    if (!airborne) { this._lastX = NaN; return; }
    const spacing = SPACING_PX / Math.max(0.35, particleMul);
    const dx = wx - this._lastX, dy = y - this._lastY;
    if (Number.isFinite(this._lastX) && dx * dx + dy * dy < spacing * spacing) return;
    this.dabs.push({ wx, y, hue: (this._hueIdx++ * HUE_STEP_DEG) % 360, bornMs: nowMs });
    this._lastX = wx; this._lastY = y;
    if (this.dabs.length > MAX_DABS) this.dabs.shift();
  }

  /** canvasWidth: the visible logical width, so dabs scrolled well off-screen
   *  are skipped -- up to 320 dabs redrawn every frame is real cost even
   *  when most of a dense flurry's trail has scrolled out of view. Defaults
   *  to Infinity (cull nothing) for callers with no canvas width handy. */
  draw(ctx, worldX, originX, nowMs, sizeMul = 1, reducedFlash = false, canvasWidth = Infinity) {
    while (this.dabs.length && nowMs - this.dabs[0].bornMs >= LIFE_MS) this.dabs.shift();
    if (this.dabs.length === 0) return;
    ctx.save();
    // Additive, like every other trail/glow in the game (afterimages, beat
    // flashes) -- overlapping dabs from a dense flurry of jumps melt into
    // soft light instead of stacking as an opaque, hard-edged patchwork.
    // Under reduced-flash a dense flurry piling up dabs additively is
    // exactly the kind of stacked-flash this toggle exists to prevent, so
    // fall back to normal compositing (see Accessibility.js:flashCompositeOp).
    ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
    const margin = 20; // largest dab is ~9 * sizeMul(2 during Apotheosis) across
    for (const d of this.dabs) {
      const cx = d.wx - worldX + originX;
      if (cx < -margin || cx > canvasWidth + margin) continue;
      const age = (nowMs - d.bornMs) / LIFE_MS;
      if (age < 0 || age >= 1) continue;
      const size = Math.max(3, Math.round((9 - 4 * age) * sizeMul));
      // Lower peak alpha than the old opaque dabs used -- additive stacking
      // saturates to white fast, and a dense flurry of jumps overlaps a LOT
      // of dabs; this keeps the rainbow hue cycle visible instead of
      // washing out to a pale blob wherever trails pile up.
      ctx.globalAlpha = 0.4 * (1 - age);
      ctx.fillStyle = `hsl(${d.hue},90%,62%)`;
      const x = Math.round(cx - size / 2);
      ctx.fillRect(x, Math.round(d.y - size / 2), size, size);
    }
    ctx.restore();
  }
}
