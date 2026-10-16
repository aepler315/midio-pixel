// Bowyer-Watson Delaunay triangulation (spec §4.2.3). Pure geometry, no
// canvas dependency, so it's directly unit-testable.

function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function makeTri(points, a, b, c) {
  return orient(points[a], points[b], points[c]) < 0 ? [a, c, b] : [a, b, c];
}

function circumcircleContains(p, a, b, c) {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det > 1e-9;
}

/**
 * @param {{x:number,y:number}[]} inputPoints
 * @returns {number[][]} triangles as [i,j,k] index triples into inputPoints, CCW-wound
 */
export function delaunayTriangulate(inputPoints) {
  if (inputPoints.length < 3) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of inputPoints) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX, dy = maxY - minY;
  const deltaMax = Math.max(dx, dy, 1) * 10;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

  const points = [
    ...inputPoints,
    { x: midX - deltaMax, y: midY - deltaMax },
    { x: midX, y: midY + deltaMax * 2 },
    { x: midX + deltaMax, y: midY - deltaMax },
  ];
  const s1 = inputPoints.length, s2 = s1 + 1, s3 = s1 + 2;

  let triangles = [makeTri(points, s1, s2, s3)];

  for (let pi = 0; pi < inputPoints.length; pi++) {
    const p = points[pi];
    const bad = [];
    for (const t of triangles) {
      if (circumcircleContains(p, points[t[0]], points[t[1]], points[t[2]])) bad.push(t);
    }
    if (bad.length === 0) continue; // degenerate/duplicate point, skip

    const edgeMap = new Map();
    for (const t of bad) {
      const edges = [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
      for (const [a, b] of edges) {
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (edgeMap.has(k)) edgeMap.get(k).count++;
        else edgeMap.set(k, { count: 1, a, b });
      }
    }

    const badSet = new Set(bad);
    triangles = triangles.filter((t) => !badSet.has(t));
    for (const { count, a, b } of edgeMap.values()) {
      if (count === 1) triangles.push(makeTri(points, a, b, pi));
    }
  }

  return triangles.filter((t) => t[0] < inputPoints.length && t[1] < inputPoints.length && t[2] < inputPoints.length);
}

/** Poisson-disc-ish sampling via dart-throwing with rejection (good enough for interior crack-shard seeding). */
export function poissonDiscSample(width, height, radius, rand, maxAttempts = 30) {
  const cellSize = radius / Math.SQRT2;
  const gridW = Math.ceil(width / cellSize), gridH = Math.ceil(height / cellSize);
  const grid = new Array(gridW * gridH).fill(-1);
  const points = [];
  const active = [];

  const gridIndex = (x, y) => Math.floor(x / cellSize) + Math.floor(y / cellSize) * gridW;
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize);
    for (let j = Math.max(0, gy - 2); j <= Math.min(gridH - 1, gy + 2); j++) {
      for (let i = Math.max(0, gx - 2); i <= Math.min(gridW - 1, gx + 2); i++) {
        const idx = grid[i + j * gridW];
        if (idx !== -1) {
          const q = points[idx];
          if ((q.x - x) ** 2 + (q.y - y) ** 2 < radius * radius) return false;
        }
      }
    }
    return true;
  };

  const first = { x: rand() * width, y: rand() * height };
  points.push(first);
  active.push(0);
  grid[gridIndex(first.x, first.y)] = 0;

  while (active.length > 0) {
    const idx = active[Math.floor(rand() * active.length)];
    const base = points[idx];
    let found = false;
    for (let k = 0; k < maxAttempts; k++) {
      const ang = rand() * Math.PI * 2;
      const r = radius * (1 + rand());
      const x = base.x + Math.cos(ang) * r, y = base.y + Math.sin(ang) * r;
      if (fits(x, y)) {
        points.push({ x, y });
        active.push(points.length - 1);
        grid[gridIndex(x, y)] = points.length - 1;
        found = true;
        break;
      }
    }
    if (!found) {
      const pos = active.indexOf(idx);
      active.splice(pos, 1);
    }
  }
  return points;
}
