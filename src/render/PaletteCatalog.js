// Authored tonal roles; the palette as a whole is deliberately unordered.
export const RANGE32_RAMPS = Object.freeze({
  skyIce: Object.freeze('#000000 #101c2e #1c3044 #2c475b #416578 #5e8390 #8faab2 #cfdbd4'.split(' ')),
  forest: Object.freeze('#0e1712 #1c2a1b #2f4029 #46583a #65724d #84906a #a9b68b #d3d9b0'.split(' ')),
  stone: Object.freeze('#17191f #2c2f39 #434852 #5c6370 #798390 #9da7b0 #c2cbd0 #ffffff'.split(' ')),
  sunlight: Object.freeze('#281b20 #503035 #7b4641 #a46548 #cb8b55 #eab56c #f5d791 #fff1c2'.split(' ')),
});
export const RANGE32_COLORS = Object.freeze(Object.values(RANGE32_RAMPS).flat());

export const CHROMA32_COLORS = Object.freeze(`
  #000000 #0b1020 #18243a #2c3f58 #4b6178 #7c93a3 #bdcbd0 #ffffff
  #06242e #12586a #3fa0a8 #5ec8c4 #9fe3d6 #6f90d8 #3a5a9a #1a2c69
  #251b45 #483371 #78549e #aa7fb7 #ddacd0 #6a294c #af4169 #ec7793
  #281b20 #503035 #7b4641 #cb8b55 #eab56c #fff1c2 #2f4029 #84906a
`.trim().split(/\s+/));
export const PALETTES = Object.freeze({
  range32: Object.freeze({ id: 'range32', name: 'Landscape', colors: RANGE32_COLORS }),
  chroma32: Object.freeze({ id: 'chroma32', name: 'Chroma', colors: CHROMA32_COLORS }),
});
/** A bounded, stable world choice; never reads biome, camera or frame colors. */
export function resolvePaletteId(selection, worldKind = null) {
  if (selection === 'world') return worldKind === 'alpine' ? 'range32' : 'chroma32';
  return ['range32', 'chroma32', 'rgb332'].includes(selection) ? selection : 'none';
}
