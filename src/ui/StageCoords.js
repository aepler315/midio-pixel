// Maps a client-space point into logical stage coordinates, accounting for
// the `object-fit: contain` letterboxing the #stage canvas uses to fit its
// container while keeping the 16:9 stage aspect (see style.css). A CSS box
// whose own aspect isn't exactly stageW:stageH always letterboxes/pillar-
// boxes -- the common case, not the exception -- so mapping straight
// through the box's raw bounding rect (ignoring the bars) puts every
// off-center point at the wrong fraction of the stage.

/**
 * @param {number} clientX absolute client-space x (e.g. MouseEvent.clientX)
 * @param {number} clientY absolute client-space y
 * @param {{left:number, top:number, width:number, height:number}} rect the
 *   element's bounding box (e.g. from getBoundingClientRect())
 * @param {number} stageW logical stage width (e.g. 1280)
 * @param {number} stageH logical stage height (e.g. 720)
 * @returns {{x:number, y:number}|null} stage coords, or null when the box
 *   has no area or the point falls inside a letterbox/pillarbox bar
 */
export function clientToStageCoords(clientX, clientY, rect, stageW, stageH) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const boxAspect = rect.width / rect.height;
  const stageAspect = stageW / stageH;
  let contentW = rect.width, contentH = rect.height, offX = 0, offY = 0;
  if (boxAspect > stageAspect) {
    // Pillarboxed: bars on left/right.
    contentW = rect.height * stageAspect;
    offX = (rect.width - contentW) / 2;
  } else if (boxAspect < stageAspect) {
    // Letterboxed: bars on top/bottom.
    contentH = rect.width / stageAspect;
    offY = (rect.height - contentH) / 2;
  }
  const x = ((clientX - rect.left - offX) / contentW) * stageW;
  const y = ((clientY - rect.top - offY) / contentH) * stageH;
  if (x < 0 || x > stageW || y < 0 || y > stageH) return null;
  return { x, y };
}
