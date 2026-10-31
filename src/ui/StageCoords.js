// Maps client points through the stage's uniform contain or cover scaling.

/**
 * @param {number} clientX absolute client-space x (e.g. MouseEvent.clientX)
 * @param {number} clientY absolute client-space y
 * @param {{left:number, top:number, width:number, height:number}} rect the
 *   element's bounding box (e.g. from getBoundingClientRect())
 * @param {number} stageW logical stage width (e.g. 1280)
 * @param {number} stageH logical stage height (e.g. 720)
 * @param {string} [scaling] 'cover' fills/crops; other values contain the stage
 * @returns {{x:number, y:number}|null} stage coords, or null outside the
 *   visible box, inside contained bars, or when the stage has no area
 */
export function clientToStageCoords(clientX, clientY, rect, stageW, stageH, scaling = 'fit') {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(stageW > 0) || !(stageH > 0)) return null;
  const localX = clientX - rect.left, localY = clientY - rect.top;
  if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) return null;
  const scale = (scaling === 'cover' ? Math.max : Math.min)(rect.width / stageW, rect.height / stageH);
  const offX = (rect.width - stageW * scale) / 2, offY = (rect.height - stageH * scale) / 2;
  const x = (localX - offX) / scale, y = (localY - offY) / scale;
  if (x < 0 || x > stageW || y < 0 || y > stageH) return null;
  return { x, y };
}
