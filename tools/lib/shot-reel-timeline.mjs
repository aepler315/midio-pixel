/** Reel clock selection, frame labels and camera interpolation. This factory
 * is self-contained because shot-reel injects this exact function into the
 * browser. Node uses frameAt for the evidence index on the same clock. */
export function createReelTimeline(paths, schedule) {
  const frameAt = (t) => {
    const found = schedule.findIndex((x) => t < x.endMs);
    const index = found < 0 ? schedule.length - 1 : found, span = schedule[index];
    return { index, shot: span.id, move: span.move,
      progress: Math.min(1, Math.max(0, (t - span.startMs) / (span.endMs - span.startMs))) };
  };
  const cr = (a, b, c, d, u) => 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  const poseOf = (p, x) => {
    const n = p.s.length, xs = Math.min(Math.max(x, p.s[0]), p.s[n - 1]);
    let i = 0; while (i < n - 2 && p.s[i + 1] < xs) i++;
    const u = p.s[i + 1] > p.s[i] ? (xs - p.s[i]) / (p.s[i + 1] - p.s[i]) : 0, ia = Math.max(0, i - 1), id2 = Math.min(n - 1, i + 2);
    const pick = (arr, k, st) => { const a = arr[ia * st + k], b = arr[i * st + k], c = arr[(i + 1) * st + k], d = arr[id2 * st + k];
      return cr(ia === i ? 2 * b - c : a, b, c, id2 === i + 1 ? 2 * c - b : d, u); };
    return { eyeM: [0, 1, 2].map((k) => pick(p.eye, k, 3)), targetM: [0, 1, 2].map((k) => pick(p.aim, k, 3)), fovYDeg: pick(p.fov, 0, 1) };
  };
  return {
    frameAt,
    poseAt(t) {
      const frame = frameAt(t), p = paths[frame.index];
      return { ...poseOf(p, frame.progress * p.s[p.s.length - 1]), tour: true, shot: { kind: 'shot', id: frame.shot } };
    },
  };
}
