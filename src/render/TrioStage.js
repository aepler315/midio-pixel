const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const shadow = (ctx, x, groundY, lift, radius, color) => {
  const strength = Math.max(.12, 1 - Math.max(0, lift) / 400);
  ctx.save(); ctx.globalAlpha = strength * .45; ctx.fillStyle = '#030711';
  ctx.beginPath(); ctx.ellipse(x, groundY + 3, radius * (.6 + strength * .4), 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = strength * .18; ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(x, groundY + 1, radius * .7, 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
};

/** Fixed stage camera; every foot and the platform share this transform.
 * Procedural parallax and wire silhouettes reference the pre-DEM trio era. */
export function drawTrioStage(ctx, canvas, stage, { drawMidio } = {}) {
  const W = stage.w, H = stage.h, t = stage.clockMs / 1000, scale = Math.min(canvas.width / W, canvas.height / H);
  const fit = { scale, x: (canvas.width - W * scale) / 2, y: (canvas.height - H * scale) / 2 };
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#040712'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.translate(fit.x, fit.y); ctx.scale(fit.scale, fit.scale);
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  const energy = stage.energySlow || 0, motion = stage.reducedMotion ? .25 : 1;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#080e25'); sky.addColorStop(.55, '#253653'); sky.addColorStop(1, '#664853');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 150; i++) {
    const x = ((hash(i + stage.seed) * (W + 20) - stage.worldX * .008 * motion) % (W + 20) + W + 20) % (W + 20);
    const y = 24 + hash(i * 3 + stage.seed) * H * .58;
    ctx.globalAlpha = .25 + .5 * hash(i + 77);
    ctx.fillStyle = '#bed8ed'; ctx.fillRect(Math.round(x / 4) * 4, Math.round(y / 4) * 4, 3, 3);
  }
  ctx.globalAlpha = 1;
  const glow = ctx.createRadialGradient(W * .76, H * .22, 4, W * .76, H * .22, W * .24);
  glow.addColorStop(0, 'rgba(143,196,208,.18)'); glow.addColorStop(1, 'rgba(100,170,200,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // One stable crescent with its shading clipped to the same disc.
  ctx.save(); ctx.translate(W * .76, H * .22);
  ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#abc7d0'; ctx.fillRect(-24, -24, 48, 48);
  ctx.fillStyle = '#52677e'; ctx.beginPath(); ctx.arc(-13, -6, 25, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  for (let layer = 0; layer < 3; layer++) {
    const base = H * (.57 + layer * .12), scroll = stage.worldX * (.015 + layer * .025) * motion;
    ctx.fillStyle = ['#23354b', '#1b3042', '#142b37'][layer];
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W + 24; x += 24) {
      const p = x + scroll + stage.seed * 13;
      const y = base + Math.sin(p / (260 - layer * 35)) * (45 - layer * 8) + Math.sin(p / 113 + layer) * 16;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  const groundAt = x => stage.ground.heightAt(stage.worldX + x - stage.midio.screenX);
  const ground = ctx.createLinearGradient(0, H * .8, 0, H);
  ground.addColorStop(0, '#24424b'); ground.addColorStop(1, '#0a1724');
  ctx.fillStyle = ground; ctx.beginPath(); ctx.moveTo(-8, H);
  for (let x = -8; x <= W + 8; x += 8) ctx.lineTo(x, groundAt(x));
  ctx.lineTo(W + 8, H); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = `rgba(129,211,199,${.5 + .25 * energy})`; ctx.lineWidth = 3;
  ctx.beginPath(); for (let x = -8; x <= W + 8; x += 8) { const y = groundAt(x); if (x === -8) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
  // Scrolling seams make running legible while leaving a continuous top.
  const spacing = 96, offset = (stage.worldX * motion) % spacing;
  ctx.strokeStyle = 'rgba(102,154,170,.2)'; ctx.lineWidth = 2;
  for (let x = -offset; x < W; x += spacing) {
    const y = groundAt(x); ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x - 24, H); ctx.stroke();
  }
  const m = stage.midio, b = stage.broshi, f = stage.midasus;
  const characterMotion = stage.reducedMotion ? .35 : 1;
  const bx = W * .68 + (b.renderX - W * .68) * characterMotion;
  const fx = W * .62 + (f.p.x - W * .62) * characterMotion;
  const fy = H * .32 + (f.p.y - H * .32) * characterMotion;
  shadow(ctx, m.screenX, m.groundY, m.y * characterMotion, 36, '#bcd6ed');
  shadow(ctx, bx, groundAt(bx), b.hopY * characterMotion, 44, '#a0e0cf');
  shadow(ctx, fx, groundAt(fx), groundAt(fx) - fy, 24, '#d0b6ef');
  ctx.save(); ctx.translate(bx - b.renderX, groundAt(bx) - b.groundY + (1 - characterMotion) * b.hopY);
  b.draw(ctx, stage.pose(), null, 1); ctx.restore();
  drawMidio?.(stage.pose(), stage.performer, t, stage.ensemble);
  ctx.save(); ctx.translate(fx - f.p.x, fy - f.p.y);
  f.draw(ctx, stage.particleMul ?? 1); ctx.restore();
  ctx.restore();
}
