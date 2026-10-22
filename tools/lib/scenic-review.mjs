// Rendered-review collection for scenic shot libraries (docs/scenic-tours.md,
// "Rendered review"): reviewer results checked against the regions and the
// exact shot IDs under review, before anything is counted.
//
// A review is only evidence about the library it looked at. Every result is
// validated (fields, allowed verdicts), matched to its expected region and
// that region's final shot IDs, and duplicate or conflicting results are
// reported rather than silently merged. Counts include only recognised
// verdicts; anything else is a problem, never a success.

export const REVIEW_VERDICTS = Object.freeze(['good', 'acceptable', 'weak', 'broken']);
const PASSING = new Set(['good', 'acceptable']);

/** Problems with one reviewer result object (empty = well formed). */
export function reviewResultErrors(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (typeof r.region !== 'string' || !r.region) errors.push('region');
  if (!['good', 'acceptable', 'weak'].includes(r.verdict)) errors.push(`library verdict ${JSON.stringify(r.verdict)}`);
  if (!Array.isArray(r.shots)) return [...errors, 'shots'];
  r.shots.forEach((s, i) => {
    if (!s || typeof s !== 'object') { errors.push(`shot ${i}: not an object`); return; }
    if (typeof s.id !== 'string' || !s.id) errors.push(`shot ${i}: id`);
    if (!REVIEW_VERDICTS.includes(s.verdict)) errors.push(`shot ${s.id ?? i}: verdict ${JSON.stringify(s.verdict)}`);
    if (typeof s.issue !== 'string') errors.push(`shot ${s.id ?? i}: issue`);
  });
  return errors;
}

const sameResult = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validate and count reviewer results.
 *   results   reviewer outputs (possibly null for a failed agent)
 *   expected  Map region -> array of the shot IDs that region's library holds
 * Returns { complete, regions: {region: {verdict, counts, shots}}, problems }
 * where `complete` is true only when every expected region has exactly one
 * well-formed result covering exactly its expected shots.
 */
export function collectReviews(results, expected) {
  const problems = { failed: 0, malformed: [], unexpectedRegions: [], missingRegions: [], conflicts: [], duplicates: [],
    missingShots: {}, unknownShots: {}, duplicateShots: {} };
  const byRegion = new Map();
  results.forEach((r, index) => {
    if (r == null) { problems.failed++; return; }
    const errors = reviewResultErrors(r);
    if (errors.length) { problems.malformed.push({ index, region: r?.region ?? null, errors }); return; }
    if (!expected.has(r.region)) { problems.unexpectedRegions.push(r.region); return; }
    const prior = byRegion.get(r.region);
    if (!prior) byRegion.set(r.region, r);
    else if (sameResult(prior, r)) problems.duplicates.push(r.region);
    else problems.conflicts.push(r.region);
  });
  const regions = {};
  for (const [region, ids] of expected) {
    const r = byRegion.get(region);
    if (!r) { problems.missingRegions.push(region); continue; }
    if (problems.conflicts.includes(region)) continue; // two different answers: neither counts
    const seen = new Map();
    for (const s of r.shots) seen.set(s.id, (seen.get(s.id) || 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    const missing = ids.filter((id) => !seen.has(id)), unknown = [...seen.keys()].filter((id) => !ids.includes(id));
    if (dup.length) problems.duplicateShots[region] = dup;
    if (missing.length) problems.missingShots[region] = missing;
    if (unknown.length) problems.unknownShots[region] = unknown;
    const counts = Object.fromEntries(REVIEW_VERDICTS.map((v) => [v, 0]));
    // Only shots of the expected library, each once, count.
    const counted = new Set();
    for (const s of r.shots) if (ids.includes(s.id) && !counted.has(s.id)) { counted.add(s.id); counts[s.verdict]++; }
    regions[region] = { verdict: r.verdict, counts, passing: counts.good + counts.acceptable, failing: counts.weak + counts.broken,
      covered: counted.size, expected: ids.length, current: !missing.length && !unknown.length && !dup.length, shots: r.shots };
  }
  const complete = !problems.failed && !problems.malformed.length && !problems.unexpectedRegions.length && !problems.missingRegions.length
    && !problems.conflicts.length && Object.values(regions).every((x) => x.current) && Object.keys(regions).length === expected.size;
  return { complete, regions, problems, passingVerdicts: [...PASSING] };
}

/**
 * The state of a workflow run from its journal (one JSON event per line:
 * launched / started / result, with agent labels): which expected labels
 * started, finished, or are still missing, and every result by label -- a
 * label that reported twice keeps both, so that collectReviews sees them
 * (two different answers are a conflict, never the later one).
 */
export function journalState(text, expectedLabels) {
  const events = text.trim() ? text.trim().split('\n').map((line, i) => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line: i + 1 }; }
  }) : [];
  const label = new Map(), started = new Set(), results = new Map(), duplicates = [], other = [];
  for (const e of events) {
    if (e.type === 'started') { label.set(e.agentId, e.label); started.add(e.label); }
    else if (e.type === 'result') {
      const l = label.get(e.agentId) ?? e.label ?? null;
      if (results.has(l)) duplicates.push(l);
      results.set(l, [...(results.get(l) || []), e.result ?? null]);
    } else if (e.type !== 'launched') other.push(e);
  }
  const finished = expectedLabels.filter((l) => results.has(l));
  return { started: expectedLabels.filter((l) => started.has(l)), finished, missing: expectedLabels.filter((l) => !results.has(l)),
    running: expectedLabels.filter((l) => started.has(l) && !results.has(l)), unexpected: [...results.keys()].filter((l) => !expectedLabels.includes(l)),
    duplicates, other, results };
}
