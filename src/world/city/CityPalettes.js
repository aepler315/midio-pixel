// Palettes inside the After Hours world. Same shape as BIOMES so
// BiomeManager._profile / particle fields / silhouette tint just work.
// Temperature axis is cool-wet → warm-sodium, not alpine cold-hot.

export const CITY_TEMPERATURE = {
  LATE: 0.08,
  NIGHTRAIN: 0.28,
  DISTRICT: 0.48,
  SODIUM: 0.70,
  LASTTRAIN: 0.92,
};

export const CITY_PALETTES = [
  {
    name: 'LATE',
    sky: ['#05060c', '#0c101c', '#1a2233'],
    silhouette: '#1a2030',
    celestial: { kind: 'moon', color: '#d8deea', radius: 36, haloColor: '#8a93a8', veiled: true },
    particles: { kind: 'rain', color: '#8aa0b8', count: 48, speed: 70 },
    fx: 'starTwinkle',
    terrainEnergy: 0.7,
  },
  {
    name: 'NIGHTRAIN',
    sky: ['#070b12', '#121c28', '#243044'],
    silhouette: '#1c2838',
    celestial: { kind: 'moon', color: '#c5d4e6', radius: 32, haloColor: '#7a90aa', veiled: true },
    particles: { kind: 'rain', color: '#9bb4cc', count: 70, speed: 90 },
    fx: 'starTwinkle',
    terrainEnergy: 0.85,
  },
  {
    name: 'DISTRICT',
    sky: ['#08060e', '#14101c', '#2a2438'],
    silhouette: '#241c30',
    edgeLight: '#5ec8c4',
    celestial: { kind: 'moon', color: '#e4dcc8', radius: 28, haloColor: '#c4b080' },
    particles: { kind: 'rain', color: '#7ec8c4', count: 40, speed: 55 },
    fx: 'neonGrid',
    terrainEnergy: 1.0,
  },
  {
    name: 'SODIUM',
    sky: ['#0c0806', '#1a120c', '#3a2814'],
    silhouette: '#2a2218',
    celestial: { kind: 'moon', color: '#f0d8a8', radius: 40, haloColor: '#e0a050' },
    particles: { kind: 'rain', color: '#d4a060', count: 36, speed: 40 },
    fx: 'emberGlow',
    terrainEnergy: 0.8,
  },
  {
    name: 'LASTTRAIN',
    sky: ['#0a0708', '#1c1010', '#3a2018'],
    silhouette: '#2c1c1c',
    celestial: { kind: 'moon', color: '#f2c8a0', radius: 44, haloColor: '#e09060' },
    particles: { kind: 'embers', color: '#e8a060', count: 22, speed: 18 },
    fx: 'sunMotes',
    terrainEnergy: 0.75,
  },
];
