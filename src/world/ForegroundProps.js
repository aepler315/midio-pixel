// Small, bounded foreground silhouettes. Coordinates fit [-50,50] x [-100,0]
// so NearField can enforce coverage independently of the painter's geometry.
export function drawWorldProp(ctx, kind, seed) {
  const variant = seed % 3;
  ctx.beginPath();
  switch (kind) {
    case 'city': // street post and hooded lamp
      ctx.rect(-5, -90, 10, 90);
      ctx.rect(-32, -96, 64, 10);
      ctx.rect(-40, -86, 26, 12);
      break;
    case 'strip': // roadside chevron marker
      ctx.rect(-4, -65, 8, 65);
      ctx.rect(-33, -98, 66, 38);
      break;
    case 'foundry': // pipe elbow and bolted footing
      ctx.rect(-15, -80, 18, 80);
      ctx.rect(-15, -92, 60, 18);
      ctx.rect(-30, -12, 60, 12);
      break;
    case 'nave': // stepped pier with capital
      ctx.rect(-15, -88, 30, 88);
      ctx.rect(-28, -100, 56, 12);
      ctx.rect(-24, -12, 48, 12);
      break;
    case 'overgrowth': // branching root/trunk; broad crown is in the world
      ctx.moveTo(-28, 0); ctx.lineTo(-10, -40); ctx.lineTo(-12, -75);
      ctx.lineTo(-36, -93); ctx.lineTo(-27, -98); ctx.lineTo(0, -79);
      ctx.lineTo(22, -100); ctx.lineTo(30, -93); ctx.lineTo(10, -64);
      ctx.lineTo(12, -28); ctx.lineTo(42, 0); ctx.closePath();
      break;
    case 'abyssal': // branching sea fan rooted in the floor
      ctx.moveTo(-8, 0); ctx.lineTo(-4, -43); ctx.lineTo(-42, -78);
      ctx.lineTo(-35, -86); ctx.lineTo(-7, -66); ctx.lineTo(-12, -100);
      ctx.lineTo(0, -98); ctx.lineTo(6, -58); ctx.lineTo(39, -85);
      ctx.lineTo(46, -74); ctx.lineTo(9, -40); ctx.lineTo(14, 0); ctx.closePath();
      break;
    default: // regolith blocks in vacuum, low broken stone on the Range
      ctx.moveTo(-48, 0); ctx.lineTo(-40, -38 - variant * 6);
      ctx.lineTo(-12, -68); ctx.lineTo(17, -60 - variant * 8);
      ctx.lineTo(44, -26); ctx.lineTo(50, 0); ctx.closePath();
  }
  ctx.fill();
}
