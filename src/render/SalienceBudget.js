// Per-frame attention budget.
//
// FocusDirector chooses the dramatic subject; this translates that decision
// into the limits the renderer and worlds need. Structural world material is
// deliberately not dimmed: a landmark and the travel line must remain
// legible even when a character or a drop owns the frame.
import { identityFor } from '../world/WorldIdentity.js';
import { clamp01 } from '../utils/math.js';

export function salienceBudgetFor(focus = null, world = null) {
  const support = world ? identityFor(world).supportLight : 1;
  const subject = focus?.subject || null;
  if (!subject) {
    return Object.freeze({
      subject: null,
      landmark: 1,
      terrain: 1,
      sky: 1,
      particles: 1,
      bloom: support,
    });
  }

  const sky = clamp01(focus?.mul?.('sky') ?? 1);
  return Object.freeze({
    subject,
    landmark: 1,
    terrain: 1,
    sky,
    // Keep a readable particle floor, but make ambient density yield before
    // it competes with the focus subject.
    particles: 0.5 + 0.5 * sky,
    // A drop earns its own burst of bloom. Other subjects keep the frame's
    // bright landmarks from being washed out by a global light leak.
    bloom: support * (subject === 'drop' ? 1 : 0.55 + 0.45 * sky),
  });
}
