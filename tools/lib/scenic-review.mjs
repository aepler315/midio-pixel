// Rendered-review collection for scenic shot libraries (docs/scenic-tours.md,
// "Rendered review"): reviewer results checked against the regions and the
// exact library bytes under review, before anything is counted.
//
// A review is only evidence about the library it looked at. Every result is
// validated (fields, allowed verdicts), matched to its expected region and
// that region's final shot IDs, and duplicate or conflicting results are
// reported rather than silently merged. Counts include only recognised
// verdicts; anything else is a problem, never a success.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { shotLibraryErrors } from '../../src/world/terrain/ShotLibrary.js';

export const REVIEW_VERDICTS = Object.freeze(['good', 'acceptable', 'weak', 'broken']);
const PASSING = new Set(['good', 'acceptable']);
const HASH_FIELDS = ['manifestSha256', 'payloadSha256', 'decodedPayloadSha256', 'terrainManifestSha256'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function identityErrors(identity) {
  if (!identity || identity.schema !== 'midio.scenic-review-identity' || identity.version !== 1) return ['identity schema/version'];
  return HASH_FIELDS.filter((key) => !hash(identity[key])).map((key) => `identity ${key}`);
}

/** Read current library bytes, checking declared compressed/decoded payload
 * hashes and the actual terrain manifest. Never accept a caller's digest as
 * the expected identity. The manifest hash includes camera metadata as well
 * as its payload reference, so unchanged shot IDs cannot hide edits. */
export async function readReviewLibraryIdentity(manifestPath, { viewId, terrainManifestPath }) {
  const raw = await fs.readFile(manifestPath), manifest = JSON.parse(raw.toString('utf8'));
  const errors = shotLibraryErrors(manifest, { viewId });
  if (errors.length) throw new Error(`${viewId}: invalid shot library: ${errors.join('; ')}`);
  const payload = await fs.readFile(path.resolve(path.dirname(manifestPath), manifest.payload.url));
  if (payload.length !== manifest.payload.byteLength || sha256(payload) !== manifest.payload.sha256) throw new Error(`${viewId}: payload hash/length mismatch`);
  const decoded = payload[0] === 0x1f && payload[1] === 0x8b ? gunzipSync(payload) : payload;
  if (decoded.length !== manifest.payload.decodedByteLength || sha256(decoded) !== manifest.payload.decodedSha256) throw new Error(`${viewId}: decoded payload hash/length mismatch`);
  const terrainManifestSha256 = sha256(await fs.readFile(terrainManifestPath));
  if (terrainManifestSha256 !== manifest.terrainManifestSha256) throw new Error(`${viewId}: terrain manifest hash mismatch`);
  return { shotIds: manifest.shots.map((s) => s.id), identity: { schema: 'midio.scenic-review-identity', version: 1,
    manifestSha256: sha256(raw), payloadSha256: sha256(payload), decodedPayloadSha256: sha256(decoded), terrainManifestSha256 } };
}

/** Problems with one reviewer result object (empty = well formed). */
export function reviewResultErrors(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (typeof r.region !== 'string' || !r.region) errors.push('region');
  if (!['good', 'acceptable', 'weak'].includes(r.verdict)) errors.push(`library verdict ${JSON.stringify(r.verdict)}`);
  errors.push(...identityErrors(r.identity));
  if (!hash(r.provenance?.sourceDigest)) errors.push('provenance sourceDigest');
  if (typeof r.provenance?.capturePath !== 'string' || !r.provenance.capturePath.trim()) errors.push('provenance capturePath');
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
 *   expected  Map region -> {shotIds, identity} from readReviewLibraryIdentity
 *             Legacy ID arrays retain diagnostic counts but are never current.
 * Returns { complete, regions: {region: {verdict, counts, shots}}, problems }
 * where `complete` is true only when every expected region has exactly one
 * well-formed result covering exactly its expected shots and matching all
 * four asset hashes. Source/capture provenance is recorded reviewer
 * attribution; this collector does not authenticate the referenced capture.
 */
export function collectReviews(results, expected) {
  const problems = { failed: 0, malformed: [], unexpectedRegions: [], missingRegions: [], conflicts: [], duplicates: [],
    missingShots: {}, unknownShots: {}, duplicateShots: {}, identityMismatches: {} };
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
  for (const [region, library] of expected) {
    const ids = Array.isArray(library) ? library : library.shotIds;
    const r = byRegion.get(region);
    if (!r) { problems.missingRegions.push(region); continue; }
    if (problems.conflicts.includes(region)) continue; // two different answers: neither counts
    const identityProblems = identityErrors(library.identity);
    const mismatches = identityProblems.length ? ['expected library identity missing or invalid'] : HASH_FIELDS.filter((key) => r.identity[key] !== library.identity[key]);
    if (mismatches.length) problems.identityMismatches[region] = mismatches;
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
      covered: counted.size, expected: ids.length, current: !mismatches.length && !missing.length && !unknown.length && !dup.length,
      identity: r.identity, expectedIdentity: library.identity ?? null, provenance: r.provenance, shots: r.shots };
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
