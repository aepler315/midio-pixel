// Port of ridgeview/test/viewpoints.test.mjs's synthetic north/south crest.
// Coordinates here are local metres: east +X, south +Z, height +Y.
import { sampleHeight } from '../../tools/lib/terrain-source.mjs';

export function syntheticCrestGrid({ cellSizeM = 100 } = {}) {
  const width = Math.round(40000 / cellSizeM) + 1, height = width;
  const originM = [-20000, -20000], water = new Uint8Array(width * height);
  const heightsM = Float32Array.from({ length: width * height }, (_, i) => {
    const east = originM[0] + i % width * cellSizeM, north = -(originM[1] + Math.floor(i / width) * cellSizeM);
    let h = 1000 + 1900 * Math.exp(-((east / 2500) ** 2)) * Math.exp(-((north / 18000) ** 2));
    for (const [py, amp] of [[-9000, 600], [-2500, 450], [4000, 520], [10000, 380]]) {
      h += amp * Math.exp(-((east / 1300) ** 2) - (((north - py) / 1500) ** 2));
    }
    if (east < -6000) h = Math.max(h, 2600 - Math.max(0, -east - 14000) * .1);
    if (east > 7000 && east < 13000 && Math.abs(north) < 6000) { h = 1000; water[i] = 1; }
    return h;
  });
  return { width, height, cellSizeM, originM, heightsM, valid: new Uint8Array(width * height).fill(1), water };
}

export function syntheticCrestPoints(grid) {
  return [-9000, -2500, 4000, 10000].map((north, i) => {
    const y = sampleHeight(grid, 0, -north);
    return { id: `summit-${i}`, type: 'summit', localM: [0, y, -north], elevationM: y,
      grandeur: .7 + i * .1, reliefM: y - 1000, prominenceM: 300, faceAspectDeg: 90 };
  });
}
