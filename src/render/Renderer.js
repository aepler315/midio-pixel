import { CanvasBuffers } from './CanvasResidency.js';
import { drawPixelGlow, pixelHeatOffset } from './PixelEffects.js';
// Canvas 2D compositor. Draws sky -> parallax biome layers -> ground ->
// world FX -> foreground veil -> post effects -> HUD. Layers are added
// incrementally as later stages land; each stage guards on the subsystem's
// presence so this file grows additively.
import { ComposerStrip } from './ComposerStrip.js';
import { drawRangeCaption } from '../ui/RangeCaption.js';
import { drawPixelCaption } from '../ui/PixelCaption.js';
import { drawTitleCard, drawPixelTitleCard } from '../ui/TitleCard.js';
import { clamp01 } from '../utils/math.js';
import { LerpCache } from '../utils/color.js';
import { spectralFamily } from './spectral.js';
import { landscapeFinish } from './FilmFinish.js';
import { salienceBudgetFor } from './SalienceBudget.js';
import { styleDials } from './VisualStyle.js';
import { GroundResponse, recentConductorHits } from '../world/alpine/GroundResponse.js';
import { viewportState } from '../world/alpine/RangeFrame.js';
import { composedNarrativeEdge } from './NarrativeDraw.js';
import { narrativePressure } from '../world/alpine/RangeNarrative.js';
import { highlightCandidatesFor, highlightFrameState, highlightVisible } from './HighlightReel.js';

// Reserve margin (logical stage px) around the visible frame that camera
// shake/drift/sway/roll are free to pan into without ever exposing raw,
// undrawn canvas. Covers the worst realistic combined displacement: a
// maxed impact shake (~10px) + full calm drift (26px) + full beat sway
// (12px) plus a few px of corner reveal from the small impact roll, with
// headroom to spare. See Renderer.draw's stageW/stageH derivation.
export const SHAKE_MARGIN_PX = 64;

// Bloom: a final light-bleed pass over the fully composed frame -- the
// additive glow language used everywhere (character underlays, kick
// ignition, the celestial, aurora, drop shockwaves) currently stops hard
// at each source's own edges instead of bleeding into the frame the way a
// real luminous source does. Downsampled (cheap blur for free) + a
// self-multiply threshold (keeps near-white sources, crushes midtones) +
// a real blur, screened back at a restrained strength driven by the music.
const BLOOM_DOWNSCALE_BASE = 3;  // offscreen buffers render at 1/N resolution
const BLOOM_BLUR_PX = 4;         // keep highlight spill close to its source
const BLOOM_THRESHOLD_PASSES = 2; // self-multiply passes: c^(2^passes)

/** Downscale factor for an offscreen post-fx buffer, keyed off the real
 *  backing-store width -- the bigger the store, the more a full-resolution
 *  copy costs, so the buffer shrinks to match. */
function postFxDownscale(width) {
  return width > 2560 ? 5 : width > 1920 ? 4 : BLOOM_DOWNSCALE_BASE;
}
// Bloom supports the scene rather than becoming a white veil on drops:
// the resting base and the reactive swell both sit under this much lower
// overall ceiling.
export const BLOOM_BASE = 0.02;
const BLOOM_MAX = 0.24;

// Heat distortion: a UV-warp lens over the fully composed frame for an
// active wildfire (or EMBER's own ambient ember-haze). Grid cells are
// screen px at 1x; padded so shifted neighbors still overlap and no seams
// open up between them.
const HEAT_GRID_PX = 56;
const HEAT_PAD_PX = 6;
const HEAT_AMBIENT_MAX_PX = 1.4; // wildfire/ember ambient sway peak displacement
// EMBER's ambient sky-haze is a mood, not a wildfire's full blast -- capped
// well below what an active FireDirector strike (intensity01 up to 1) gets.
const EMBER_AMBIENT_LEVEL = 0.5;

// Film finish: breathing vignette + very-low-alpha color grade (see FilmFinish.js).
const FILM_GRADE_COOL = '#1a7a96';       // deeper ocean teal -- calm / space push
const FILM_GRADE_WARM = '#e88a55';       // muted amber -- hot/high-budget push
const FILM_GRADE_SPACE = '#2a2060';      // indigo space wash layered in rendered style
// Both floors below used to sit high enough that the grade/vignette were
// never really OFF -- a full-surge drop (vignetteDepth -> 0) still carried
// 22% of the calm frame's edge darkness, and the coolest/neutral grade
// still washed every pixel through soft-light. A frame that's always at
// least a little graded and a little vignetted can't sell the moment it's
// neither -- cut close to zero so an actually open, ungraded frame reads
// as exactly that, and the calm-driven build back up to VIGNETTE_MAX_ALPHA
// has real distance to travel.
const FILM_GRADE_ALPHA_BASE = 0.012;     // floor alpha for the grade wash -- a finish, not a filter
const FILM_GRADE_ALPHA_RANGE = 0.03;     // extra alpha the further warmth sits from neutral
// Landscape's mood hue (MoodScore.js) is the scene's colour, not a finish:
// up to this much of each pixel's hue and saturation follows the music.
const MOOD_GRADE_MAX = 0.55;
const VIGNETTE_MIN_ALPHA = 0.02;        // edge darkness at maximum openness (full hype/drop)
const VIGNETTE_MAX_ALPHA = 0.54;         // edge darkness at maximum depth (fully calm) -- deeper, moodier frame
const VIGNETTE_ONSET_MIN = 0.34;         // onset fraction (of corner radius) at max depth -- a deep iris
const VIGNETTE_ONSET_MAX = 0.62;         // onset fraction at min depth -- only the outer ring ever darkens

/** Hidden canvas chrome must not consume pointer taps. The optional WebGL
 * wrapper uses the same canvas compositor and visibility switch. */
export function hitTestComposerStrip(renderer, x, y, stage) {
  if (!renderer?.hudInFrame) return null;
  const canvasRenderer = renderer.canvasRenderer || renderer;
  if (canvasRenderer.rangeListeningActive) return null;
  return canvasRenderer.composer?.hitTest(x, y, stage) || null;
}

/** The glacier's physical 3D rail supplies the coasting motion. Fade out
 * frame-wide sway as its view arrives, retaining camera.zoom for cast fit. */
function glacialViewWeight(presentation, biomes) {
  if (!presentation?.enabled || !presentation.captionViewFor) return 0;
  const blend = biomes?.currentBlend || {};
  const name = (p) => typeof p === 'string' ? p : p?.name;
  const from = name(blend.from) ?? biomes?.sections?.[0]?.profile?.name;
  const to = name(blend.to) ?? from;
  const t = clamp01(blend.t ?? 1);
  const fromIce = !!presentation.captionViewFor(from)?.glacier;
  const toIce = !!presentation.captionViewFor(to)?.glacier;
  return (fromIce ? 1 - t : 0) + (toIce ? t : 0);
}

/** Range v2 views fly a real 3D camera (RangeCamera.js) whose moves are
 *  authored to the song's structure. Frame-wide beat sway and calm drift on
 *  top of that read as an accidental, wobbling camera, so they fade out as
 *  the view arrives. */
function rangeViewWeight(presentation) {
  if (!presentation?.enabled || !presentation.active) return 0;
  const a = Number(presentation.arrival);
  return Number.isFinite(a) ? clamp01(a) : 1;
}

/** The zoom the stage is widened by. CameraDirector's universe pull-back
 *  (`camera.universeDip`, the dip it subtracted from `zoom` this frame) is
 *  added back as a Range view arrives: Range views fly their own lens, and
 *  the pull-back would cancel part of its push-in. 0 or missing
 *  universeDip leaves `camera.zoom` as it is. */
export function stageZoomFor(camera, presentation) {
  return camera.zoom + (camera.universeDip || 0) * rangeViewWeight(presentation);
}

export function presentationCamera(camera, presentation, biomes) {
  const ice = glacialViewWeight(presentation, biomes);
  const range = rangeViewWeight(presentation);
  const weight = Math.max(ice, range);
  if (!weight) return camera;
  const gain = 1 - 0.92 * weight;
  // Ambient sway and drift go entirely on Range views; impact shake and roll
  // keep a trace (8%) so a landing still registers.
  const ax = (camera.ambientX || 0) * range, ay = (camera.ambientY || 0) * range;
  return { ...camera, shakeX: (camera.shakeX - ax) * gain, shakeY: (camera.shakeY - ay) * gain, roll: (camera.roll || 0) * gain };
}

/** Put the pilot cast on a narrow bottom ledge. This only changes the shared
 * drawing transform: physics, pool geometry and reflection contacts keep
 * their original coordinates and therefore move together. */
export function groundPresentationOffsetY(presentation, biomes, height, supportY) {
  const weight = glacialViewWeight(presentation, biomes);
  if (!weight || !Number.isFinite(supportY)) return 0;
  return weight * Math.max(0, Math.min(height * 0.22, height * 0.915 - supportY + SHAKE_MARGIN_PX));
}

/** Fit the authored stage without rounding its axes independently. Backing
 * buffers may round their sizes; the final Canvas mapping stays uniform. */
export function fitStageOutput(width, height, outputWidth, outputHeight, cover = false) {
  const scale = (cover ? Math.max : Math.min)(outputWidth / width, outputHeight / height);
  const fittedWidth = width * scale, fittedHeight = height * scale;
  return { scale, x: (outputWidth - fittedWidth) / 2, y: (outputHeight - fittedHeight) / 2,
    width: fittedWidth, height: fittedHeight };
}

export function applyFixedGroundTransform(ctx, { sx, sy, width, height, camera, offsetY = 0, outputX = 0, outputY = 0 }) {
  const cx = width / 2 + SHAKE_MARGIN_PX, cy = height / 2 + SHAKE_MARGIN_PX;
  ctx.setTransform(sx, 0, 0, sy, outputX, outputY);
  ctx.translate(cx, cy);
  ctx.rotate(camera.roll || 0);
  ctx.translate(-cx + camera.shakeX - SHAKE_MARGIN_PX,
    -cy + camera.shakeY - SHAKE_MARGIN_PX + offsetY);
}

export class Renderer {
  constructor(canvas) {
    this._postBuffers = new CanvasBuffers();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.composer = null; // lazy: needs the conductor's timeline at first draw
    // The picture opens clean; F3 can reveal the timeline for section debug.
    this.hudInFrame = false;
    // Renderer-owned (not sim.biomes.lerpCache) so the film finish still
    // works if sim.biomes were ever null (the fallback-sky branch below).
    this._filmLerpCache = new LerpCache();
    this._groundResponse = new GroundResponse();
    // Range v2 wet reflections (Task 12); evidence turns them off to diff.
    this.reflectionsEnabled = true;
    this.reflectionStats = null;
    // Range v2 presentation (RangePresentation), set by main.js; null means
    // the Range draws with its legacy painters.
    this.rangePresentation = null;
    // Completed stage draws. Evidence tools compare it across one capture
    // to prove a fixture frame was painted exactly once at its time.
    this.drawCount = 0;
  }

  dispose() { this.discardFrameCaptures(); this._postBuffers.dispose(); this._groundResponse.dispose(); }

  _captureSceneFrame(canvas, capture) {
    if (this.deferSceneCaptures) (this._frameCaptures ||= []).push(capture);
    else capture(canvas);
  }

  /** The presenter calls this synchronously after the final sky composite.
   * Drain before invoking consumers so no throw or duplicate completion can
   * carry a previous frame's captures into the next presentation. */
  completeFrameCaptures(canvas) {
    const captures = this._frameCaptures || [];
    this.discardFrameCaptures();
    for (const capture of captures) capture(canvas);
  }

  discardFrameCaptures() { this._frameCaptures = null; }

  draw(sim, alpha) {
    this.discardFrameCaptures();
    this.drawCount++;
    const { ctx, canvas } = this;
    const fracture = sim.fracture || null;

    // Logical stage (sim anchors) vs physical buffer (may be 720p–4K).
    // All world drawing uses logical dimensions; the transform scales into
    // the backing store so composition stays correct at every preset.
    const nominalW = sim.stageW || sim.canvasWidth || 1280;
    const nominalH = sim.stageH || sim.canvasHeight || 720;
    // Off-frame camera pull-back (CameraDirector.zoom, 1 = normal, down to
    // ZOOM_MIN when pulled back): NOT a ctx.scale on the physical transform
    // -- that would shrink the world inside a fixed frame and leave empty
    // margins, since every layer draws to canvas bounds. Instead the
    // LOGICAL stage widens (viewW = nominalW / zoom) and the existing sx/sy
    // derivation below does the rest -- every layer genuinely draws more
    // world (tiled strips tile further, full-bleed fills span correctly).
    // Pinned at the logical origin (no translate): guarantees the widened
    // frame always exactly covers the physical canvas with no gap on any
    // edge, at the cost of revealing the extra world toward bottom-right
    // rather than symmetrically around the cast -- a real trade, but the
    // alternative (translating to re-center) opens a gap on the opposite
    // edge for every non-tiled full-bleed layer (sky gradient, vignette),
    // which is a worse artifact than an off-center reveal.
    // stageZoomFor restores the universe pull-back on Range views (see there).
    const zoom = (sim.camera && stageZoomFor(sim.camera, this.rangePresentation)) || 1;
    const baseStageW = zoom < 1 ? nominalW / zoom : nominalW;
    const baseStageH = zoom < 1 ? nominalH / zoom : nominalH;
    // Shake overscan: camera.shakeX/Y (impact shake, calm drift, beat sway)
    // and roll all move the world by translating/rotating it against a
    // frame that, without this, has content painted flush to its edges --
    // any nonzero shake exposed raw, undrawn canvas as a hard black bar on
    // whichever edge the content moved away from. The fix is the same trick
    // zoom uses above, but symmetric: pad the logical stage by SHAKE_MARGIN_PX
    // on every side (every layer paints the wider buffer, same as a zoom
    // pull-back), then inset the visible window by that same margin so it
    // sits centered inside the padded buffer rather than flush at its
    // origin. camera.shakeX/Y then pan within the margin instead of past the
    // edge of what was ever drawn. sx/sy (below) stay derived from the
    // UNPADDED dims, so at shake=0 nothing about the framing changes --
    // the margin is pure reserve, invisible until a shake reaches into it.
    const stageW = baseStageW + 2 * SHAKE_MARGIN_PX;
    const stageH = baseStageH + 2 * SHAKE_MARGIN_PX;
    const stage = this._stageView || (this._stageView = { width: stageW, height: stageH });
    stage.width = stageW;
    stage.height = stageH;
    const outputFit = fitStageOutput(nominalW, nominalH, canvas.width, canvas.height, this.outputCover);
    const sx = outputFit.scale * nominalW / baseStageW;
    const sy = sx;
    // Unpadded counterpart for everything drawn AFTER the shake transform is
    // restored below (vignette/film finish) -- those
    // are screen-edge-hugging effects, not world content, so they must size
    // to the true visible frame, not the padded reserve margin.
    const viewStage = this._viewStageView || (this._viewStageView = { width: baseStageW, height: baseStageH });
    viewStage.width = baseStageW;
    viewStage.height = baseStageH;

    // Fracture freeze/done was previously an early-return that skipped the
    // entire frame (world, HUD, everything). The shatter draw it guarded was
    // removed, so the early-return now just blanks the screen. Removed.

    const pose = sim.lerpState(alpha);
    const camera = presentationCamera(sim.camera, this.rangePresentation, sim.biomes);
    const biomeManager = sim.biomes || null;
    const narrative = sim.rangeNarrativeAt?.() || null;
    this.rangeListeningActive = !!narrative;
    const groundY = sim.stageAnchor?.groundY ?? sim.midio?.groundY ?? 625;
    if (biomeManager) biomeManager.rangeNarrative = narrative;
    const perf = sim.perf || null;
    const particleMul = perf ? perf.particleMul : 1;
    const salience = salienceBudgetFor(sim.focus, biomeManager?.world);
    const worldParticleMul = particleMul * salience.particles;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawOutputBars(ctx, canvas, outputFit);
    // Overscan and post-effects remain inside the fitted picture. ImageData
    // writes bypass Canvas clips, so bars are restored after pixel operations.
    ctx.save();
    ctx.beginPath();
    ctx.rect(outputFit.x, outputFit.y, outputFit.width, outputFit.height);
    ctx.clip();
    ctx.setTransform(sx, 0, 0, sy, outputFit.x, outputFit.y);

    // Impact roll and screen shake both still pivot on the visible window's
    // own center -- which now sits SHAKE_MARGIN_PX inside the padded stage,
    // not at the stage's own center -- so they never scroll the world
    // sideways regardless of the current zoom level, and shakeX/Y pan
    // within the reserve margin instead of past the edge of drawn content.
    //
    // The two translates below are NOT a no-op pair around the rotate: for
    // pure translation they'd cancel back to just (shakeX, shakeY) regardless
    // of viewCx/viewCy (translate(a) then translate(-a+s) nets to translate(s)
    // for any a) -- which is exactly the bug an earlier version of this had.
    // Content is still only ever painted over stage-space [0, stageW], so
    // that cancellation left the visible window flush against content's own
    // origin, using none of the padding on the negative/left or negative/top
    // side -- a positive shakeX still exposed raw canvas on the left. The
    // explicit "- SHAKE_MARGIN_PX" term below is the real, non-cancelling
    // shift that seats the visible window inset by the margin on every side.
    const viewCx = baseStageW / 2 + SHAKE_MARGIN_PX;
    const viewCy = baseStageH / 2 + SHAKE_MARGIN_PX;
    ctx.save();
    ctx.translate(viewCx, viewCy);
    ctx.rotate(camera.roll || 0); // damped impact roll, pivoting on screen center
    ctx.translate(-viewCx + camera.shakeX - SHAKE_MARGIN_PX, -viewCy + camera.shakeY - SHAKE_MARGIN_PX);

    // Ground view: a SECOND, never-zoomed transform that BiomeManager.draw()
    // switches to right before painting the ground and everything from
    // there forward (ground, footing, flood, and -- since nothing after
    // biomeManager.draw() returns touches the transform again until the
    // big restore below -- obstacles, contact shadows, every character,
    // reflections, the foreground veil, and fracture cracks too).
    //
    // Pulling back used to widen the SAME zoomed transform the sky and
    // mountains use, which shrinks literally everything uniformly -- the
    // ground included, so it visibly slid up and off-true as you zoomed
    // out. This instead leaves the ground-and-forward layers rendering at
    // permanently fixed, zoom=1 scale and screen position; only the sky/
    // mountain pass above (already drawn by the time this switches) uses
    // the wider, more-compressed zoomed view. Since that pass is drawn
    // FIRST and the ground pass paints over it afterward at a fixed
    // position, the net effect is exactly "the ground stays put and more
    // sky/mountain becomes visible above it" -- no new blank space is ever
    // exposed, because the sky/mountain pass already safely covers its own
    // (zoomed, wider) bounds the same way it always has.
    const sxFixed = outputFit.scale;
    const syFixed = sxFixed;
    const groundOffsetY = groundPresentationOffsetY(this.rangePresentation, biomeManager, nominalH, groundY);
    const groundStage = this._groundStageView || (this._groundStageView = { width: 0, height: 0 });
    groundStage.width = nominalW + 2 * SHAKE_MARGIN_PX;
    groundStage.height = nominalH + 2 * SHAKE_MARGIN_PX;
    const groundView = {
      stage: groundStage,
      apply: () => {
        applyFixedGroundTransform(ctx, { sx: sxFixed, sy: syFixed, width: nominalW, height: nominalH, camera, offsetY: groundOffsetY,
          outputX: outputFit.x, outputY: outputFit.y });
      },
    };

    // Record the exact future ground CTM, including glacier support offset,
    // before the immutable scenic frame is assembled.
    ctx.save();
    groundView.apply();
    const gt = ctx.getTransform();
    groundView.transform = [gt.a, gt.b, gt.c, gt.d, gt.e, gt.f];
    ctx.restore();

    // Range v2: hand the presentation this frame's inputs and viewports
    // (logical vs backing sizes, overscan, the Canvas transform in effect).
    if (biomeManager && this.rangePresentation?.enabled) {
      biomeManager.rangePresentation = this.rangePresentation;
      const t = ctx.getTransform();
      this.rangePresentation.setFrameInputs({
        sim, pose,
        scenicViewport: viewportState({ logicalWidth: stageW, logicalHeight: stageH,
          backingWidth: Math.round(stageW * sx), backingHeight: Math.round(stageH * sy), overscanPx: SHAKE_MARGIN_PX,
          transform: [t.a, t.b, t.c, t.d, t.e, t.f], nominalWidth: nominalW, nominalHeight: nominalH,
          pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 }),
        groundViewport: viewportState({ logicalWidth: groundStage.width, logicalHeight: groundStage.height,
          backingWidth: Math.round(groundStage.width * sxFixed), backingHeight: Math.round(groundStage.height * syFixed),
          overscanPx: SHAKE_MARGIN_PX, nominalWidth: nominalW, nominalHeight: nominalH,
          transform: groundView.transform, presentationOffsetY: groundOffsetY,
          pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 }),
      });
    } else if (biomeManager) {
      biomeManager.rangePresentation = null;
    }
    if (biomeManager) {
      biomeManager.salience = salience;
      biomeManager.draw(ctx, stage, pose.worldX, pose.midioX, worldParticleMul, perf, groundView);
    } else {
      this._drawFallbackSky(ctx, stage);
      groundView.apply();
      this._drawGround(ctx, groundView.stage, pose, groundY);
    }
    // Water/sky/terrain draw in biomes; the ground response lights them.
    if (biomeManager?.world?.kind === 'alpine' && biomeManager._pass?.('ground-response') !== false) {
      const lights = [];
      this._groundResponse.draw(ctx, { receivers: biomeManager._groundReceivers,
        lights, nowMs: sim.heardTimeMs ?? sim.timeMs,
        hits: recentConductorHits(sim.conductor?.timeline, sim.heardTimeMs ?? sim.timeMs),
        quality: perf?.level ?? 0 });
    }
    // drawForeground (the L7 veil + near-field occluders, NearField.js)
    // before fracture: the cracks are the screen's own glass fracturing,
    // so they belong on top of every world layer, near-field props included
    // -- not occluded by something the world itself is drawing.
    if (biomeManager) biomeManager.drawForeground(ctx, groundView.stage, pose.worldX, perf ? perf.veilEnabled : true);
    // Glass cracks removed: the progressive fracture and its terminal
    // shatter are gone at the request of the design. The ENGINE stays --
    // CutDirector, CodaDirector, NoteChart and the film finish all hang off
    // its finale timing (isAboutToFreeze / justEnteredFinale), and that
    // timing is the song's ending, not a decoration -- but it no longer
    // draws anything.

    ctx.restore(); // camera transform

    // Post FX that sample the pixel buffer need identity transform + full
    // physical canvas size (bloom / retro / freeze capture).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Landscape's sky and terrain are assembled by the presenter at output
    // resolution. Its screen-space effects must see that completed image.
    const deferPost = !!this.deferPostEffects;
    // Landscape's vignette reads the shared score of this frame. A replay
    // for capture must not re-read live state, so the inputs are snapshotted.
    const finish = narrative ? this._landscapeFinishInputs(sim) : null;
    this._deferredPostEffects = deferPost ? { sim, pose, salience, viewStage: { ...viewStage }, finish,
      film: !!(narrative || (sim.filmFinish && (perf ? perf.heavyPostFx : true))),
      captions: sim.rangeCaptions || sim.rangeCaption, titleCard: sim.titleCard || null,
      titleCardMs: sim.heardTimeMs ?? sim.timeMs, grid: this.pixelPolicy?.grid,
      hud: sim.conductor && this.hudInFrame && !narrative ? { width: nominalW, height: nominalH } : null } : null;
    if (!deferPost) this._drawBloom(ctx, canvas, sim, salience);
    // After bloom, not before: heat is a lens on the whole scene, so it
    // should bend the glow bloom just added too, not just the world under it.
    if (!deferPost) this._drawHeatDistortion(ctx, canvas, sim, pose, viewStage, outputFit);
    if (!deferPost && (narrative || (sim.filmFinish && (perf ? perf.heavyPostFx : true)))) {
      // Film finish was authored in logical space; scale its fill rects.
      ctx.setTransform(sx, 0, 0, sy, outputFit.x, outputFit.y);
      this._drawFilmFinish(ctx, viewStage, sim, finish);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // HUD seekbar AFTER post-FX so vignette/bloom never bury it. paramBus is
    // optional (lives on sim); never reference a free variable here — a
    // ReferenceError used to abort the draw and kill the strip entirely.
    // Deliberately drawn against the NOMINAL (unzoomed) stage, not the
    // possibly-widened `stage` above: it's fixed HUD chrome, not world
    // content, and main.js's hitTest already converts pointer coords into
    // the nominal STAGE_W/STAGE_H space -- drawing it against the zoomed
    // stage would desync the visible strip from where clicks land.
    if (!deferPost && sim.conductor && this.hudInFrame && !narrative) {
      ctx.setTransform(outputFit.scale, 0, 0, outputFit.scale, outputFit.x, outputFit.y);
      this._drawComposerHud(ctx, { width: nominalW, height: nominalH }, sim);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // The real range's name (RangeCaption.js). Not HUD chrome: it is part of
    // the picture, so it is drawn whether or not the HUD is in frame, and
    // recordings and bulk exports carry it.
    this.pixelCaptionLayout = null;
    if (!deferPost && (sim.rangeCaption || sim.rangeCaptions)) {
      ctx.setTransform(sxFixed, 0, 0, syFixed, outputFit.x, outputFit.y);
      const captionStage = this._captionStageView || (this._captionStageView = { width: nominalW, height: nominalH });
      captionStage.width = nominalW;
      captionStage.height = nominalH;
      try {
        if (this.pixelPolicy?.active) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.pixelCaptionLayout = drawPixelCaption(ctx, sim.rangeCaptions || sim.rangeCaption, sim.timeMs, { grid: this.pixelPolicy.grid });
        } else drawRangeCaption(ctx, captionStage, sim.rangeCaptions || sim.rangeCaption, sim.timeMs);
      }
      catch (err) { console.warn('[range caption]', err); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // The song's title card (TitleCard.js) opens every song over the flat
    // ground, on top of everything, and is gone 2.7 s in. It runs on heard
    // time, the opening surge's clock, so output latency cannot clear the
    // card before the land has risen.
    if (!deferPost && sim.titleCard) {
      const cardMs = sim.heardTimeMs ?? sim.timeMs;
      try {
        if (this.pixelPolicy?.active) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          drawPixelTitleCard(ctx, sim.titleCard, cardMs, { grid: this.pixelPolicy.grid });
        } else {
          ctx.setTransform(sxFixed, 0, 0, syFixed, outputFit.x, outputFit.y);
          drawTitleCard(ctx, { width: nominalW, height: nominalH }, sim.titleCard, cardMs);
        }
      } catch (err) { console.warn('[title card]', err); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    ctx.restore(); // fitted output clip
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawOutputBars(ctx, canvas, outputFit);

    // Color-regime peaks come from song evidence in heard time (the clock
    // the sky, storm and palettes are painted on); only this composed frame
    // can confirm the regime is on screen. Snapshot before the freeze below.
    const highlightFrame = sim.highlightReel && !sim.highlightReel.complete
      ? highlightFrameState(sim, biomeManager) : null;

    if (fracture && fracture.isAboutToFreeze)
      this._captureSceneFrame(canvas, source => fracture.captureFreeze(source, sim.timeMs));

    if (highlightFrame) {
      const heardMs = sim.heardTimeMs ?? sim.timeMs, frameMs = sim.timeMs;
      this._captureSceneFrame(canvas, source => sim.highlightReel.notify(highlightCandidatesFor(sim, heardMs), source, heardMs, {
        frameTimeMs: frameMs, producerTimeMs: heardMs,
        isVisible: candidate => highlightVisible(candidate, highlightFrame),
      }));
    }
  }

  _drawOutputBars(ctx, canvas, fit) {
    if (fit.x <= 0 && fit.y <= 0) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    if (fit.y > 0) {
      ctx.fillRect(0, 0, canvas.width, fit.y);
      ctx.fillRect(0, fit.y + fit.height, canvas.width, canvas.height - fit.y - fit.height);
    }
    if (fit.x > 0) {
      ctx.fillRect(0, 0, fit.x, canvas.height);
      ctx.fillRect(fit.x + fit.width, 0, canvas.width - fit.x - fit.width, canvas.height);
    }
    ctx.restore();
  }

  /** The Unraveling: a 'saturation' blend-mode rect pulls the whole world
   *  toward gray as the ending arc progresses. A fully desaturated (gray)
   *  fill under this blend mode desaturates the backdrop proportionally to
   *  globalAlpha -- no pixel readback needed. */
  _drawDesaturationOverlay(ctx, canvas, coda) {
    const amount = coda.desaturation;
    if (amount <= 0.001) return;
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = amount;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /** Landscape vignette inputs from the shared score: `{energy, lift, kick,
   *  stormAmount}` read from `this.rangePresentation.frame` (its `effects`
   *  and `storm`). Null unless that frame was built within 250 ms of this
   *  heard time; a stale frame must not steer the vignette. The returned
   *  object is renderer-owned and rewritten once per draw. */
  _landscapeFinishInputs(sim) {
    const frame = this.rangePresentation?.frame;
    const heardMs = sim.heardTimeMs ?? sim.timeMs;
    if (!frame || !(Math.abs(frame.timeMs - heardMs) <= 250)) return null;
    const effects = frame.effects || null;
    const out = this._finishInputs || (this._finishInputs = { energy: 0, lift: 0, kick: 0, stormAmount: 0, mood: null });
    out.energy = effects?.energy || 0;
    out.lift = effects?.lift || 0;
    out.kick = effects?.kick || 0;
    out.stormAmount = frame.storm?.amount || 0;
    // Frozen with the frame, so a deferred capture replays the same hue.
    out.mood = frame.mood || null;
    return out;
  }

  /** Film finish: the last cinematography pass before the HUD. A soft-light
   *  color grade wash (warm push when hot/high-budget, cool push when
   *  calm) drawn first, then a radial-gradient vignette on top -- grade-
   *  then-vignette matches a real post pipeline, where the vignette is a
   *  neutral lens artifact applied after grading. gradeAlpha has no
   *  percussive term at all.
   *
   *  Landscape (a narrative with `finish`, the score snapshot from
   *  _landscapeFinishInputs): the vignette is landscapeFinish, a pure
   *  function of that frame's score -- deeper in quiet passages, opened by a
   *  section lift, slightly closed by a storm, its onset widened (never its
   *  alpha raised) by a kick. It holds no history, so it matches after a
   *  seek and in a deferred capture replay. Other worlds and a Landscape
   *  frame without a fresh score keep the dt-integrated FilmFinish
   *  depth (and, for a narrative, the narrative pressure edge). */
  _drawFilmFinish(ctx, canvas, sim, finish = null) {
    const narrative = sim.rangeNarrativeAt?.() || null;
    if (!narrative && sim.biomes?._pass?.('film') === false) return;
    const ff = sim.filmFinish || { warmth: .3, vignetteDepth: 0 };
    const heavy = (sim.perf?.heavyPostFx ?? true) && sim.biomes?._pass?.('film') !== false;
    const dials = styleDials(sim.visualStyle);
    const gradeMul = dials.filmGradeMul;
    const vigMul = dials.vignetteDepthMul;

    // One Spectrum: the grade's cool/warm stops are derived from the
    // current keyed halo family, so the calm-teal / hot-amber push rides
    // the song's hue instead of a fixed palette. Falls back to the
    // hand-tuned constants when there's no biome (fallback-sky branch).
    const fam = sim.biomes && typeof sim.biomes.currentHaloColor === 'function'
      ? spectralFamily(sim.biomes.currentHaloColor(), sim.keyDirector ? ((sim.keyDirector.tonic % 12) + 12) % 12 * 30 : 0)
      : null;
    const gradeCool = fam ? fam.coolHex : FILM_GRADE_COOL;
    const gradeWarm = fam ? fam.warmHex : FILM_GRADE_WARM;
    const color = this._filmLerpCache.get(gradeCool, gradeWarm, ff.warmth);
    const gradeAlpha = (FILM_GRADE_ALPHA_BASE + FILM_GRADE_ALPHA_RANGE * Math.abs(ff.warmth - 0.5) * 2) * gradeMul;
    const filmWeight = sim.biomes?.world?.kind === 'alpine' ? (sim.biomes._rangePresentation?.film ?? 1) : 1;
    const mood = narrative && finish?.mood?.alpha > 0 ? finish.mood : null;
    ctx.save();
    if (mood) {
      // Landscape: the song's mood owns the frame's hue (MoodScore.js). The
      // 'color' blend keeps each pixel's luminance, so the grade can never
      // pump brightness; it is a musical signature and survives every
      // quality rung. One fill: it costs the same destination read as the
      // soft-light wash it replaces (a second dst-read fill would not).
      ctx.globalCompositeOperation = 'color';
      ctx.globalAlpha = Math.min(MOOD_GRADE_MAX, mood.alpha) * filmWeight;
      ctx.fillStyle = this._moodFill(mood.rgb);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = heavy ? Math.min(0.22, gradeAlpha) * filmWeight * (narrative?.materials ?? 1) : 0;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Rendered: a whisper of indigo space grade so the whole frame reads
    // a little more orbital / deep-sea than pure warm daylight.
    if (dials.spaceWash && heavy) {
      ctx.globalAlpha = Math.min(0.12, 0.045 * gradeMul) * (narrative?.skyDark ?? 1);
      ctx.fillStyle = FILM_GRADE_SPACE;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();

    const cx = canvas.width / 2, cy = canvas.height / 2;
    const outerR = Math.hypot(cx, cy);
    let onset, edgeAlpha;
    if (narrative && finish) {
      const lf = landscapeFinish(finish, { heavy, vignetteDepthMul: vigMul },
        this._landscapeFinishOut || (this._landscapeFinishOut = { edgeAlpha: 0, onset: 0 }));
      onset = lf.onset;
      edgeAlpha = lf.edgeAlpha;
    } else {
      const depth = Math.min(1, ff.vignetteDepth * vigMul);
      const heardMs = sim.heardTimeMs ?? sim.timeMs;
      const hits = narrative ? recentConductorHits(sim.conductor?.timeline, heardMs) : [];
      const kick = hits.length ? hits[0].strength * Math.exp(-(heardMs - hits[0].tMs) / 180) : 0;
      const pressure = narrativePressure(narrative, kick, sim);
      onset = narrative ? .56 - pressure.contraction : VIGNETTE_ONSET_MAX - (VIGNETTE_ONSET_MAX - VIGNETTE_ONSET_MIN) * depth;
      const filmEdge = heavy ? VIGNETTE_MIN_ALPHA + (VIGNETTE_MAX_ALPHA - VIGNETTE_MIN_ALPHA) * depth : 0;
      edgeAlpha = narrative ? composedNarrativeEdge(pressure.edgeAlpha, filmEdge * narrative.skyDark) : filmEdge;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(cx, cy, outerR * onset, cx, cy, outerR);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${edgeAlpha.toFixed(3)})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /** CSS colour for a mood rgb triple, reused while the hue holds. */
  _moodFill(rgb) {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (this._moodFillKey !== key) { this._moodFillKey = key; this._moodFillCss = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; }
    return this._moodFillCss;
  }

  /** HUD chrome follows optical effects in both live and recorded frames. */
  _drawComposerHud(ctx, stage, sim) {
    if (!this.composer) {
      const holds = sim.noteChart ? sim.noteChart.notes.filter((n) => n.type === 'hold') : [];
      const sections = sim.biomes?.sections || [];
      this.composer = new ComposerStrip(
        sim.conductor.timeline, sim.conductor.barGrid, sim.conductor.durationMs, holds, sections, sim.audioOverview,
      );
      this.composer.estimatedDuration = !!sim.estimatedDuration;
    } else if (sim.biomes?.sections) {
      this.composer.setSections(sim.biomes.sections);
    }
    this.composer.analysisOpening = sim.analysisOpening || null;
    this.composer.draw(ctx, stage, sim.timeMs, {
      showLabels: !!(sim.showSectionLabels || sim.paramBus?.showSectionLabels),
    });
  }

  /** Apply the Landscape's optical effects to the completed hybrid image.
   * The same operation is replayed at a recorder's own output size. Captions
   * follow the effects, as they did in the native compositor. */
  drawDeferredPostEffects(ctx, fit) {
    const frame = this._deferredPostEffects;
    if (!frame) return;
    ctx.save();
    const policy = this.pixelPolicy;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath(); ctx.rect(fit.x, fit.y, fit.width, fit.height); ctx.clip();
      // Heat's native-pixel path quantizes offsets. Use continuous offsets
      // here because the target is the already composed optical image.
      this.pixelPolicy = null;
      this._drawBloom(ctx, ctx.canvas, frame.sim, frame.salience);
      this._drawHeatDistortion(ctx, ctx.canvas, frame.sim, frame.pose, frame.viewStage, fit, fit.width / 1280);
      if (frame.film) {
        const sx = fit.width / frame.viewStage.width, sy = fit.height / frame.viewStage.height;
        ctx.setTransform(sx, 0, 0, sy, fit.x, fit.y);
        this._drawFilmFinish(ctx, frame.viewStage, frame.sim, frame.finish ?? null);
      }
      if (frame.hud) {
        ctx.setTransform(fit.width / frame.hud.width, 0, 0, fit.height / frame.hud.height, fit.x, fit.y);
        this._drawComposerHud(ctx, frame.hud, frame.sim);
      }
      if (frame.captions && frame.grid) {
        ctx.setTransform(fit.width / frame.grid.width, 0, 0, fit.height / frame.grid.height, fit.x, fit.y);
        drawPixelCaption(ctx, frame.captions, frame.sim.timeMs, { grid: frame.grid });
      }
      if (frame.titleCard) {
        if (frame.grid) {
          ctx.setTransform(fit.width / frame.grid.width, 0, 0, fit.height / frame.grid.height, fit.x, fit.y);
          drawPixelTitleCard(ctx, frame.titleCard, frame.titleCardMs, { grid: frame.grid });
        } else {
          ctx.setTransform(fit.width / 1280, 0, 0, fit.height / 720, fit.x, fit.y);
          drawTitleCard(ctx, { width: 1280, height: 720 }, frame.titleCard, frame.titleCardMs);
        }
      }
    } finally {
      this.pixelPolicy = policy;
      ctx.restore();
    }
  }

  /** Heat distortion: a UV-warp lens over the fully composed frame, for an
   *  active wildfire (FireDirector) or EMBER's own ambient ember-haze. Same
   *  offscreen-buffer-then-composite shape as bloom, just used to WARP the
   *  source instead of ADD to it: copy the composited frame into a buffer,
   *  then redraw it back through a grid of overlapping sub-rectangles, each
   *  nudged by a slow horizontal sway, strongest low in frame and fading
   *  toward the top (real heat haze bends light sideways as it convects
   *  upward off the ground, not the sky). Runs on heard time.
   *  Sheds under PerfGovernor pressure like its siblings -- a flourish,
   *  never core feedback. `_pose` is kept for the callers' argument order. */
  _drawHeatDistortion(ctx, canvas, sim, _pose, viewStage, outputFit = null, outputScale = null) {
    const perf = sim.perf;
    if (perf && !perf.heavyPostFx) { this._postBuffers?.release('heat'); this._heatCanvas = null; return; }

    // Heat needs a visible owner. The wildfire is painted only by
    // BiomeManager.drawForeground, which returns early for alpine worlds, so
    // Landscape shows no fire to bend light over. EMBER's ambient haze keeps
    // its own owner, the ember sky.
    const heardMs = sim.heardTimeMs ?? sim.timeMs;
    const fireVisible = sim.biomes?.world?.kind !== 'alpine';
    const emberFxAlpha = sim.biomes && sim.biomes.currentFxAlpha ? sim.biomes.currentFxAlpha('emberGlow') : 0;
    const ambient = heatAmbient01(!!(fireVisible && sim.fire && sim.fire.active), sim.fire ? sim.fire.intensity01 : 0, emberFxAlpha);
    if (ambient <= 0.02) return;

    const pixelUnit = this.pixelPolicy?.active ? this.pixelPolicy.unit : 0;
    const detailScale = pixelUnit || (outputScale > 0 ? outputScale : 1);
    const thresholdScale = !pixelUnit && outputScale > 0 ? outputScale : 1;
    const ambientAmpPx = HEAT_AMBIENT_MAX_PX * ambient * detailScale;
    if (ambientAmpPx < 0.15 * thresholdScale) return;

    if (this._postBuffers) {
      this._heatCanvas = this._postBuffers.ensure('heat', canvas.width, canvas.height);
      if (!this._heatCanvas) return;
    }
    if (!this._heatCanvas) this._heatCanvas = document.createElement('canvas');
    const src = this._heatCanvas;
    if (src.width !== canvas.width || src.height !== canvas.height) {
      src.width = canvas.width;
      src.height = canvas.height;
    }
    const srcCtx = src.getContext('2d');
    if (pixelUnit) srcCtx.imageSmoothingEnabled = false;
    srcCtx.globalCompositeOperation = 'copy';
    srcCtx.drawImage(canvas, 0, 0);

    // Coarser grid at higher resolutions -- same cost, same apparent cell
    // size on screen, matching bloom's own downscale-by-canvas-width steps.
    const cell = pixelUnit ? 8 * pixelUnit : HEAT_GRID_PX * (outputScale > 0 ? outputScale : canvas.width > 2560 ? 2.2 : canvas.width > 1920 ? 1.6 : 1);
    const pad = pixelUnit || HEAT_PAD_PX * detailScale;
    const picture = outputFit || { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const cols = Math.ceil(picture.width / cell);
    const rows = Math.ceil(picture.height / cell);
    const t = heardMs / 1000;
    // The ground y is a logical (viewStage) coord; this pass runs post
    // identity-reset against the full physical canvas, so rescale by the
    // same factor the rest of draw() uses for that jump.
    const scaleY = viewStage && viewStage.height ? picture.height / viewStage.height : 1;
    const groundY = sim.midio?.groundY;
    const originY = picture.y + (groundY != null ? groundY * scaleY : picture.height * 0.7);

    ctx.save();
    // NOT 'copy'. Under 'copy' each drawImage discards the ENTIRE destination
    // outside the rect it just drew, so in a per-cell loop every cell erased
    // all the cells before it and the finished frame was just the last cell --
    // measured at 0.2% of the canvas surviving 63 blits, which on screen is a
    // blank stage with only the DOM chrome (buttons, seek bar) left visible.
    // 'source-over' is what a warp actually wants: each shifted slice paints
    // over the frame it came from, and any pixel no cell lands on simply keeps
    // its original unwarped content instead of being punched out.
    ctx.globalCompositeOperation = 'source-over';
    if (pixelUnit) ctx.imageSmoothingEnabled = false;
    for (let ry = 0; ry < rows; ry++) {
      const cy = picture.y + ry * cell + cell / 2;
      for (let rx = 0; rx < cols; rx++) {
        const cx = picture.x + rx * cell + cell / 2;
        let offX = 0, offY = 0;
        if (ambientAmpPx > 0.05 * thresholdScale) {
          // Canvas Y grows downward. Reach full sway at the actual ground
          // in backing-store coordinates, with the weaker floor above it.
          const heightFrac = clamp01((cy - picture.y) / Math.max(1, originY - picture.y));
          offX += Math.sin((cx - picture.x) / detailScale * 0.045 + t * 2.4 + (cy - picture.y) / detailScale * 0.03) * ambientAmpPx * (0.35 + 0.65 * heightFrac);
        }
        if (pixelUnit) { offX = pixelHeatOffset(offX, { unit: pixelUnit }); offY = pixelHeatOffset(offY, { unit: pixelUnit }); }
        if (Math.abs(offX) < 0.05 * thresholdScale && Math.abs(offY) < 0.05 * thresholdScale) continue; // no-op cell -- skip the blit entirely
        const sx = picture.x + rx * cell - pad, sy = picture.y + ry * cell - pad;
        const sw = cell + pad * 2, sh = cell + pad * 2;
        ctx.drawImage(src, sx, sy, sw, sh, sx + offX, sy + offY, sw, sh);
      }
    }
    ctx.restore();
  }

  /** Bloom: light-bleed over the whole composed frame. Downsample (a cheap
   *  blur for free and ~DOWNSCALE^2 less fill), crush to highlights via a
   *  self-multiply threshold (near-white sources survive, midtones/darks
   *  don't), blur, screen back at a restrained music-reactive strength.
   *  Screen preserves highlight detail where additive compositing clipped.
   *  Naturally tinted by whatever was bright: gold glow bleeds gold,
   *  aurora bleeds green. Sheds under PerfGovernor pressure (a
   *  budget-allowing flourish, not core feedback). */
  _drawBloom(ctx, canvas, sim, salience = null) {
    // Range already has luminous crest lines; a full-frame bloom obscures them.
    const perf = sim.perf;
    this._pixelGlowVisible = false;
    if (!this.pixelPolicy?.active) this._postBuffers?.release('pixel-glow');
    if (sim.biomes?.world?.kind === 'alpine' || perf && !perf.bloomEnabled) {
      this._postBuffers?.release('bloom');
      this._postBuffers?.release('pixel-glow');
      this._bloomA = this._bloomB = null;
      return;
    }
    const strength = bloomStrength(
      sim.hype, null, sim.opening ? sim.opening.gain : 1,
      salience?.bloom ?? 1,
    );
    if (strength <= 0.005) return;

    if (this.pixelPolicy?.active) {
      this._postBuffers?.release('bloom'); this._bloomA = this._bloomB = null;
      this._pixelGlowVisible = drawPixelGlow(ctx, canvas, { buffers: this._postBuffers, unit: this.pixelPolicy.unit, strength });
      return;
    }

    const bloomScale = postFxDownscale(canvas.width);
    const wSmall = Math.max(1, Math.round(canvas.width / bloomScale));
    const hSmall = Math.max(1, Math.round(canvas.height / bloomScale));
    if (this._postBuffers) {
      const buffers = this._postBuffers.ensure('bloom', wSmall, hSmall, 2);
      if (!buffers) return;
      [this._bloomA, this._bloomB] = buffers;
    }
    if (!this._bloomA) this._bloomA = document.createElement('canvas');
    if (!this._bloomB) this._bloomB = document.createElement('canvas');
    const a = this._bloomA, b = this._bloomB;
    if (a.width !== wSmall || a.height !== hSmall) { a.width = wSmall; a.height = hSmall; }
    if (b.width !== wSmall || b.height !== hSmall) { b.width = wSmall; b.height = hSmall; }
    const actx = a.getContext('2d');
    const bctx = b.getContext('2d');

    // 1) Downsample the fully composed frame into the small buffer.
    actx.globalCompositeOperation = 'copy';
    actx.globalAlpha = 1;
    actx.drawImage(canvas, 0, 0, wSmall, hSmall);

    // 2) Highlight extraction: self-multiply squares every channel each
    // pass (0.9 -> 0.81 -> 0.66; 0.5 -> 0.25 -> 0.06; 0.2 -> 0.04 -> 0.002),
    // a cheap threshold with no per-pixel JS.
    actx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < BLOOM_THRESHOLD_PASSES; i++) actx.drawImage(a, 0, 0);

    // 3) Blur the highlights.
    bctx.clearRect(0, 0, wSmall, hSmall);
    bctx.globalCompositeOperation = 'copy';
    bctx.filter = `blur(${BLOOM_BLUR_PX}px)`;
    bctx.drawImage(a, 0, 0);
    bctx.filter = 'none';

    // 4) Screen the spill into remaining highlight headroom. Additive
    // blending clipped bright sky/terrain to white (0.8 + 0.75 * 0.8^4
    // exceeds 1); screen keeps their differences instead of saturating.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = strength;
    ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  _drawFallbackSky(ctx, canvas) {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, '#1c2248');
    g.addColorStop(1, '#4a4a7a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  _drawGround(ctx, canvas, pose, groundY) {
    ctx.fillStyle = '#4a4068';
    ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    const spacing = 60;
    const offset = ((pose.worldX % spacing) + spacing) % spacing;
    ctx.beginPath();
    for (let x = -offset; x < canvas.width; x += spacing) {
      ctx.moveTo(x, groundY);
      ctx.lineTo(x + 20, groundY);
    }
    ctx.stroke();
  }

}

/**
 * Music-reactive bloom strength: a small steady base (a lit scene always
 * catches a little light, not a flash) plus a reactive swell from the same
 * signals that already throw the drop shockwave and the fever aura
 * (HypeDirector.slam/surge, FeverMeter.level). Clamped to BLOOM_MAX so a
 * maxed-out drop-during-fever never blows the frame out.
 */
export function bloomStrength(hype, fever, openingGain = 1, supportingBloomMul = 1) {
  const slam = hype ? hype.slam : 0;
  const surge = hype ? hype.surge : 0;
  const feverLevel = fever ? fever.level : 0;
  const reactive = 0.25 * (0.45 * slam + 0.35 * surge + 0.3 * feverLevel);
  // The base glow is unconditional, which meant a song fading in from silence
  // still opened on a fully bloomed frame -- the single loudest thing on
  // screen at t=0, and the one least justified by anything audible.
  // OpeningDirector's gain scales it until the song has actually started.
  // The reactive term belongs to an earned hit; only the resting spill has
  // to yield when another subject owns the frame.
  return Math.min(BLOOM_MAX, BLOOM_BASE * openingGain * clamp01(supportingBloomMul) + reactive);
}

/** 0..1 ambient heat level driving the heat distortion. An active
 *  FireDirector strike drives this directly by its own intensity01; absent
 *  that, EMBER's ambient fx alpha contributes a capped, gentler haze -- a
 *  mood, not a blaze. Pure so it's testable without a canvas. */
export function heatAmbient01(fireActive, fireIntensity01 = 0, emberFxAlpha = 0) {
  const fire = fireActive ? clamp01(fireIntensity01) : 0;
  return clamp01(Math.max(fire, clamp01(emberFxAlpha) * EMBER_AMBIENT_LEVEL));
}
