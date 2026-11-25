// Migrate an eroded drainage line across its available floodplain. Bend flow
// loads the outside bank downstream of the apex; a high or confined bank
// resists retreat. Positions are relative to the routed valley throughout.
export function migrateChannel(points, cellM, heightAt, reliefM, erodibility) {
  const n = points.length, moved = points.map(p => ({ ...p }));
  if (n < 3) return moved;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  const left = new Float64Array(n), right = new Float64Array(n), normalX = new Float64Array(n), normalZ = new Float64Array(n);
  const mobility = new Float64Array(n), bankBias = new Float64Array(n), before = new Int32Array(n), after = new Int32Array(n);
  let a = 0, b = 1;
  for (let i = 1; i < n - 1; i++) {
    const p = points[i], width = p.channelM;
    const reach = Math.max(.85 * cellM, 2.5 * width);
    while (a < i - 1 && arc[a + 1] < arc[i] - reach) a++;
    while (a > 0 && arc[a] > arc[i] - reach) a--;
    while (b < n - 1 && arc[b] < arc[i] + reach) b++;
    while (b > i + 1 && arc[b - 1] > arc[i] + reach) b--;
    before[i] = a; after[i] = b;
    const dx = points[b].x - points[a].x, dz = points[b].z - points[a].z, chord = Math.hypot(dx, dz) || 1;
    const nx = normalX[i] = -dz / chord, nz = normalZ[i] = dx / chord;
    const slope = Math.max(0, points[a].bed - points[b].bed) / Math.max(1, arc[b] - arc[a]);
    const pin = Math.min(1, arc[i] / reach, (arc[n - 1] - arc[i]) / reach);
    const room = Math.min(4.5 * width, Math.max(0, p.floorM - width)) * pin * pin * (3 - 2 * pin);
    const centre = heightAt(p.x, p.z);
    // Check both the intervening slope and the far side, so a low point
    // beyond a spur cannot pull the river through the divide.
    const roomOn = sign => {
      const sx = sign * room * nx, sz = sign * room * nz;
      const rise = reliefM * Math.max(0, heightAt(p.x + sx * .5, p.z + sz * .5) - centre, heightAt(p.x + sx, p.z + sz) - centre);
      return room / (1 + (rise / (3 + .045 * width)) ** 2);
    };
    left[i] = roomOn(1); right[i] = roomOn(-1);
    bankBias[i] = (left[i] - right[i]) / Math.max(1, room);
    // The same rock coefficient that set stream-power incision also slows
    // lateral retreat in hard outcrops. Loose hillslope deposits cover it.
    const rock = p.erodibility ?? 1, cover = Math.max(0, p.colluviumM ?? 0);
    const bankErodibility = rock + (1.2 - rock) * cover / (2 + cover);
    mobility[i] = erodibility * bankErodibility * (1 - .96 * p.gorge) * (.35 + .65 * p.broad) / (1 + 40 * slope);
  }
  const offsets = new Float64Array(n);
  for (let epoch = 0; epoch < 6; epoch++) {
    let bendFlow = 0;
    for (let i = 1; i < n - 1; i++) {
      const p = moved[i], u = moved[before[i]], v = moved[after[i]], width = p.channelM;
      const ux = p.x - u.x, uz = p.z - u.z, vx = v.x - p.x, vz = v.z - p.z;
      const incoming = Math.hypot(ux, uz), outgoing = Math.hypot(vx, vz), chord = Math.hypot(ux + vx, uz + vz);
      const curvature = 2 * (ux * vz - uz * vx) / Math.max(1, incoming * outgoing * chord);
      const bend = Math.max(-1, Math.min(1, 3 * width * curvature));
      // Secondary flow carries momentum for several channel widths. This
      // shifts erosion downstream and leaves sediment on the inner bank.
      bendFlow += (bend - bendFlow) * -Math.expm1(-(arc[i] - arc[i - 1]) / (5 * width));
      const t = incoming / Math.max(1, incoming + outgoing);
      const cut = (u.x + (v.x - u.x) * t - p.x) * normalX[i] + (u.z + (v.z - u.z) * t - p.z) * normalZ[i];
      const erosion = mobility[i] * width * (-1.05 * bendFlow + .22 * bankBias[i]);
      offsets[i] = Math.max(-right[i], Math.min(left[i], offsets[i] + erosion + .18 * cut));
    }
    for (let i = 1; i < n - 1; i++) {
      moved[i].x = points[i].x + normalX[i] * offsets[i];
      moved[i].z = points[i].z + normalZ[i] * offsets[i];
    }
  }
  return moved;
}
