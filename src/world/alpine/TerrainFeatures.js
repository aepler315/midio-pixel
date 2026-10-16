// Sparse source-space contour hints sampled from the actual drawable mesh.
// Never expose tile/triangle edges; bounded reservoir distributes hints over
// the geography without retaining a second terrain mesh. The GPU shares the
// terrain's displacement and depth preparation, including glacier thickness.
export function terrainFeatureSegments(positions, indices, { intervalM = 300, maxSegments = 768 } = {}) {
  intervalM = Math.max(1, intervalM);
  maxSegments = Math.max(0, Math.floor(maxSegments));
  if (!maxSegments) return new Float32Array();
  const reservoir = new Float32Array(maxSegments * 6);
  let seen = 0, count = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const pts = [indices[i], indices[i + 1], indices[i + 2]].map(k => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
    if (!pts.flat().every(Number.isFinite)) continue;
    const heights = pts.map(p => p[1]), low = Math.min(...heights), high = Math.max(...heights);
    for (let y = (Math.floor(low / intervalM) + 1) * intervalM; y < high; y += intervalM) {
      const hits = [];
      for (let e = 0; e < 3; e++) {
        const a = pts[e], b = pts[(e + 1) % 3];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          const t = (y - a[1]) / (b[1] - a[1]);
          hits.push([a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]);
        }
      }
      if (hits.length !== 2) continue;
      seen++;
      // Deterministic reservoir, independent of render history or RNG seed.
      const slot = seen <= maxSegments ? seen - 1 : ((Math.imul(seen, 2654435761) >>> 0) % seen);
      if (slot >= maxSegments) continue;
      reservoir.set(hits.flat(), slot * 6); count = Math.min(maxSegments, seen);
    }
  }
  return reservoir.slice(0, count * 6);
}
