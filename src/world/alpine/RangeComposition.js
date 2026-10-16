// No fixed foreground stage is painted. Keep missing metadata distinct:
// scenic ownership also controls weather overlays and foreground ambience.
// Accept old ledge metadata so saved views remain readable.
const NO_FOREGROUND = Object.freeze({ foreground: 'none', nearLedgeMaxFrac: 0 });
export function compositionErrors(view) {
  if (!view || !Object.hasOwn(view, 'composition')) return [];
  const c = view.composition;
  if (!c || typeof c !== 'object') return ['composition'];
  const errors = [];
  if (!['ledge', 'none'].includes(c.foreground)) errors.push('composition.foreground');
  if (!Number.isFinite(c.nearLedgeMaxFrac) || c.nearLedgeMaxFrac < 0 || c.nearLedgeMaxFrac > .12) errors.push('composition.nearLedgeMaxFrac');
  if (c.foreground === 'none' && c.nearLedgeMaxFrac !== 0) errors.push('composition.none must have zero coverage');
  return errors;
}

export function resolveRangeComposition(view) {
  const errors = compositionErrors(view);
  if (errors.length) throw new RangeError(errors.join(', '));
  return view?.composition ? NO_FOREGROUND : null;
}

/** Reframe the rendered support only. Physics remains in GroundField.
 * One broken edge and its surfaces share these bars. Nominal framing excludes
 * padded overscan; subtract the existing glacier presentation translation. */
export function compositionBars(bars, viewport, composition, offsetY = viewport.presentationOffsetY || 0) {
  if (!composition) return bars;
  if (composition.foreground === 'none') return [];
  const H = viewport.nominalHeight || viewport.logicalHeight;
  const bottom = (viewport.overscanPx || 0) + H - offsetY;
  const maxDepth = H * composition.nearLedgeMaxFrac;
  // Preserve broad support relief without growing a new screen-wide shelf.
  const low = Math.min(...bars.map(b => b.y)), high = Math.max(...bars.map(b => b.y));
  return bars.map(b => ({ ...b, y: bottom - maxDepth * (.55 + .45 * (1 - (b.y - low) / Math.max(1, high - low))) }));
}
