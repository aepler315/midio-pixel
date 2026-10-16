// Listener zoom for Range views: the scroll wheel (and a trackpad pinch,
// which browsers deliver as ctrl+wheel) and a two-finger touch pinch, both
// toward the pointer. The camera math lives in world/alpine/RangeCamera.js;
// this only turns DOM events into RangeUserCamera.zoomAt() calls.
//
// Outside a Range view (another world, the title screen) the wheel is left
// alone so the page scrolls as usual.

const WHEEL_GAIN = 0.0015;      // per pixel of wheel delta
const CTRL_WHEEL_GAIN = 0.01;   // trackpad pinch: small deltas, many events
const LINE_PX = 16, PAGE_PX = 400;

/** Wheel delta (any deltaMode) -> a zoom factor (> 1 zooms in). */
export function wheelZoomFactor({ deltaY = 0, deltaMode = 0, ctrlKey = false } = {}) {
  const px = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1);
  const f = Math.exp(-px * (ctrlKey ? CTRL_WHEEL_GAIN : WHEEL_GAIN));
  return Math.min(2, Math.max(0.5, f));
}

/**
 * Wire zoom input to `canvas`.
 *   camera     RangeUserCamera
 *   enabled()  whether a live song is playing with the user camera on
 *   toStage(e) client event -> { x, y } in stage pixels, or null
 * Returns { live(), pinching(e), detach() }. live() says whether zoom input
 * is active now; pinching(e) is true for a pointerdown that joins a
 * multi-touch gesture, so the caller can drop its tap.
 */
export function attachRangeZoomInput(canvas, { camera, enabled, toStage, stageW = 1280, stageH = 720 }) {
  const touches = new Map();
  let lastSpan = 0;
  const live = () => enabled() && camera.isActive();
  const ndc = (p) => (p ? [(p.x / stageW) * 2 - 1, 1 - (p.y / stageH) * 2] : [0, 0]);
  const pinchState = () => {
    const [a, b] = [...touches.values()];
    const span = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = toStage({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
    return { span, mid };
  };

  const onWheel = (e) => {
    if (!live()) return;
    // Over the letterbox bars there is no stage point: leave the page alone.
    const p = toStage(e);
    if (!p) return;
    e.preventDefault();
    camera.zoomAt(wheelZoomFactor(e), ...ndc(p));
  };
  const onDown = (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (touches.size === 2) lastSpan = pinchState().span;
  };
  const onMove = (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.clientX = e.clientX; t.clientY = e.clientY;
    if (touches.size !== 2 || !live()) return;
    e.preventDefault();
    const { span, mid } = pinchState();
    if (lastSpan > 8 && span > 8 && mid) camera.zoomAt(span / lastSpan, ...ndc(mid));
    lastSpan = span;
  };
  const onUp = (e) => {
    touches.delete(e.pointerId);
    lastSpan = touches.size === 2 ? pinchState().span : 0;
  };

  // Over a Range view, a two-finger touch is ours: stop the browser taking
  // it as a page zoom. Anywhere else touch keeps its native behaviour.
  const onTouch = (e) => { if (e.touches.length >= 2 && live()) e.preventDefault(); };
  canvas.addEventListener('touchstart', onTouch, { passive: false });
  canvas.addEventListener('touchmove', onTouch, { passive: false });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(type, onUp);
  return {
    live,
    pinching: (e) => e.pointerType === 'touch' && touches.size >= 2 && touches.has(e.pointerId),
    detach() {
      canvas.removeEventListener('touchstart', onTouch);
      canvas.removeEventListener('touchmove', onTouch);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) canvas.removeEventListener(type, onUp);
    },
  };
}
