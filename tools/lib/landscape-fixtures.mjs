/** Controlled, real-range fixtures. These are not claims about a natural song cast. */
export const RANGE_FIXTURES = Object.freeze({
  ICEFIELD: ['fairweather-range', 'chugach-mountains', 'alaska-range'],
  TUNDRA: ['wrangell-mountains', 'revelation-mountains', 'saint-elias-mountains'],
  TAIGA: ['aleutian-range', 'thudaka-range', 'boundary-ranges'],
  RAINFOREST: ['skagit-range', 'north-cascades', 'pacific-ranges'],
  CONIFER: ['wasatch', 'selkirk-mountains', 'rainier'],
  PINE_OAK: ['san-mateo-mountains', 'sierra-madre-occidental', 'hualapai-mountains'],
  BROADLEAF: ['mahoosuc-range', 'taconic-mountains', 'laurentian-mountains'],
  CHAPARRAL: ['san-jacinto-mountains', 'vaca-mountains', 'san-rafael-mountains'],
  STEPPE: ['deep-creek-range', 'pine-valley-mountains', 'toquima-range'],
  CANYON: ['la-sal-mountains', 'book-cliffs', 'monument-valley'],
  DESERT: ['pinaleno-mountains', 'chiricahua-mountains', 'peninsular-ranges'],
});
export const REAL_BIOMES = Object.freeze(Object.keys(RANGE_FIXTURES));
export const PRESETS = Object.freeze({
  primary: 'Eleven real-biome fixtures at day, 1280x720.',
  lighting: 'Explicit day and night, forest and dry terrain.',
  quality: 'Lowest quality and reduced flashes.',
  viewport: 'Wide, portrait, and DPR 2.',
  travel: 'Forest/desert A/B seam at 25, 50, 75 percent.',
  geometry: 'Broad Book Cliffs, pullback and spectrum massif isolation.',
  visibility: '21 distinct travel stations on a broad-profile fixture.',
  full: 'Primary, lighting, travel, geometry, quality and viewport.',
  motion: 'Ten seconds of deterministic 12fps full-composite frames.',
});
const PRIMARY = { seed: 315, timeMs: 20000, level: 0, reducedFlash: false,
  width: 1280, height: 720, dpr: 1, pass: 'all', forced: true, label: 'material-fixture' };

export function casesForPreset(preset) {
  if (!Object.hasOwn(PRESETS, preset)) throw new Error(`unknown landscape preset ${preset}`);
  if (preset === 'full') return ['primary', 'lighting', 'travel', 'geometry', 'quality', 'viewport']
    .flatMap(p => casesForPreset(p).map(c => ({ ...c, label: `${p}-${c.label}` })));
  if (preset === 'primary') return REAL_BIOMES.map(biome => ({ ...PRIMARY, biome }));
  if (preset === 'lighting') return ['RAINFOREST', 'DESERT', 'ICEFIELD', 'STEPPE'].flatMap(biome =>
    [20000, 68000].map(timeMs => ({ ...PRIMARY, biome, timeMs, label: timeMs === 20000 ? 'day' : 'night' })));
  if (preset === 'quality') return ['RAINFOREST', 'DESERT', 'ICEFIELD'].flatMap(biome => [
    { ...PRIMARY, biome, level: 6, label: 'lowest-quality' },
    { ...PRIMARY, biome, reducedFlash: true, label: 'reduced-flash' },
  ]);
  if (preset === 'viewport') return [
    { width: 1920, height: 1080, dpr: 1 }, { width: 720, height: 1280, dpr: 1 },
    { width: 1280, height: 720, dpr: 2 },
  ].map(view => ({ ...PRIMARY, biome: 'RAINFOREST', ...view, label: 'viewport' }));
  if (preset === 'travel') return [0.25, 0.5, 0.75].map(t => ({
    ...PRIMARY, biome: 'RAINFOREST', transition: { to: 'DESERT', t }, label: `travel-${t}`,
  }));
  if (preset === 'geometry') return [
    { ...PRIMARY, biome: 'CANYON', label: 'broad-profile' },
    { ...PRIMARY, biome: 'CANYON', zoom: 0.72, label: 'pullback' },
    { ...PRIMARY, biome: 'DESERT', pass: 'no-massif', label: 'massif-off' },
    { ...PRIMARY, biome: 'DESERT', pass: 'no-space-ridge', label: 'signature-off' },
    { ...PRIMARY, biome: 'DESERT', pass: 'no-film', label: 'film-off' },
  ];
  if (preset === 'visibility') return Array.from({ length: 21 }, (_, station) => ({
    ...PRIMARY, biome: 'CANYON', station, timeMs: 5000 + station * 4000, label: 'visibility',
  }));
  return Array.from({ length: 120 }, (_, station) => ({
    ...PRIMARY, biome: 'RAINFOREST', station, timeMs: 18000 + station * 1000 / 12,
    transition: { to: 'DESERT', t: Math.min(1, Math.max(0, (station - 24) / 72)) }, label: 'motion',
  }));
}

export function caseId(spec, extra = {}) {
  return [spec.label || 'frame', spec.biome, spec.seed, spec.timeMs, spec.station ?? '-', spec.level,
    spec.reducedFlash ? 'reduced' : 'full', spec.width, spec.height, spec.dpr, spec.pass || 'all',
    spec.zoom ?? 1, extra.fixtureHash || 'nofixture',
    spec.transition ? `${spec.transition.to}-${spec.transition.t}` : 'settled'].join(':');
}
export function requireBiomes(available, required = REAL_BIOMES) {
  const have = new Set(available);
  const missing = required.filter(name => !have.has(name));
  if (missing.length) throw new Error(`required biome missing from the cast: ${missing.join(', ')}`);
}
