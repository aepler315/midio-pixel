// Small, bounded foreground silhouettes. Coordinates fit [-50,50] x [-100,0]
// so NearField can enforce coverage independently of the painter's geometry.
export function drawWorldProp(ctx, seed) {
  const variant = seed % 3;
  ctx.beginPath();
  // Low broken stone on the Range.
  ctx.moveTo(-48, 0); ctx.lineTo(-40, -38 - variant * 6);
  ctx.lineTo(-12, -68); ctx.lineTo(17, -60 - variant * 8);
  ctx.lineTo(44, -26); ctx.lineTo(50, 0); ctx.closePath();
  ctx.fill();
}
