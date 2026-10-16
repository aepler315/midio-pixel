// Production RangeScene receiver pixel regression. Run with an output directory
// and WAV fixture; PLAYWRIGHT_CHROMIUM_PATH selects the installed browser.
// Camera, music, travel and geometry are frozen while celestial state changes.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { openSong, captureFrame } from "./range-scene-smoke.mjs";
import { seedBrowserConstruction } from "./lib/landscape-browser.mjs";
const out = path.resolve(process.argv[2] || "work/landscape-lighting"), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), report = { sources: {} };
const wav = process.argv[3];
if (!wav) throw new Error("Usage: node tools/landscape-lighting-smoke.mjs OUTPUT_DIRECTORY WAV_FILE");
await fs.mkdir(out, { recursive: true });
const url = process.env.RANGE_LIGHTING_URL || "http://127.0.0.1:8194";
for (const file of ["RangeScene", "TerrainMaterial", "ForestGL", "RockStageGL"]) {
  const name = `src/world/alpine/${file}.js`, local = await fs.readFile(path.join(root, name)), served = Buffer.from(await (await fetch(url + "/" + name)).arrayBuffer());
  assert.ok(local.equals(served));
  report.sources[name] = createHash("sha256").update(local).digest("hex");
}
const browser = await chromium.launch({ ...process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}, args: process.env.PLAYWRIGHT_CHROMIUM_PATH ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const wrapper = { async newContext(options) {
    const c = await browser.newContext(options);
    await c.addInitScript(seedBrowserConstruction, 315);
    await c.addInitScript(() => {
      const install = () => {
        if (!document.body) return false;
        const input = document.createElement("input");
        input.hidden = true;
        input.id = "seedInput";
        input.value = "0xADDE5713";
        document.body.prepend(input);
        return true;
      };
      if (!install()) {
        const observer = new MutationObserver(() => {
          if (install()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    });
    return c;
  } };
  const opened = await openSong(wrapper, { url, wav: path.resolve(wav), width: 1280, height: 720, dpr: 1, params: { rangeRenderer: "v2", rangeView: "teton-jackson-lake", seed: "2917029651" } });
  await captureFrame(opened.page, 250);
  await captureFrame(opened.page, 2e4);
  const evidence = await opened.page.evaluate(async () => {
    const app = window.__SMW, pres = app.sim.biomes.rangePresentation, scene = pres.scene, base = pres.frame, p = scene.prepared.get(pres.viewId), T = scene.THREE;
    const { resolveCelestialState } = await import("/src/world/CelestialState.js");
    const { convertLightBetween } = await import("/src/world/alpine/LightSpace.js");
    const w = base.scenicViewport.logicalWidth, h = base.scenicViewport.logicalHeight;
    let id = base.frameId + 1e3;
    const imgs = {}, pixels = {}, states = {};
    const png = (canvas) => canvas.toDataURL("image/png").split(",")[1];
    const copy = (canvas) => {
      const c = document.createElement("canvas");
      c.width = canvas.width;
      c.height = canvas.height;
      c.getContext("2d").drawImage(canvas, 0, 0);
      return c;
    };
    const fromState = (phase) => {
      const state = resolveCelestialState({ timeMs: phase * 1e5, cycleMs: 1e5, viewport: { width: w, height: h } }), b = state[state.activeBody] || state.sun;
      const celestial = { ...base.light.celestial, ...b, body: state.activeBody, intensity: state.activeBody ? b.directGain : 0 };
      const ground = convertLightBetween({ x: b.xFrac * w, y: b.yFrac * h, intensity: celestial.intensity }, base.scenicViewport.transform, base.groundViewport.transform);
      return { ...base.light, celestial, ground, night01: state.night01, ambientMultiplier: state.ambientMultiplier, state };
    };
    const original = scene._setUniforms;
    const draw = (label, light, { debug = 0, trees = "all", transmission: transmission2 = null, waterKey = true } = {}) => {
      const f = Object.freeze({ ...base, frameId: ++id, light: Object.freeze(light) });
      scene._setUniforms = function(pr, fr) {
        original.call(this, pr, fr);
        pr.uniforms.uDebugMask.value = debug;
        if (transmission2 !== null && pr.uniforms.uSolarTransmission) pr.uniforms.uSolarTransmission.value = transmission2;
        for (const os of Object.values(pr.forest?.byBand || {})) for (const o of os) {
          const kind = o.material.vertexShader.includes("vNormal") ? "mesh" : "billboard";
          o.visible = trees === "all" || trees === kind;
        }
        if (trees === "none") for (const os of Object.values(pr.forest?.depthByBand || {})) for (const o of os) o.visible = false;
      };
      try {
        const scenic = document.createElement("canvas");
        scenic.width = base.scenicViewport.backingWidth;
        scenic.height = base.scenicViewport.backingHeight;
        const ctx = scenic.getContext("2d");
        for (const pass of ["far", "mid", "near"]) {
          const c = scene.renderPartition(f, pass, pres.viewId);
          if (c) ctx.drawImage(copy(c), 0, 0);
        }
        const water = p.stageGL.waterMaterial, testMaterial = water.clone();
        testMaterial.uniforms = { ...water.uniforms, uKeyColor: { value: waterKey ? p.uniforms.uLightColor.value.clone().multiplyScalar(0.3) : new T.Color(0, 0, 0) } };
        p.stageGL.water.material = testMaterial;
        let ground;
        try {
          ground = scene.renderGround(f, pres.viewId);
        } finally {
          p.stageGL.water.material = water;
          testMaterial.dispose();
        }
        const g = copy(ground.canvas);
        imgs[label] = png(scenic);
        imgs[label + "-ground"] = png(g);
        pixels[label] = ctx.getImageData(0, 0, scenic.width, scenic.height).data;
        pixels[label + "-ground"] = g.getContext("2d").getImageData(0, 0, g.width, g.height).data;
        return { pools: ground.stage.pools, width: g.width, height: g.height };
      } finally {
        scene._setUniforms = original;
      }
    };
    for (const [label, phase] of [["day", 0.21], ["dusk", 0.41], ["gap", 0.45], ["moon", 0.71]]) {
      states[label] = fromState(phase);
      draw(label, states[label]);
    }
    const stage = draw("pool-on", states.day);
    draw("pool-off", states.day, { waterKey: false });
    let poolChanged = 0;
    for (let i = 0; i < pixels["pool-on-ground"].length; i += 4) if (pixels["pool-on-ground"][i] !== pixels["pool-off-ground"][i] || pixels["pool-on-ground"][i + 1] !== pixels["pool-off-ground"][i + 1] || pixels["pool-on-ground"][i + 2] !== pixels["pool-off-ground"][i + 2]) poolChanged++;
    const delta = (a, b, accept = () => true) => {
      let count = 0, sum = 0, alpha = 0;
      const A = pixels[a], B = pixels[b];
      for (let i = 0; i < A.length; i += 4) {
        if (A[i + 3] !== B[i + 3]) alpha++;
        if (!accept(i)) continue;
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
        if (d) {
          count++;
          sum += d / 3;
        }
      }
      return { count, sum, alpha };
    };
    const sameGap = { ...states.gap, celestial: { ...states.gap.celestial, xFrac: 0.01, yFrac: 0.98, colorHex: "#ff0000" }, ground: { ...states.gap.ground, x: 0, y: 0 } };
    draw("gap-dormant", sameGap);
    const dormant = delta("gap", "gap-dormant"), dormantGround = delta("gap-ground", "gap-dormant-ground");
    draw("masks", states.day, { debug: 1, trees: "none" });
    draw("normals", states.day, { debug: 5, trees: "none" });
    draw("terrain-day", states.day, { trees: "none" });
    draw("terrain-off", { ...states.day, celestial: { ...states.day.celestial, body: null, intensity: 0 } }, { trees: "none" });
    draw("terrain-moon", { ...states.day, celestial: { ...states.day.celestial, body: "moon", intensity: 0.25, colorHex: "#c8d8ff" } }, { trees: "none" });
    const mask = pixels.masks, key = pixels.normals, stats = {};
    const luminance = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
    for (const [name, select] of Object.entries({ facing: (i) => mask[i] > 80 && mask[i + 1] < 80 && mask[i + 2] < 80 && key[i] > 80, shaded: (i) => mask[i] > 80 && mask[i + 1] < 80 && mask[i + 2] < 80 && key[i] < 30, snow: (i) => mask[i + 2] > 70 && mask[i + 1] < 80, water: (i) => mask[i] < 5 && mask[i + 1] > 100 && mask[i + 2] > 240, canopy: (i) => mask[i + 1] > 80 && mask[i + 2] < 80 })) {
      let n = 0, day = 0, off = 0, moon = 0, dayR = 0, dayB = 0, moonR = 0, moonB = 0, offR = 0, offB = 0;
      for (let i = 0; i < mask.length; i += 4) {
        if (mask[i + 3] < 250 || !select(i)) continue;
        n++;
        day += luminance(pixels["terrain-day"], i);
        off += luminance(pixels["terrain-off"], i);
        moon += luminance(pixels["terrain-moon"], i);
        dayR += pixels["terrain-day"][i];
        dayB += pixels["terrain-day"][i + 2];
        moonR += pixels["terrain-moon"][i];
        moonB += pixels["terrain-moon"][i + 2];
        offR += pixels["terrain-off"][i];
        offB += pixels["terrain-off"][i + 2];
      }
      stats[name] = { n, day: day / n, off: off / n, moon: moon / n, directDelta: (day - off) / n, dayRedBlue: dayR / dayB, moonRedBlue: moonR / moonB, solarDirectRedBlue: (dayR - offR) / (dayB - offB), lunarDirectRedBlue: (moonR - offR) / (moonB - offB) };
    }
    const transmission = {};
    for (const kind of ["mesh", "billboard"]) for (const body of ["day", "moon", "gap"]) {
      const name = kind + "-" + body;
      draw(name, states[body], { trees: kind });
      draw(name + "-off", states[body], { trees: kind, transmission: 0 });
      transmission[name] = delta(name, name + "-off");
    }
    const poolStates = {};
    for (const body of ["moon", "gap"]) {
      draw("pool-" + body, states[body]);
      draw("pool-" + body + "-off", states[body], { waterKey: false });
      poolStates[body] = delta("pool-" + body + "-ground", "pool-" + body + "-off-ground");
    }
    const legibility = {};
    for (const body of ["day", "dusk", "gap", "moon"]) {
      for (const part of ["", "-ground"]) {
        const image = pixels[body + part];
        let n = 0, luma = 0;
        for (let i = 0; i < image.length; i += 4) if (image[i + 3] > 250) { n++; luma += luminance(image, i); }
        legibility[body + part] = { n, luma: luma / n };
      }
    }
    const polyContains = (x, y, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (a.y > y !== b.y > y && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const vp = base.groundViewport, scaleX = stage.width / vp.logicalWidth, scaleY = stage.height / vp.logicalHeight;
    let escaped = 0, dryCorners = 0;
    const gp = pixels["pool-on-ground"], gn = pixels["pool-off-ground"];
    for (let i = 0; i < gp.length; i += 4) {
      if (gp[i] === gn[i] && gp[i + 1] === gn[i + 1] && gp[i + 2] === gn[i + 2]) continue;
      const x = (i / 4 % stage.width + 0.5) / scaleX, y = (Math.floor(i / 4 / stage.width) + 0.5) / scaleY;
      if (!stage.pools.some((p2) => [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => polyContains(x + dx / scaleX, y + dy / scaleY, p2.polygon))))) escaped++;
    }
    for (const pool of stage.pools) {
      const xs = pool.polygon.map((p2) => p2.x), ys = pool.polygon.map((p2) => p2.y);
      for (const x of [Math.min(...xs), Math.max(...xs)]) for (const y of [Math.min(...ys), Math.max(...ys)]) {
        if (polyContains(x, y, pool.polygon)) continue;
        const ix = Math.floor(x * scaleX), iy = Math.floor(y * scaleY), i = (iy * stage.width + ix) * 4;
        if (gp[i] === gn[i] && gp[i + 1] === gn[i + 1] && gp[i + 2] === gn[i + 2]) dryCorners++;
      }
    }
    for (let k = 0; k < 48; k++) draw("clip" + String(k).padStart(4, "0"), fromState(0.21 + 0.75 * k / 47));
    const gl = scene.renderer.getContext(), e = gl.getExtension("WEBGL_debug_renderer_info");
    return { imgs, states, stage, poolChanged, poolStates, legibility, escaped, dryCorners, dormant, dormantGround, stats, transmission, seed: app.songSeed, active: pres.active, view: pres.viewId, time: base.timeMs, forest: p.forest.counts, renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), overcommits: pres.residency?.stats?.overcommits || 0 };
  });
  for (const [name, png] of Object.entries(evidence.imgs)) await fs.writeFile(path.join(out, name + ".png"), Buffer.from(png, "base64"));
  delete evidence.imgs;
  report.evidence = evidence;
  report.errors = opened.errors;
  assert.equal(evidence.seed, 2917029651);
  assert.ok(evidence.active);
  assert.ok(evidence.poolChanged > 0, `actual pool direct key changed ${evidence.poolChanged} pixels`);
  assert.equal(evidence.escaped, 0);
  assert.ok(evidence.poolStates.moon.count > 0);
  assert.equal(evidence.poolStates.gap.count, 0);
  assert.ok(evidence.legibility.moon.luma < evidence.legibility.day.luma);
  assert.ok(evidence.legibility["moon-ground"].luma > 10);
  assert.ok(evidence.legibility.gap.luma > 10);
  assert.ok(evidence.dryCorners > 0);
  assert.equal(evidence.dormant.count, 0);
  assert.equal(evidence.dormantGround.count, 0);
  assert.ok(evidence.stats.facing.n > 100);
  assert.ok(evidence.stats.shaded.n > 1e3);
  assert.ok(evidence.stats.facing.directDelta > evidence.stats.shaded.directDelta * 4);
  for (const name of ["facing", "snow", "canopy", "water"]) {
    const m = evidence.stats[name];
    assert.ok(m.n > 100 && m.moon > m.off && m.day > m.moon);
    assert.ok(m.lunarDirectRedBlue < m.solarDirectRedBlue, name + " cooler moon contribution");
  }
  for (const kind of ["mesh", "billboard"]) {
    assert.ok(evidence.transmission[kind + "-day"].count > 0, kind + " solar transmission");
    assert.equal(evidence.transmission[kind + "-moon"].count, 0);
    assert.equal(evidence.transmission[kind + "-gap"].count, 0);
    assert.equal(evidence.transmission[kind + "-day"].alpha, 0);
  }
  assert.deepEqual(opened.errors, []);
  for (const [name, phase] of [["day", 0.21], ["dusk", 0.41], ["gap", 0.45], ["moon", 0.71]]) {
    await opened.page.evaluate(() => window.__SMW.beginBulkExport(window.__SMW.exportSize));
    await captureFrame(opened.page, 250);
    const cycle = await opened.page.evaluate(() => window.__SMW.sim.biomes._dayNightCycleMs), f = await captureFrame(opened.page, cycle * phase);
    assert.ok(Math.abs(f.clock.heardTimeMs - cycle * phase) < 17 || Math.abs(await opened.page.evaluate(() => window.__SMW.sim.heardTimeMs) - cycle * phase) < 17);
    await fs.writeFile(path.join(out, "presentation-" + name + ".png"), Buffer.from(f.png, "base64"));
  }
  console.log(JSON.stringify({ ...evidence, states: void 0, stage: void 0 }));
} catch (e) {
  report.error = String(e.stack);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
}
