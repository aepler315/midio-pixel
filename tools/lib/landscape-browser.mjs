// Browser-side evidence helpers. Nothing here changes production state outside
// this controlled page. Fixed export time avoids audio-clock/RAF screenshot races.
export async function installLandscapeRanges(fixtures) {
  const { loadRangeProfiles, RANGES } = await import('/src/world/terrain/RangeLibrary.js');
  const terrain = window.__SMW.sim.biomes.songTerrain;
  if (!terrain) throw new Error('fixture song has no real terrain');
  await terrain.whenAll;
  for (const [biome, ids] of Object.entries(fixtures)) {
    const ranges = {}, profiles = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const range = RANGES.find(item => item.id === id);
      if (!range) throw new Error(`missing real range ${id}`);
      const loaded = await loadRangeProfiles(id);
      if (!loaded.L2) throw new Error(`missing source skyline ${id}`);
      ranges[['far', 'mid', 'near'][i]] = range;
      profiles[['L2', 'L3', 'L4'][i]] = loaded.L2;
    }
    terrain.byBiome.set(biome, { biome, ranges, profiles });
  }
  return { naturalCast: terrain.biomes, songSeed: window.__SMW.songSeed };
}

export function seedBrowserConstruction(seed) {
  window.__landscapeConstructionSeed = seed >>> 0;
  window.__resetLandscapeRandom = () => {
    let state = seed >>> 0;
    Math.random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };
  window.__resetLandscapeRandom();
}

export async function paintLandscapeFrame(spec) {
  const { dayNight } = await import('/src/world/DayNight.js');
  const continuous = spec.label === 'motion' && spec.station > 0;
  if (!continuous) {
    window.__resetLandscapeRandom();
    window.__SMW.beginBulkExport({ width: spec.width * spec.dpr, height: spec.height * spec.dpr });
  }
  const { sim, renderer, perf } = window.__SMW;
  const mgr = sim.biomes;
  sim.reducedFlash = !!spec.reducedFlash;
  mgr.reducedFlash = !!spec.reducedFlash;
  // An explicit pin: export's full-quality hold would otherwise reset the
  // requested rung to 0 before the frame is drawn. Cleared in `finally`.
  if (perf) perf.setFixtureLevel(spec.level);
  const zoomTools = spec.zoom ? await import('/src/render/CameraDirector.js') : null;
  const to = spec.transition?.to || spec.biome;
  const blend = { from: spec.biome, to, t: spec.transition?.t ?? 1,
    travel: !!spec.transition, travelP: spec.transition?.t ?? 1,
    fromHeightMul: 1, toHeightMul: 1, fromSnowLine01: 1, toSnowLine01: 1 };
  const originals = [];
  const replace = (object, name, replacement) => {
    originals.push({ object, name, fn: object[name] }); object[name] = replacement;
  };
  const travelCompositeLayers = [];
  const sides = new Map();
  const masks = new Map();
  let ground = [];
  let scenicMatrix = null;
  const disabledPasses = [];
  // Everything the capture changes is applied here, after the export clock
  // has stepped to the requested instant and before its one draw.
  const configure = () => {
    mgr.currentBlend = blend;
    if (zoomTools) {
      const { FLOAT_TILT_MAX, ZOOM_MIN } = zoomTools;
      sim.camera.zoom = spec.zoom;
      sim.camera.floatTilt = FLOAT_TILT_MAX * Math.min(1, Math.max(0, (1 - spec.zoom) / (1 - ZOOM_MIN)));
      mgr.floatTilt = sim.camera.floatTilt;
    }
    sim.camera.shakeX = 0; sim.camera.shakeY = 0; sim.camera.roll = 0;
    // Suppress screenshot-only labels, never world primitives or characters.
    sim.rangeCaption = null;
    sim.rangeCaptions = null;
    renderer.hudInFrame = false;
    const compositeTravelSides = mgr._compositeTravelSides;
    replace(mgr, '_compositeTravelSides', function (...args) {
      travelCompositeLayers.push(args[4]);
      return compositeTravelSides.apply(this, args);
    });
    if (spec.pass === 'no-massif') { replace(mgr, '_drawSpectrumMassif', () => {}); disabledPasses.push('massif'); }
    if (spec.pass === 'no-space-ridge') { replace(mgr.spaceRidge, 'draw', () => {}); disabledPasses.push('space-ridge'); }
    if (spec.pass === 'no-film') { replace(renderer, '_drawFilmFinish', () => {}); disabledPasses.push('film'); }
    for (const name of new Set([spec.biome, to])) sides.set(name, mgr.stripsFor(name));
    const groundInterior = mgr._drawGroundInterior;
    replace(mgr, '_drawGroundInterior', function (ctx, canvas, path, bars, ...args) {
      const matrix = ctx.getTransform();
      ground = bars.map(bar => {
        const p = matrix.transformPoint({ x: bar.x + bar.width / 2, y: bar.y });
        return { x: p.x / spec.dpr, y: p.y / spec.dpr };
      });
      return groundInterior.call(this, ctx, canvas, path, bars, ...args);
    });
    const recordPath = (method, id, filled = false) => {
      const draw = mgr[method];
      replace(mgr, method, function (ctx, ...args) {
        const matrix = ctx.getTransform();
        const saved = Object.fromEntries(['beginPath', 'moveTo', 'lineTo', filled ? 'fill' : 'stroke']
          .map(name => [name, ctx[name]]));
        let path = [], best = [];
        ctx.beginPath = function (...v) { path = []; return saved.beginPath.apply(this, v); };
        for (const name of ['moveTo', 'lineTo']) ctx[name] = function (x, y) {
          path.push({ x, y }); return saved[name].call(this, x, y);
        };
        const paint = filled ? 'fill' : 'stroke';
        ctx[paint] = function (...v) {
          if (path.length > best.length) best = path.slice();
          return saved[paint].apply(this, v);
        };
        try { return draw.call(this, ctx, ...args); }
        finally {
          Object.assign(ctx, saved);
          // The massif's first/last vertices close its body at the foot.
          const line = filled && best.length > 2 ? best.slice(1, -1) : best;
          masks.set(id, { id, biome: null, samples: line.map(p => {
            const screen = matrix.transformPoint(p);
            return { x: screen.x / spec.dpr, y: screen.y / spec.dpr };
          }).filter(p => p.x >= 0 && p.x <= spec.width) });
        }
      });
    };
    recordPath('_drawHorizonEQ', 'horizon');
    recordPath('_drawSpectrumMassif', 'massif', true);
    // Capture after _drawLayer applies its layer-specific tilt, and only while
    // it paints. The diagnostic geometry pass after painting must not replace
    // these screen masks with unrotated points under the last layer's matrix.
    const layerDraw = mgr._paintAlpineLayer;
    replace(mgr, '_paintAlpineLayer', function (...args) {
      scenicMatrix = args[0].getTransform();
      try { return layerDraw.apply(this, args); }
      finally { scenicMatrix = null; }
    });
    const crestPoints = mgr._crestPoints;
    replace(mgr, '_crestPoints', function (...args) {
      const geom = crestPoints.apply(this, args);
      if (geom?.pts && scenicMatrix) {
        const [, strip, , , layer] = args;
        for (const [name, strips] of sides) if (strips[layer] === strip) {
          const points = geom.pts.map(p => {
            const screen = scenicMatrix.transformPoint({ x: p.x, y: p.y });
            return { x: screen.x / spec.dpr, y: screen.y / spec.dpr };
          }).filter(p => p.x >= 0 && p.x <= spec.width);
          masks.set(`${name}:${layer}`, { id: layer, biome: name, samples: points,
            drawHeight: geom.dh, terrain: strip.ridge?.source === 'terrain',
            source: strip.ridge?.source || null });
        }
      }
      return geom;
    });
    drawStart = performance.now();
  };
  let drawStart = 0;
  const frameTimes = [];
  let clock;
  let actualLevel;
  try {
    // Assembly captures its target on the first drawn frame after 200ms.
    // Skipping every intermediate paint would start that opening at the
    // requested station and cover a 20-second frame in newborn shards.
    // This earlier capture is its own timestamp, not a second final draw.
    if (!continuous && spec.timeMs > 250) window.__SMW.renderExportFrame(250);
    clock = window.__SMW.renderExportFrame(spec.timeMs, { beforeDraw: configure });
    frameTimes.push(performance.now() - drawStart);
    actualLevel = perf ? perf.level : null;
    if (window.__SMW.sim !== sim) throw new Error('export unexpectedly rebuilt the simulation');
  } finally {
    for (const { object, name, fn } of originals.reverse()) object[name] = fn;
    if (perf) perf.setFixtureLevel(null);
  }
  const canvas = document.querySelector('#stage');
  return {
    pngData: canvas.toDataURL('image/png').split(',')[1],
    clock, actualSongSeed: sim.songSeed, constructionSeed: spec.seed,
    dpr: window.devicePixelRatio, backing: { width: canvas.width, height: canvas.height },
    worldKind: mgr.world.kind, blend, travelCompositeLayers,
    night: dayNight(mgr.tSec * 1000, mgr._dayNightCycleMs).night,
    camera: { zoom: sim.camera.zoom, floatTilt: mgr.floatTilt,
      shakeX: sim.camera.shakeX, shakeY: sim.camera.shakeY },
    ranges: [...sides.keys()].map(name => ({ biome: name,
      ids: ['far', 'mid', 'near'].map(k => mgr.rangesFor(name)?.[k]?.id || null) })),
    masks: [...masks.values()], horizon: masks.get('horizon')?.samples || [], ground,
    geometry: mgr._landscapeGeometry ? {
      metrics: mgr._landscapeGeometry.metrics,
      fits: mgr._landscapeGeometry.fits,
    } : null, presentation: mgr._rangePresentation,
    light: mgr.currentLight(), frameTimes,
    // What actually produced this frame, not what was asked for.
    quality: { requested: spec.level, actual: actualLevel },
    finalDraws: clock.draws,
    generation: window.__SMW.generation ?? null,
    renderer: window.__SMW.rendererBackend || 'canvas',
    rangeRenderer: window.__SMW.rangeRenderer || null,
    passes: { disabled: disabledPasses },
  };
}

/** Browser evidence only: restore the existing URL seed receiver omitted by
 * the current HTML. Source responses remain untouched. Install before modules. */
export function installSeedReceiver() {
  const install = () => {
    if (!document.body) return false;
    if (!document.getElementById('seedInput')) {
      const input = document.createElement('input');
      input.hidden = true; input.id = 'seedInput'; input.value = '0';
      document.body.prepend(input);
    }
    return true;
  };
  if (!install()) {
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
}
