// The stage-resolution menu lives in index.html and the presets it names
// live in StagePresets.js -- two files with no compile-time link between
// them. An option whose value no preset answers to silently falls back to
// 1080p, which on the 8-bit entry would mean the one setting a struggling
// device reaches for quietly doing the opposite of what it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STAGE_PRESETS, AUTO_PRESET, RETRO_PRESET, PALETTE_PRESET, DEFAULT_STAGE_PRESET,
  resolveStagePreset, stageDims, isAutoPreset, isRetroPreset, isPalettePreset,
  displayLimitedSize, autoStageSize, shouldSuggestLandscape,
} from '../src/render/StagePresets.js';

const indexHtml = readFileSync(
  fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8',
);

function stageResOptionValues() {
  const select = indexHtml.match(/<select id="stageRes"[\s\S]*?<\/select>/);
  assert.ok(select, 'index.html should still have a #stageRes select');
  return [...select[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

test('every option in the stage-resolution menu resolves to a real preset', () => {
  const values = stageResOptionValues();
  assert.ok(values.length >= 8, `expected the full preset menu, got ${values.length}`);
  for (const v of values) {
    const preset = resolveStagePreset(v);
    assert.notEqual(preset, null, `option value "${v}" resolves to no preset`);
    assert.ok(stageDims(preset).w > 0, `option "${v}" has no dimensions`);
  }
});

test('Auto is the default stage mode exposed by the menu', () => {
  const select = indexHtml.match(/<select id="stageRes"[\s\S]*?<\/select>/);
  assert.ok(select);
  assert.match(select[0], /<option value="auto" selected>Auto<\/option>/);
  assert.equal(DEFAULT_STAGE_PRESET, AUTO_PRESET);
  assert.equal(resolveStagePreset('auto'), AUTO_PRESET);
  assert.equal(isAutoPreset(AUTO_PRESET), true);
  assert.equal(isAutoPreset(1080), false);
});

test('legacy presets remain parseable while the menu uses separate Look controls', () => {
  const values = stageResOptionValues();
  assert.equal(values.includes(RETRO_PRESET), false);
  assert.match(indexHtml, /id="display-look"/);
  assert.equal(values.includes(PALETTE_PRESET), false);
  const retro = Object.keys(STAGE_PRESETS).filter((k) => STAGE_PRESETS[k].retro).sort();
  assert.deepEqual(retro, [RETRO_PRESET, PALETTE_PRESET].sort());
  assert.equal(isRetroPreset(RETRO_PRESET), true);
  assert.equal(isRetroPreset(PALETTE_PRESET), true);
  assert.equal(isRetroPreset(DEFAULT_STAGE_PRESET), false);
  assert.equal(isRetroPreset(144), false);
});

test('only the intensive variant asks for the palette pass', () => {
  // The split is the point: a weak device must be able to buy the cheap
  // mode without also buying a per-frame readback it cannot afford.
  assert.equal(isPalettePreset(PALETTE_PRESET), true);
  assert.equal(isPalettePreset(RETRO_PRESET), false);
  assert.equal(isPalettePreset(DEFAULT_STAGE_PRESET), false);
  assert.equal(isPalettePreset('nonsense'), false);
  const palette = Object.keys(STAGE_PRESETS).filter((k) => STAGE_PRESETS[k].palette);
  assert.deepEqual(palette, [PALETTE_PRESET]);
});

test('both 8-bit modes render into the same small buffer', () => {
  // Intensive costs more per frame, not more pixels -- it must not quietly
  // raise the resolution as well, or it would be paying twice.
  assert.deepEqual(
    { w: stageDims(PALETTE_PRESET).w, h: stageDims(PALETTE_PRESET).h },
    { w: stageDims(RETRO_PRESET).w, h: stageDims(RETRO_PRESET).h },
  );
});

test('8-bit is a genuinely small buffer, not a relabelled full-size one', () => {
  const retro = stageDims(RETRO_PRESET);
  const def = stageDims(DEFAULT_STAGE_PRESET);
  assert.equal(retro.w, 320);
  assert.equal(retro.h, 180);
  // The whole claim of the mode: an order-of-magnitude cut in the pixels
  // every fill/composite/blit in the frame has to touch.
  assert.ok(
    (retro.w * retro.h) * 20 < def.w * def.h,
    `8-bit (${retro.w}×${retro.h}) should be far cheaper than the default (${def.w}×${def.h})`,
  );
});

test('8-bit upscales by whole pixels on the two commonest stage sizes', () => {
  // Why 320×180 rather than something smaller: a non-integer ratio makes
  // neighbouring source pixels land on different numbers of screen pixels,
  // which shimmers as the world scrolls -- the opposite of the crisp look
  // the mode is chosen for.
  const { w, h } = stageDims(RETRO_PRESET);
  for (const [dw, dh] of [[1280, 720], [1920, 1080]]) {
    assert.equal(dw % w, 0, `${dw} is not a whole multiple of ${w}`);
    assert.equal(dh % h, 0, `${dh} is not a whole multiple of ${h}`);
    assert.equal(dw / w, dh / h, 'horizontal and vertical scale must match');
  }
});

test('resolveStagePreset accepts what a select, localStorage, or a URL actually hands it', () => {
  assert.equal(resolveStagePreset('8bit'), RETRO_PRESET);
  assert.equal(resolveStagePreset(' 8BIT '), RETRO_PRESET, 'case/whitespace tolerant');
  assert.equal(resolveStagePreset('8bit-intensive'), PALETTE_PRESET);
  assert.equal(resolveStagePreset(' 8BIT-Intensive '), PALETTE_PRESET);
  assert.equal(resolveStagePreset('1080'), 1080, 'a select hands over strings');
  assert.equal(resolveStagePreset(1080), 1080, 'a number works too');
  assert.equal(resolveStagePreset('144'), 144);
});

test('resolveStagePreset rejects anything that names no preset', () => {
  for (const bad of [null, undefined, '', '  ', 'nonsense', '999', 999, '8', 8, NaN, {}]) {
    assert.equal(resolveStagePreset(bad), null, `${String(bad)} should not resolve`);
  }
});

test('stageDims falls back to the default rather than throwing on a bad key', () => {
  // A stored value from a future/older build must never break boot.
  assert.deepEqual(stageDims('nonsense'), STAGE_PRESETS[DEFAULT_STAGE_PRESET]);
  assert.deepEqual(stageDims(undefined), STAGE_PRESETS[DEFAULT_STAGE_PRESET]);
  assert.equal(isRetroPreset('nonsense'), false);
});

// --- displayLimitedSize: never rasterize pixels the display can't show ----

test('displayLimitedSize: a desktop showing the stage at full size keeps its preset', () => {
  // 1080p preset, 1920x1080 CSS box at dpr 1 -- displayed 1:1, nothing to cut.
  const r = displayLimitedSize(1920, 1080, 1920, 1080, 1);
  assert.deepEqual(r, { w: 1920, h: 1080 });
});

test('displayLimitedSize: never returns more than the preset, however big the display', () => {
  // A 4K box at dpr 2 could "afford" far more than 1080p; the preset is a
  // ceiling, so asking for a bigger buffer than the user chose is wrong.
  const r = displayLimitedSize(1920, 1080, 3840, 2160, 2);
  assert.deepEqual(r, { w: 1920, h: 1080 });
});

test('displayLimitedSize: a portrait phone cuts the buffer hard (the letterboxed strip)', () => {
  // 390x844 CSS at dpr 3: object-fit contain puts the 16:9 stage in a
  // 390x219 strip, so even at the 2x cap that is 780px wide, not 1920.
  const r = displayLimitedSize(1920, 1080, 390, 844, 3);
  assert.equal(r.w, 780);
  assert.equal(r.h, Math.round(780 * 1080 / 1920));
  assert.ok(r.w * r.h < 1920 * 1080 * 0.2, 'should be a >80% cut in pixels');
});

test('displayLimitedSize: a landscape phone still cuts, via the dpr cap', () => {
  // 844x390 CSS at dpr 3 -- the panel really is ~2532px wide, but past the
  // 2x cap there is nothing left to see on a phone-sized 16:9 stage.
  const r = displayLimitedSize(1920, 1080, 844, 390, 3);
  assert.ok(r.w < 1920, 'must not honour the full 3x panel density');
  assert.ok(r.w * r.h < 1920 * 1080 * 0.75, 'should be a meaningful cut');
});

test('displayLimitedSize: preserves the preset aspect ratio exactly', () => {
  for (const [cssW, cssH, dpr] of [[390, 844, 3], [844, 390, 3], [1000, 700, 1.5]]) {
    const r = displayLimitedSize(1920, 1080, cssW, cssH, dpr);
    assert.ok(Math.abs((r.w / r.h) - (1920 / 1080)) < 0.01, `aspect drifted at ${cssW}x${cssH}`);
  }
});

test('displayLimitedSize: an unmeasured box (pre-layout) falls back to the preset', () => {
  assert.deepEqual(displayLimitedSize(1920, 1080, 0, 0, 2), { w: 1920, h: 1080 });
  assert.deepEqual(displayLimitedSize(1920, 1080, 800, 600, 0), { w: 1920, h: 1080 });
});

test('displayLimitedSize: leaves the already-tiny 8-bit buffer alone', () => {
  // 320x180 is below anything a display would limit it to, so the mode keeps
  // the exact buffer it exists to pin.
  assert.deepEqual(displayLimitedSize(320, 180, 844, 390, 3), { w: 320, h: 180 });
});

test('autoStageSize matches visible desktop demand without exceeding 1440p', () => {
  assert.deepEqual(autoStageSize(1920, 1080, 1, false), { w: 1920, h: 1080 });
  assert.deepEqual(autoStageSize(3840, 2160, 1, false), { w: 2560, h: 1440 });
});

test('autoStageSize treats a coarse-pointer DPR as density, not useful detail', () => {
  const portrait = autoStageSize(390, 844, 3, true);
  assert.deepEqual(portrait, { w: 585, h: 329 });
  const landscape = autoStageSize(1280, 720, 3, true);
  assert.equal(landscape.h, 720, 'touch Auto quality is capped at 720p');
  assert.equal(landscape.w, 1280);
});

test('autoStageSize preserves a usable fallback before layout is measured', () => {
  assert.deepEqual(autoStageSize(0, 0, 3, true), { w: 1920, h: 1080 });
});

test('portrait guidance reaches tall phones but not tablets or landscape screens', () => {
  assert.equal(shouldSuggestLandscape(390, 844), true, 'a tall modern phone needs the hint');
  assert.equal(shouldSuggestLandscape(540, 960), true, 'the old 820px height cutoff must stay gone');
  assert.equal(shouldSuggestLandscape(844, 390), false, 'already landscape');
  assert.equal(shouldSuggestLandscape(768, 1024), false, 'a portrait tablet has enough stage height');
});
