import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radialMesh, mergeMeshes } from '../src/render/meshes.js';
import { computeRestLengths, applyTransform, drawMeshEdges, drawMeshPart } from '../src/render/MeshDrawer.js';

function mockCtx() {
  const calls = { stroke: 0, moveTo: [], lineTo: [] };
  return {
    calls,
    strokeStyle: null,
    lineWidth: null,
    beginPath() {},
    moveTo(x, y) { calls.moveTo.push([x, y]); },
    lineTo(x, y) { calls.lineTo.push([x, y]); },
    stroke() { calls.stroke++; },
  };
}

test('radialMesh produces one center + n rim vertices and 2n edges', () => {
  const m = radialMesh(10, 10, 8);
  assert.equal(m.vertices.length, 9);
  assert.equal(m.edges.length, 16); // 8 spokes + 8 rim
});

test('mergeMeshes offsets edge indices so each sub-mesh stays internally consistent', () => {
  const a = radialMesh(5, 5, 4);
  const b = radialMesh(3, 3, 3);
  const { mesh, offsets } = mergeMeshes([a, b]);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], a.vertices.length);
  assert.equal(mesh.vertices.length, a.vertices.length + b.vertices.length);
  // every edge index must reference a valid merged vertex
  for (const [i, j] of mesh.edges) {
    assert.ok(i >= 0 && i < mesh.vertices.length);
    assert.ok(j >= 0 && j < mesh.vertices.length);
  }
});

test('computeRestLengths matches direct distance calculation', () => {
  const mesh = { vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }], edges: [[0, 1]] };
  const lengths = computeRestLengths(mesh);
  assert.equal(lengths[0], 5);
});

test('applyTransform: pure translation moves a point by (tx,ty)', () => {
  const p = applyTransform({ x: 1, y: 2 }, { tx: 10, ty: 20 });
  assert.equal(p.x, 11);
  assert.equal(p.y, 22);
});

test('applyTransform: scale is applied before rotation/translation (matches canvas composition order)', () => {
  // Scale x2 then rotate 90deg (pi/2): (1,0) -> scaled (2,0) -> rotated (0,2) -> translated.
  const p = applyTransform({ x: 1, y: 0 }, { tx: 5, ty: 5, rot: Math.PI / 2, scaleX: 2, scaleY: 2 });
  assert.ok(Math.abs(p.x - 5) < 1e-9);
  assert.ok(Math.abs(p.y - 7) < 1e-9);
});

test('applyTransform: rigid rotation preserves edge length (no false deformation glow from rotation alone)', () => {
  const mesh = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);
  const pts = mesh.vertices.map((v) => applyTransform(v, { rot: 0.7 }));
  const len = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  assert.ok(Math.abs(len - rest[0]) < 1e-9);
});

test('drawMeshEdges strokes exactly one segment per edge when there is no deformation glow', () => {
  const mesh = radialMesh(10, 10, 6);
  const rest = computeRestLengths(mesh);
  const points = mesh.vertices; // identity transform -> zero deformation
  const ctx = mockCtx();
  drawMeshEdges(ctx, mesh, rest, points, 40);
  assert.equal(ctx.calls.stroke, mesh.edges.length);
});

test('drawMeshEdges adds an extra glow stroke pass for edges that have visibly deformed', () => {
  const mesh = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh); // 10
  const stretched = [{ x: 0, y: 0 }, { x: 30, y: 0 }]; // 3x length -> big deformation
  const ctx = mockCtx();
  drawMeshEdges(ctx, mesh, rest, stretched, 40);
  assert.equal(ctx.calls.stroke, 2); // glow pass + main pass
});

test('drawMeshPart end-to-end: a squashed mesh (scaleY<1) produces visible per-edge deformation', () => {
  const mesh = radialMesh(20, 20, 8);
  const rest = computeRestLengths(mesh);
  const ctx = mockCtx();
  const points = drawMeshPart(ctx, mesh, rest, { tx: 100, ty: 100, scaleX: 1.3, scaleY: 0.7 }, 40);
  assert.equal(points.length, mesh.vertices.length);
  assert.ok(ctx.calls.stroke > mesh.edges.length, 'squash/stretch should trigger at least one glow pass');
});

// --- Movement VII: rim light (drawMeshEdges `light` option) ---

function mockCtxWithStrokeStyles() {
  const ctx = mockCtx();
  ctx.strokeStyles = [];
  let _style = null;
  Object.defineProperty(ctx, 'strokeStyle', {
    get() { return _style; },
    set(v) { _style = v; ctx.strokeStyles.push(v); },
  });
  return ctx;
}

function lightnessOf(hsla) {
  return Number(hsla.match(/,\s*([\d.]+)%\s*,\s*[\d.]+\)/)[1]);
}

test('drawMeshEdges: omitting `light` produces identical output to before this feature existed', () => {
  const mesh = radialMesh(10, 10, 6);
  const rest = computeRestLengths(mesh);
  const ctxNoLight = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxNoLight, mesh, rest, mesh.vertices, 40);
  const ctxNullLight = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxNullLight, mesh, rest, mesh.vertices, 40, { light: null });
  assert.deepEqual(ctxNullLight.strokeStyles, ctxNoLight.strokeStyles);
});

test('drawMeshEdges: an edge facing the light reads brighter than the same edge with the light mirrored away', () => {
  const mesh = { vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);

  const lightAbove = { x: 0, y: -200, colorHex: '#ffcc66', intensity: 1 };
  const ctxLit = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxLit, mesh, rest, mesh.vertices, 40, { light: lightAbove, rimAmount: 1 });

  const lightBelow = { x: 0, y: 200, colorHex: '#ffcc66', intensity: 1 };
  const ctxUnlit = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxUnlit, mesh, rest, mesh.vertices, 40, { light: lightBelow, rimAmount: 1 });

  const litLightness = lightnessOf(ctxLit.strokeStyles.at(-1));
  const unlitLightness = lightnessOf(ctxUnlit.strokeStyles.at(-1));
  assert.ok(litLightness > unlitLightness, `expected lit=${litLightness} > unlit=${unlitLightness}`);
});

test('drawMeshEdges: `lights` (secondary sources) combine with `light` (the celestial) rather than replacing it', () => {
  const mesh = { vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);

  const ctxCelestialOnly = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxCelestialOnly, mesh, rest, mesh.vertices, 40, {
    light: { x: 0, y: -200, colorHex: '#ffcc66', intensity: 1 }, rimAmount: 1,
  });

  const ctxBoth = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxBoth, mesh, rest, mesh.vertices, 40, {
    light: { x: 0, y: -200, colorHex: '#ffcc66', intensity: 1 },
    lights: [{ x: 0, y: -5, hueDeg: 40, intensity: 1, radius: 50 }], // very close, small local light, same hue -> pure additive lightness check
    rimAmount: 1,
  });

  const litOnly = lightnessOf(ctxCelestialOnly.strokeStyles.at(-1));
  const litBoth = lightnessOf(ctxBoth.strokeStyles.at(-1));
  assert.ok(litBoth > litOnly, `adding a nearby secondary light should brighten further: only=${litOnly} both=${litBoth}`);
});

test('drawMeshEdges: a secondary light outside its radius contributes nothing', () => {
  const mesh = { vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);

  const ctxNoLight = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxNoLight, mesh, rest, mesh.vertices, 40);

  const ctxFarLight = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxFarLight, mesh, rest, mesh.vertices, 40, {
    lights: [{ x: 0, y: -5000, hueDeg: 40, intensity: 1, radius: 50 }], // way outside its own radius
    rimAmount: 1,
  });

  assert.deepEqual(ctxFarLight.strokeStyles, ctxNoLight.strokeStyles);
});

test('drawMeshEdges: the single strongest light\'s hue wins the tint, not an average of every source in range', () => {
  const mesh = { vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);

  const ctxStrongOnly = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxStrongOnly, mesh, rest, mesh.vertices, 40, {
    lights: [{ x: 0, y: -20, hueDeg: 300, intensity: 1, radius: 500 }],
    rimAmount: 1,
  });
  const ctxStrongPlusWeak = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxStrongPlusWeak, mesh, rest, mesh.vertices, 40, {
    lights: [
      { x: 0, y: -20, hueDeg: 300, intensity: 1, radius: 500 }, // dominant
      { x: 0, y: -20, hueDeg: 100, intensity: 0.01, radius: 500 }, // negligible
    ],
    rimAmount: 1,
  });

  const hueOf = (s) => Number(s.match(/^hsla\((\d+)/)[1]);
  assert.equal(hueOf(ctxStrongPlusWeak.strokeStyles.at(-1)), hueOf(ctxStrongOnly.strokeStyles.at(-1)));
});

test('drawMeshEdges: `lights` alone (no `light`) still lights an edge, same math path as the single-`light` param', () => {
  const mesh = { vertices: [{ x: -10, y: 0 }, { x: 10, y: 0 }], edges: [[0, 1]] };
  const rest = computeRestLengths(mesh);

  const ctxViaLight = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxViaLight, mesh, rest, mesh.vertices, 40, {
    light: { x: 0, y: -200, colorHex: '#ffcc66', intensity: 1, radius: Infinity }, rimAmount: 1,
  });
  const ctxViaLights = mockCtxWithStrokeStyles();
  drawMeshEdges(ctxViaLights, mesh, rest, mesh.vertices, 40, {
    lights: [{ x: 0, y: -200, colorHex: '#ffcc66', intensity: 1, radius: Infinity }], rimAmount: 1,
  });

  assert.deepEqual(ctxViaLights.strokeStyles, ctxViaLight.strokeStyles);
});

// --- displaceMeshRadial (resonance geometry) ---
import { displaceMeshRadial } from '../src/render/MeshDrawer.js';
import { ModalRing } from '../src/render/oscillators.js';

test('displaceMeshRadial returns the mesh untouched when the field is silent', () => {
  const mesh = radialMesh(10, 10, 6);
  const ring = new ModalRing({ seed: 3 }); // never excited -> energy 0
  assert.equal(displaceMeshRadial(mesh, 0, 0, ring), mesh);
  assert.equal(displaceMeshRadial(mesh, 0, 0, null), mesh);
});

test('displaceMeshRadial moves rim vertices radially but never the hub', () => {
  const mesh = radialMesh(10, 10, 6, 0, -20);
  const ring = new ModalRing({ seed: 3 });
  ring.excite(4);
  const out = displaceMeshRadial(mesh, 0, -20, ring);
  assert.notEqual(out, mesh);

  // Hub (vertex 0, at the center) must be untouched.
  assert.deepEqual(out.vertices[0], mesh.vertices[0]);

  let anyMoved = false;
  for (let i = 1; i < mesh.vertices.length; i++) {
    const orig = mesh.vertices[i], moved = out.vertices[i];
    // Displacement must be purely radial: the angle from the hub is preserved.
    const angOrig = Math.atan2(orig.y + 20, orig.x);
    const angMoved = Math.atan2(moved.y + 20, moved.x);
    assert.ok(Math.abs(angOrig - angMoved) < 1e-9, 'vertex angle about the hub must not change');
    if (Math.hypot(moved.x - orig.x, moved.y - orig.y) > 0.01) anyMoved = true;
  }
  assert.ok(anyMoved, 'an excited field should visibly displace at least one rim vertex');
});

test('displaceMeshRadial keeps displacement bounded by the field energy', () => {
  const mesh = radialMesh(12, 12, 8);
  const ring = new ModalRing({ seed: 3 });
  ring.excite(6);
  const out = displaceMeshRadial(mesh, 0, 0, ring);
  for (let i = 1; i < mesh.vertices.length; i++) {
    const orig = mesh.vertices[i], moved = out.vertices[i];
    const shift = Math.hypot(moved.x - orig.x, moved.y - orig.y);
    assert.ok(shift <= ring.energy + 1e-9);
  }
});
