/** Scenic logical → device → ground logical. Intensity and color stay put. */
export function convertLightBetween(light, fromMatrix, toMatrix) {
  fromMatrix = affineMatrix(fromMatrix);
  toMatrix = affineMatrix(toMatrix);
  if (!light || !fromMatrix?.transformPoint || !toMatrix?.inverse) return light;
  const inverse = toMatrix.inverse();
  if (!inverse?.transformPoint) return light;
  const map = (x, y) => {
    const device = fromMatrix.transformPoint({ x, y });
    return inverse.transformPoint({ x: device.x, y: device.y });
  };
  const origin = map(light.x, light.y);
  const dirX = Number.isFinite(light.dirX) ? light.dirX : 0;
  const dirY = Number.isFinite(light.dirY) ? light.dirY : 1;
  const tip = map(light.x + dirX, light.y + dirY);
  const dx = tip.x - origin.x;
  const dy = tip.y - origin.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    ...light,
    x: origin.x,
    y: origin.y,
    dirX: dx / len,
    dirY: dy / len,
    space: 'ground',
  };
}

// Viewport snapshots store numeric affine arrays, independent of DOMMatrix.
function affineMatrix(m) {
  if (!Array.isArray(m)) return m;
  const [a,b,c,d,e,f] = m, det = a*d-b*c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    transformPoint: ({x,y}) => ({x:a*x+c*y+e,y:b*x+d*y+f}),
    inverse: () => affineMatrix([d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det]),
  };
}
