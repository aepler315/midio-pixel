// Fixed Phase 0 views for the generated 120 bpm / 96 s song, Teton seed 315.
// These are pose-survey selections; do not silently replace them after edits.
export const FOREST_CHECKPOINTS = Object.freeze([
  { id: 'a', timeMs: 2000, center: [1050, 560], purpose: 'Lowest pass / closest visible mesh',
    limitation: 'Substitute: 249 m above ground; nearest probed visible tree 780 m away, not within 300 m.' },
  { id: 'b', timeMs: 20000, center: [300, 850], purpose: 'Billboards at 1–3 km' },
  { id: 'c', timeMs: 40000, center: [350, 400], purpose: 'Forested face at 4–8 km' },
  { id: 'd', timeMs: 76000, center: [700, 400], purpose: 'Forested face spanning the 8 km handoff / 6–14 km' },
  { id: 'e', timeMs: 68000, center: [1340, 994], purpose: 'Highest / steepest downward pose',
    limitation: 'Substitute: 561 m above ground, pitch −7.9°, not the requested ≥600 m steep view.' },
  { id: 'f', timeMs: 54000, center: [384, 216], purpose: 'Highest visible forested face',
    limitation: 'Treeline coverage remains unavailable: nearest probed forested face is 205 m below the nominal 3100 m treeline, at 11.9 km.' },
]);
