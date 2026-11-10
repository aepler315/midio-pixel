// The `songRange` block of a composed-range view record (song range
// composition, Phase 3). A leaf module with no imports, so the scene catalog
// can validate composed views without an import cycle.

/** Structural problems with a song range view's `songRange` block. */
export function songRangeViewErrors(view) {
  const s = view?.songRange;
  if (!s || typeof s !== 'object') return ['songRange'];
  const errors = [];
  if (!s.plan || !Array.isArray(s.plan.slots) || !s.plan.slots.length || typeof s.plan.templateId !== 'string') errors.push('songRange plan');
  if (!Array.isArray(s.pieces) || s.pieces.length !== s.plan?.slots?.length) errors.push('songRange pieces');
  else for (const p of s.pieces) {
    if (typeof p.manifestUrl !== 'string' || !p.manifestUrl.endsWith('.json') || !/^[a-f0-9]{64}$/.test(p.manifestSha256 || '')) { errors.push(`songRange piece ${p.id}`); break; }
  }
  return errors;
}
