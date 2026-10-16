// Musical phrase accents — rhythm events ranked by perceptual salience for
// terraced hazard placement (spec §2.2.3 musical terracing). Downbeats and
// strong kicks anchor colliding terraces; backbeats seed medium blocks; hats
// become non-colliding decorative props only.
import { Role, GM_DRUM } from '../core/NoteEvent.js';

export const Strength = Object.freeze({
  STRONG: 'strong',
  MEDIUM: 'medium',
  WEAK: 'weak',
});

const SALIENCE = { strong: 1.0, medium: 0.6, weak: 0.3 };

function barContext(tMs, barGrid) {
  if (!barGrid.length) return { barStart: 0, beatPeriod: 500, beatInBar: 0 };
  let barIdx = 0;
  for (let i = 0; i < barGrid.length; i++) {
    if (barGrid[i].ms <= tMs) barIdx = i;
    else break;
  }
  const barStart = barGrid[barIdx].ms;
  const barEnd = barGrid[barIdx + 1]?.ms ?? barStart + 2000;
  const beatPeriod = (barEnd - barStart) / 4;
  const beatInBar = beatPeriod > 0
    ? Math.min(3, Math.max(0, Math.round((tMs - barStart) / beatPeriod)))
    : 0;
  return { barStart, beatPeriod, beatInBar };
}

/**
 * @param {import('../core/NoteEvent.js').NoteEvent[]} timeline
 * @param {Array<{ms:number}>} barGrid
 * @returns {Array<{tMs:number, vel:number, strength:string, salience:number}>}
 */
export function extractAccents(timeline, barGrid) {
  const accents = [];
  for (const e of timeline) {
    if (e.role !== Role.RHYTHM) continue;
    const { beatInBar } = barContext(e.tMs, barGrid);

    if (e.pitch === GM_DRUM.HAT && e.vel >= 0.3) {
      accents.push({ tMs: e.tMs, vel: e.vel, strength: Strength.WEAK, salience: SALIENCE.weak });
      continue;
    }

    if (e.kick && e.vel >= 0.7) {
      accents.push({ tMs: e.tMs, vel: e.vel, strength: Strength.STRONG, salience: SALIENCE.strong });
      continue;
    }

    if (beatInBar === 0) {
      accents.push({ tMs: e.tMs, vel: e.vel, strength: Strength.STRONG, salience: SALIENCE.strong });
      continue;
    }

    if ((beatInBar === 1 || beatInBar === 3) && e.vel >= 0.45) {
      accents.push({ tMs: e.tMs, vel: e.vel, strength: Strength.MEDIUM, salience: SALIENCE.medium });
    }
  }
  accents.sort((a, b) => a.tMs - b.tMs);
  return accents;
}