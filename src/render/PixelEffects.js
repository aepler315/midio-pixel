const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
export function pixelHeatOffset(value, { unit = 1 } = {}) {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value), unit);
}
const STAR_SHAPES = new Map([1, 2].map(unit => [unit, {
  core: Object.freeze([Object.freeze({ x: 0, y: 0, size: unit })]),
  cross: Object.freeze([[0, 0], [-unit, 0], [unit, 0], [0, -unit], [0, unit]].map(([x, y]) => Object.freeze({ x, y, size: unit }))),
}]));
/** Brightness is the star's authored class, not its time-varying twinkle. */
export function pixelStarShape(starId, brightness, unit = 1) {
  const shapes = STAR_SHAPES.get(unit) || STAR_SHAPES.get(1);
  return starId % 7 === 0 && brightness >= .75 ? shapes.cross : shapes.core;
}
/** Instantaneous highlight spill. One admitted source snapshot; no history/readback. */
export function drawPixelGlow(ctx, source, { buffers, unit = 1, strength = 0 } = {}) {
  const alpha = Number.isFinite(strength) ? Math.max(0, Math.min(strength, .10)) : 0;
  if (!alpha) { buffers?.release('pixel-glow'); return false; }
  const scratch = buffers?.ensure('pixel-glow', source.width, source.height);
  if (!scratch) return false;
  const highlights = scratch.getContext('2d');
  if (!highlights || highlights.isContextLost?.()) { buffers.release('pixel-glow'); return false; }
  highlights.setTransform(1, 0, 0, 1, 0, 0);
  highlights.imageSmoothingEnabled = false;
  highlights.filter = 'none'; highlights.globalAlpha = 1;
  highlights.globalCompositeOperation = 'copy';
  highlights.drawImage(source, 0, 0);
  highlights.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 2; i++) highlights.drawImage(scratch, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = alpha / 4;
  for (const [x, y] of [[-unit, 0], [unit, 0], [0, -unit], [0, unit]]) ctx.drawImage(scratch, x, y);
  ctx.restore();
  return true;
}
