// One default-off study: Mount Moran in the Jackson Lake terrain package.
// This is independent of Original/Depth presentation and adds no resources.
export const MORAN_VIEW_ID = 'teton-jackson-lake';

export function terrainShadingMode(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('terrainShading') === 'moran' ? 'moran' : 'off';
}

export function terrainShadingForView(mode, viewId) {
  return mode === 'moran' && viewId === MORAN_VIEW_ID ? 'moran' : 'off';
}

// Position is the package's source space: X east / Y up / Z south, metres.
// The centre is the published Mount Moran landmark in the verified manifest.
// It is NOT camera space or the musically displaced height. The shoulder
// stays above the forest and fades before neighbouring mountain subjects.
export const MORAN_SHADING_GLSL = /* glsl */`
  // MORAN_TERRAIN_SHADING
  float moranSubject(vec3 p) {
    vec2 q = (p.xz - vec2(-6128.6, -558.4)) / vec2(2600.0, 2400.0);
    return (1.0 - smoothstep(.65, 1.0, length(q))) * smoothstep(3000.0, 3250.0, p.y);
  }
  // Preserve both endpoints of the existing snow mask. Only its mixed
  // boundary changes: concavities keep snow, convex rock ribs interrupt it.
  // A continuous footprint widens the transition when it is unresolved;
  // there is no snapped threshold, screen-space pattern or time input.
  float moranSnow(float snow, float curvature, float footprint) {
    float edge = clamp(snow + .06 * curvature * (4.0 * snow * (1.0 - snow)), 0.0, 1.0);
    float aa = min(.08, .5 * footprint);
    return smoothstep(.08 - aa, .92 + aa, edge);
  }
`;

function insertOnce(source, anchor, replacement) {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + anchor.length) >= 0)
    throw new Error('Moran shading anchor missing or ambiguous');
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

/** Called only for the explicit experiment. OFF retains the original text. */
export function moranTerrainFragment(source) {
  let shader = insertOnce(source, '  void main() {', `${MORAN_SHADING_GLSL}\n  void main() {`);
  const mask = '      // Ground between: meadow on gentle open slopes, soil/scree steeper,';
  shader = insertOnce(shader, mask, /* glsl */`
      float moranWeight = moranSubject(vWorld) * (water ? 0.0 : 1.0 - ice.y)
        * (1.0 - clamp(forest / max(rForestDensity, .0001), 0.0, 1.0));
      float moranCurvature = curv;
      // Existing full-grid curvature, filtered to an 80 m neighbourhood.
      // Explicit LOD is fixed on the land, independent of camera distance.
      if (moranWeight > 0.0) moranCurvature = (textureLod(uSurface, uv, 2.0).b - .5) * 2.0;
      float snowFootprint = fwidth(snow);
      snow = mix(snow, moranSnow(snow, moranCurvature, snowFootprint), moranWeight);
${mask}`);
  const rock = '      vec3 forestRay = normalize(cameraPosition - vRenderedWorld);';
  shader = insertOnce(shader, rock, /* glsl */`
      // Let the actual slope normal carry the face lighting. Local tones
      // follow real concave/convex relief instead of unrelated tile height.
      vec3 moranRock = mix(pRockShade, pRockLit, clamp(.62 - .20 * moranCurvature, .20, .82));
      moranRock = mix(moranRock, pRockWarm, .04 * rStrata);
      rockCol = mix(rockCol, moranRock, .60 * moranWeight);
${rock}`);
  const snow = '      albedo = mix(albedo, snowCol, snow);';
  shader = insertOnce(shader, snow, /* glsl */`
      snowCol = mix(snowCol, mix(pSnowShade, pSnow, .85), .85 * moranWeight);
${snow}`);
  const detail = '      nShade = normalize(n + detail);';
  shader = insertOnce(shader, detail, /* glsl */`
      // Keep a little material relief at real ribs; broad faces stay quiet.
      detail *= 1.0 - moranWeight * (.58 - .30 * abs(moranCurvature));
${detail}`);
  return shader;
}
