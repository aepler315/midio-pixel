// Seven perceptually-motivated bands (spec §1.2.1), shared by the stem
// separator, onset detector, and companion/biome systems that read raw
// per-band energy.
export const BANDS = [
  [20, 60],      // 0 SUB
  [60, 250],     // 1 BASS
  [250, 500],    // 2 LOW-MID
  [500, 2000],   // 3 MID
  [2000, 4000],  // 4 HIGH-MID
  [4000, 8000],  // 5 PRESENCE
  [8000, 16000], // 6 AIR
];

export const BAND_NAMES = ['SUB', 'BASS', 'LOW_MID', 'MID', 'HIGH_MID', 'PRESENCE', 'AIR'];

// Onset spectral-flux band weights (spec §1.2.4).
export const ONSET_WEIGHTS = [1.4, 1.2, 0.8, 0.7, 1.1, 1.0, 0.6];

// Global-energy band weights for the Rabid morph gate (spec §3.2.3),
// biased toward SUB/BASS/HIGH-MID.
export const RABID_WEIGHTS = [1.3, 1.2, 0.8, 0.9, 1.2, 1.0, 0.7];

// Default EQ-crown weights: flat.
export const FLAT_WEIGHTS = [1, 1, 1, 1, 1, 1, 1];
