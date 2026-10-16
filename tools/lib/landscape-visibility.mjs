/** Visible crest fraction by x, never by index alignment between masks. */

function yAt(samples, x) {
  if (!samples?.length) return null;
  if (x < samples[0].x) return null;
  const last = samples[samples.length - 1];
  if (x > last.x) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

/** Integrate a ridge body above the actual drawn ground curve. Masks nearer
 * than this ridge still need to be considered separately for exposed area. */
export function bodyAreaFraction(crest, ground, width, height) {
  if (!crest?.length || !ground?.length || !(width > 0 && height > 0)) return null;
  let area = 0;
  for (let i = 1; i < crest.length; i++) {
    const a = crest[i - 1], b = crest[i];
    const ga = yAt(ground, a.x), gb = yAt(ground, b.x);
    if (ga == null || gb == null) continue;
    area += Math.max(0, b.x - a.x) * (Math.max(0, ga - a.y) + Math.max(0, gb - b.y)) / 2;
  }
  return area / (width * height);
}

/**
 * A crest sample is hidden when any occluder is above it (smaller screen y).
 * `occluders` are { id, samples: [{x,y}] }.
 */
export function visibleCrestFraction(crest, occluders = []) {
  if (!crest?.length) {
    return { fraction: 0, longestRun: 0, dominant: 'empty-geometry', samples: 0 };
  }
  const hits = new Map();
  let visible = 0;
  let run = 0;
  let longest = 0;
  for (const point of crest) {
    let blocker = null;
    for (const mask of occluders) {
      const y = yAt(mask.samples, point.x);
      if (y == null) continue;
      if (y < point.y - 0.5) {
        blocker = mask.id;
        break;
      }
    }
    if (blocker) {
      hits.set(blocker, (hits.get(blocker) || 0) + 1);
      run = 0;
    } else {
      visible += 1;
      run += 1;
      if (run > longest) longest = run;
    }
  }
  let dominant = null;
  let best = 0;
  for (const [id, count] of hits) {
    if (count > best) { best = count; dominant = id; }
  }
  return {
    fraction: visible / crest.length,
    longestRun: longest / crest.length,
    dominant,
    samples: crest.length,
  };
}
