// An explicitly selected, repeatable two-massif stage. The measured pieces
// use the ordinary song-range assembly and Range v2 rendering paths.
import MASSIF_CATALOG from './massifCatalogData.js';
import { SONG_RANGE_VERSION } from './SongRangePlan.js';

export const DUAL_SUMMITS_SIGNATURE = 'dual-summits';
export const DUAL_SUMMITS_SCENE_VERSION = 3;
const SUMMITS = Object.freeze([
  Object.freeze({ id: 'A', slotId: 'B1', pieceId: 'teton-jackson-lake:grand-teton', name: 'Grand Teton' }),
  Object.freeze({ id: 'B', slotId: 'B2', pieceId: 'teton-jackson-lake:mount-moran', name: 'Mount Moran' }),
]);

/** An explicit option takes precedence over the repeatable review URL. */
export function dualSummitsRequested({ signature, search = globalThis.location?.search || '' } = {}) {
  return (signature ?? new URLSearchParams(search || '').get('performance')) === DUAL_SUMMITS_SIGNATURE;
}

/** Null if a catalog revision cannot supply both pinned, fitting massifs. */
export function planDualSummitsScene(biome, { catalog = MASSIF_CATALOG } = {}) {
  const t = catalog.templates?.find(x => x.id === 'offset-shore-c');
  if (!t || !catalog.materials?.['dry-conifer']) return null;
  for (const s of SUMMITS) {
    const p = catalog.pieces?.find(x => x.id === s.pieceId);
    const slot = t.slots.find(x => x.id === s.slotId);
    if (!p || !slot || p.family !== 'dry-conifer' || !p.manifestUrl || !/^[a-f0-9]{64}$/.test(p.manifestSha256 || '')
      || p.tiles[0] > slot.tiles[2] || p.tiles[1] > slot.tiles[3]
      || p.peakReliefM < (slot.reliefM?.[0] ?? 0) || (slot.reliefM?.[1] != null && p.peakReliefM > slot.reliefM[1])) return null;
  }
  // Stand over the lake rather than behind the near shore. The closer eye
  // makes both hero crests monumental and leaves their reflections readable.
  const eyeM = Object.freeze([-5500, 2220.4, 13000]);
  const targetM = Object.freeze([-6170, 3000, -3840]);
  return Object.freeze({ version: SONG_RANGE_VERSION, signaturePerformance: DUAL_SUMMITS_SIGNATURE,
    signatureVersion: DUAL_SUMMITS_SCENE_VERSION, family: 'dry-conifer', biome,
    templateId: t.id, baseM: t.lakeLevelM,
    principal: Object.freeze({ slotId: 'B1', pieceId: SUMMITS[0].pieceId, name: SUMMITS[0].name }),
    slots: Object.freeze(SUMMITS.map(s => Object.freeze({ slotId: s.slotId, pieceId: s.pieceId, mirrored: false }))),
    // Close the excessive empty channel between the two catalog slots.
    // Whole-tile placement keeps the existing ownership/rise seams exact.
    slotOffsets: Object.freeze({ B2: Object.freeze([-5, 0]) }),
    camera: Object.freeze({ eyeStartM: eyeM, eyeEndM: eyeM, targetStartM: targetM, targetEndM: targetM, fovYDeg: 40 }),
    // The opening can isolate either summit at 18 degrees; retain enough
    // ground detail for that lens while the full pair fits the final 40.
    lodFovYDeg: 18,
    label: 'World: Dual Summits',
  });
}

/** The camera consumes the actual assembled summit positions, not guessed
 * slot centres. Reject missing positions so an invalid stage keeps its fallback. */
export function dualSummitsSceneMetadata(manifest) {
  return Object.freeze(SUMMITS.map(s => {
    const landmark = manifest.landmarks?.find(x => x.name === s.name);
    const positionM = landmark ? [landmark.localM?.[0], landmark.demGroundM, landmark.localM?.[1]] : [];
    if (positionM.length !== 3 || !positionM.every(Number.isFinite)) throw new Error(`Dual Summits has no position for ${s.name}`);
    return Object.freeze({ ...s, positionM: Object.freeze(positionM) });
  }));
}
