import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(file) {
  return sha256Text(await fs.readFile(file));
}

/**
 * The reported commit string is not identity. A served module hash that
 * differs from the expected map is a failure even when the commit matches.
 */
export function verifyServedIdentity({ expectSha, expectedHashes, served }) {
  if (!served || typeof served !== 'object') throw new Error('served identity missing');
  if (!Object.keys(expectedHashes || {}).length) throw new Error('expected source hashes are empty');
  if (expectSha && served.commit && served.commit !== expectSha) {
    throw new Error(`served commit ${served.commit} does not match ${expectSha}`);
  }
  const hashes = served.hashes || {};
  for (const [file, expected] of Object.entries(expectedHashes || {})) {
    if (hashes[file] !== expected) {
      throw new Error(`served ${file} hash ${hashes[file] || 'missing'} !== ${expected}`);
    }
  }
  return true;
}

export function assertActualDpr(requested, actual) {
  if (actual !== requested) {
    throw new Error(`actual devicePixelRatio ${actual} !== requested ${requested}`);
  }
}

/**
 * A capture is evidence only for the state that actually drew it: the
 * requested quality rung must be the rung in force, and the requested
 * instant must have been painted exactly once.
 */
export function assertCaptureState({ quality, finalDraws } = {}) {
  if (!quality || quality.actual !== quality.requested) {
    throw new Error(`actual quality ${quality?.actual} !== requested ${quality?.requested}`);
  }
  if (finalDraws !== 1) throw new Error(`final frame drawn ${finalDraws} times, expected exactly 1`);
  return true;
}

export function claimCase(seen, id) {
  if (seen.has(id)) throw new Error(`duplicate landscape case ${id}`);
  seen.add(id);
  return id;
}

export function buildManifest(record) {
  return {
    baselineSha: record.baselineSha,
    candidateSha: record.candidateSha,
    tree: record.tree,
    dirty: !!record.dirty,
    diagnosticPatch: record.diagnosticPatch || null,
    served: record.served || null,
    lockfileHash: record.lockfileHash || null,
    fixtureHash: record.fixtureHash || null,
    browser: record.browser || null,
    viewport: record.viewport || null,
    dpr: record.dpr ?? null,
    backing: record.backing || null,
    worldKind: record.worldKind || 'alpine',
    biome: record.biome || null,
    rangeIds: record.rangeIds || [],
    fallback: record.fallback || null,
    timeMs: record.timeMs ?? null,
    quality: record.quality ?? null,
    finalDraws: record.finalDraws ?? null,
    generation: record.generation ?? null,
    renderer: record.renderer || null,
    rangeRenderer: record.rangeRenderer || null,
    passes: record.passes || null,
    reducedFlash: !!record.reducedFlash,
    camera: record.camera || null,
    light: record.light || null,
    station: record.station ?? null,
    pass: record.pass || 'all',
    caseId: record.caseId,
    png: record.png || null,
    errors: record.errors || [],
  };
}
