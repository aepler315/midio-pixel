import { lerp, smoothstep } from '../utils/math.js';

// The room slips in one direction for a given print. Sustained sound moves
// the room. Individual attacks belong to the ink and its working edges.
export function roomRegistration(scan) {
  const color = scan.rows[Math.floor(scan.rows.length * .36)].color;
  const hand = color[2] > color[0] ? 1 : -1;
  const t = scan.songPosition ?? 0;
  const arc = smoothstep(0, .11, t) * (1 - smoothstep(.83, 1, t));
  const load = scan.withAudio === false ? 0 : arc * smoothstep(.035, .69, scan.sustained ?? 0);
  const roll = (.70 + .30 * Math.sin(scan.phase)) * hand * load;
  return { load, roll, hand, color };
}

// All silhouettes are cut from solid planes. A mapper may be the wall, its
// receding doorway, or a pair of actual curved rails on the folded print.
function cut(ctx, map, fill, coords) {
  ctx.beginPath();
  for (let i = 0; i < coords.length; i += 2) {
    const p = map(coords[i], coords[i + 1]);
    if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function tint(pigment, paper, amount) {
  return 'rgb(' + paper.map((channel, i) => Math.round(lerp(channel, pigment[i], amount))).join(',') + ')';
}

// Bentwood chair in profile: a pierced ladder back, a seat and four splayed
// legs. The empty intervals remain when the same cut is crushed onto a fold.
export function printChair(ctx, map, wood, light) {
  cut(ctx, map, wood, [.08,.02, .17,.03, .25,.48, .82,.45, .92,.54, .83,.59, .21,.60]);
  cut(ctx, map, wood, [.37,.06, .44,.08, .51,.47, .44,.50]);
  cut(ctx, map, wood, [.11,.04, .42,.07, .44,.16, .13,.14]);
  cut(ctx, map, wood, [.16,.24, .45,.26, .47,.32, .17,.30]);
  cut(ctx, map, wood, [.23,.57, .30,.57, .22,.94, .17,.94]);
  cut(ctx, map, wood, [.43,.58, .49,.58, .51,.82, .46,.83]);
  cut(ctx, map, wood, [.69,.56, .75,.55, .81,.81, .76,.82]);
  cut(ctx, map, wood, [.80,.54, .88,.52, .95,.93, .90,.96]);
  cut(ctx, map, light, [.25,.49, .80,.46, .87,.51, .32,.54]);
}

// A two-colour architectural print. Each doorway occludes the preceding
// wall and contains the same chair and window, in a different registration.
export function drawPaperRoom(ctx, view, state, effect) {
  const { load, roll, color } = state;
  const wall = tint(color, [105,109,95], .27);
  const shade = tint(color, [34,54,58], .18);
  const floor = tint(color, [87,66,60], .28);
  const paper = tint(color, [234,200,141], .19);
  const dark = tint(color, [19,30,33], .07);
  const warm = tint(color, [174,108,76], .24);
  const compact = effect !== 'fold';
  const size = compact ? .40 : 1;
  const width = size * Math.min(1.08, 1.76 * view.h / view.w);
  const x0 = compact ? .51 : .50, y0 = compact ? .48 : .515;
  // The doorway takes the place of the whole room. At full registration
  // its printed chair occupies the position just vacated by the real one.
  const doorLeft = .55 - .22 * load, doorRight = .782 + .14 * load;
  const doorTop = .16 - .12 * load, doorBottom = .64 + .15 * load;
  const zoom = 1 + 1.15 * load;
  const centreX = lerp(.50, lerp(doorLeft, doorRight, .50), load);
  const centreY = lerp(.50, lerp(doorTop, doorBottom, .50), load);
  // At the crest of the pull the floor tips up like a sheet of cardboard.
  // Both sides of the baseboard meet at exactly the same hinge.
  function project(x, y) {
    const height = y - .64;
    const floorTurn = Math.max(0, height) * load;
    return {
      x: x0 + width * zoom * (x - centreX + roll * (.22 * height + .44 * Math.max(0, height))),
      y: y0 + size * zoom * (y - centreY + .22 * roll * (x - .5) - .69 * floorTurn),
    };
  }
  cut(ctx, project, wall, [-8,-9, 9,-9, 9,.64, -8,.64]);
  cut(ctx, project, floor, [-8,.64, 9,.64, 9,12, -8,12]);

  // The same block is printed three times. When the song releases, only
  // the outer doorway and one quiet room behind it remain.
  function interior(map, depth) {
    const simple = depth > 0;
    cut(ctx, map, shade, [-.6,-.2, .17,-.2, .26,.64, -.6,.96]);
    cut(ctx, map, paper, [.169,-.2, .176,-.2, .267,.64, .26,.64]);
    cut(ctx, map, shade, [.26,.60, 1.4,.60, 1.4,.64, .26,.64]);
    cut(ctx, map, paper, [.26,.592, 1.4,.592, 1.4,.602, .26,.602]);

    // A sash window casts one broken parallelogram across the skirting.
    cut(ctx, map, dark, [.22,.13, .369,.16, .369,.45, .245,.41]);
    cut(ctx, map, paper, [.23,.15, .36,.176, .36,.431, .252,.399]);
    cut(ctx, map, shade, [.284,.16, .294,.161, .308,.418, .298,.415]);
    cut(ctx, map, shade, [.236,.27, .365,.298, .365,.313, .238,.284]);
    cut(ctx, map, warm, [.27,.64, .49,.64, .30,.85, -.07,.96]);
    cut(ctx, map, floor, [.36,.64, .374,.64, .13,.907, .105,.916]);
    if (!simple) {
      // Wallpaper lozenges and floorboards establish a familiar direction.
      for (let i = 0; i < 12; i++) {
        const x = .19 + i * .079;
        cut(ctx, map, shade, [x,.069, x+.008,.083, x,.096, x-.008,.083]);
        cut(ctx, map, dark, [x,.646, x+.003,.646, (x-.52)*3+.52,1.53, (x-.52)*3+.514,1.53]);
      }
    }

    // The first door opens onto an earlier registration. Its successor
    // catches up more slowly, so its window and chair slide out of phase.
    const advance = depth === 0 ? 1 : .39;
    const l = lerp(.55, doorLeft, advance), r = lerp(.782, doorRight, advance);
    const top = lerp(.16, doorTop, advance), bottom = lerp(.64, doorBottom, advance);
    const skew = roll * (.13 - depth * .07);
    cut(ctx, map, paper, [l-.014+skew,top-.018, r+.014+skew,top-.018, r+.014,bottom, l-.014,bottom]);
    cut(ctx, map, dark, [l+skew,top, r+skew,top, r,bottom, l,bottom]);
    function doorway(x, y) {
      return map(l + x*(r-l) + skew*(1-y), top + y*(bottom-top));
    }
    if (depth < 2) {
      ctx.save();
      // Use the doorway we just cut as the press mask for its next copy.
      ctx.clip();
      const visibility = depth === 0 ? .53 + .47*load : load;
      ctx.globalAlpha *= visibility;
      cut(ctx, doorway, wall, [0,0, 1,0, 1,.64, 0,.64]);
      cut(ctx, doorway, floor, [0,.64, 1,.64, 1,1, 0,1]);
      interior(doorway, depth + 1);
      ctx.restore();
    }
    // The door peels out of the wall toward the viewer. Its far edge widens
    // when the other room advances and still casts the original long shadow.
    cut(ctx, doorway, warm, [.78+.12*load,.08, 1,0, 1,1, .77+.12*load,.90]);
    cut(ctx, doorway, paper, [.78+.12*load,.08, .80+.12*load,.075, .79+.12*load,.90, .77+.12*load,.90]);
    if (!simple && load > 0) {
      // A turned stack of former door positions is visible edge-on.
      for (let i = 1; i <= 4; i++) {
        const x = .80 + .12*load + .035*i;
        cut(ctx, doorway, shade, [x,.09-.016*i, x+.009*load,.09-.016*i,
          x+.003,.92+.014*i, x,.92+.014*i]);
      }
    }
    cut(ctx, map, shade, [.47,.67, .58,.65, .72,.73, .55,.74]);
    const chairMap = (x, y) => map(.405 + .13*x + roll*.045*(1-y), .365 + .309*y);
    printChair(ctx, chairMap, dark, paper);
  }
  interior(project, 0);
}
