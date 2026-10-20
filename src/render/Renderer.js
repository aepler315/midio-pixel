import { drawTrioStage } from './TrioStage.js';
import { CanvasBuffers } from './CanvasResidency.js';
import { drawPixelGlow, pixelHeatOffset } from './PixelEffects.js';
import { resolveLandscapePresentation } from '../world/LandscapePresentation.js';
import { drawInhabitedShore, kickHop01 } from '../world/InhabitedShore.js';
// Canvas 2D compositor. Draws sky -> parallax biome layers -> ground ->
// telegraph glints -> world FX -> companions -> Midio -> foreground veil ->
// cracks/shatter -> HUD. Layers are added incrementally as later stages land;
// each stage guards on the subsystem's presence so this file grows additively.
import { MIDIO_MESH, MIDIO_BODY, MIDIO_EYE, MIDIO_EYE_CY, MIDIO_EYE_SOCKET_R, midioEyeMesh, MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED } from './meshes.js';
import { computeRestLengths, drawMeshPart, displaceMeshRadial, meltMesh, lerpMesh, applyTransform, drawGlowHalo } from './MeshDrawer.js';
import { midioMotion } from './MidioMotion.js';
import { easeHueDeg } from './stellar.js';
import { MIDIO_IDENTITY_HUE, REWARD_HUE } from './ColorLaw.js';
import { ComposerStrip } from './ComposerStrip.js';
import { drawRangeCaption } from '../ui/RangeCaption.js';
import { drawPixelCaption } from '../ui/PixelCaption.js';
import { GOLD_AFTERIMAGE_LIFE_MS } from '../sim/MidioPerformer.js';
import { clamp01 } from '../utils/math.js';
import { capFlashAlpha, flashCompositeOp } from '../ui/Accessibility.js';
import { LerpCache, hexToRgb } from '../utils/color.js';
import { spectralFamily } from './spectral.js';
import { hypeFrameStyle } from '../sim/HypeDirector.js';
import { salienceBudgetFor } from './SalienceBudget.js';
import { styleDials } from './VisualStyle.js';
import { GroundResponse, recentConductorHits } from '../world/alpine/GroundResponse.js';
import { viewportState } from '../world/alpine/RangeFrame.js';
import { composedNarrativeEdge } from './NarrativeDraw.js';
import { narrativePressure } from '../world/alpine/RangeNarrative.js';
import { highlightCandidatesFor } from './HighlightReel.js';

// Reserve margin (logical stage px) around the visible frame that camera
// shake/drift/sway/roll are free to pan into without ever exposing raw,
// undrawn canvas. Covers the worst realistic combined displacement: a
// maxed impact shake (~10px) + full calm drift (26px) + full beat sway
// (12px) plus a few px of corner reveal from the small impact roll, with
// headroom to spare. See Renderer.draw's stageW/stageH derivation.
export const SHAKE_MARGIN_PX = 64;

const MIDIO_DRAW_SCALE = 1.935; // 10% smaller than 2.15; physics footprint stays 23px half-width

// Fever aura: a screen-edge glow that only shows up once the player's earned
// it -- silent below the threshold so it never competes with the vignette
// or hype frame on an ordinary section.
const FEVER_AURA_THRESHOLD = 0.55;
const FEVER_AURA_MAX_ALPHA = 0.22;

// Drop impact pack: a brief chromatic-split shock + radial speed-lines,
// fired once per HypeDirector drop (see Simulation's dropCount edge-detect).
const DROP_IMPACT_LIFE_MS = 320;
const SHOCK_MAX_OFFSET_PX = 8;
const SHOCK_MAX_ALPHA = 0.5;
const SPEED_LINE_COUNT = 24;
const SPEED_LINE_MAX_ALPHA = 0.35;

// Drop motion blur: a 2-3 frame accumulation over the composed frame,
// fired inside the drop impact window while the camera is actually being
// thrown around -- the shake's violence sold as exposure smear rather than
// one more flash. Camera travel at MOTION_BLUR_SPEED_REF_PX logical px/frame
// reads as full smear; ghosts trail the motion and fade with age.
const MOTION_BLUR_SPEED_REF_PX = 7;
const MOTION_BLUR_GHOST_ALPHA = [0.30, 0.18]; // per history frame (t-1, t-2), scaled by strength
const MOTION_BLUR_MIN_ALPHA = 0.02;

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
 *  copy costs, so the buffer shrinks to match. Shared by bloom and the drop
 *  motion-blur ring below: same problem (an effect that has to sample or
 *  hold a copy of the whole composed frame), same answer. */
function postFxDownscale(width) {
  return width > 2560 ? 5 : width > 1920 ? 4 : BLOOM_DOWNSCALE_BASE;
}
// Bloom supports the scene rather than becoming a white veil on drops.
// Scale the reactive term AFTER its accessibility cap so reduced-flash
// remains visibly softer even under this much lower overall ceiling.
export const BLOOM_BASE = 0.02;
const BLOOM_MAX = 0.24;

// Heat distortion: a UV-warp lens over the fully composed frame for the two
// things in this world that are actually on fire -- a drop's shock wave and
// an active wildfire (or EMBER's own ambient ember-haze). Grid cells are
// screen px at 1x; padded so shifted neighbors still overlap and no seams
// open up between them.
const HEAT_GRID_PX = 56;
const HEAT_PAD_PX = 6;
const HEAT_DROP_MAX_PX = 5;      // radial shockwave-lens peak displacement
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
const VIGNETTE_MIN_ALPHA = 0.02;         // edge darkness at maximum openness (full hype/drop)
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
export function fitStageOutput(width, height, outputWidth, outputHeight) {
  const scale = Math.min(outputWidth / width, outputHeight / height);
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
    this._midioRestLengths = computeRestLengths(MIDIO_MESH);
    this._midioBodyRest = computeRestLengths(MIDIO_BODY);
    this._midioEyeRest = computeRestLengths(MIDIO_EYE);
    this._apoBodyRest = computeRestLengths(MIDIO_APOTHEOSIS_FOLDED);
    this.composer = null; // lazy: needs the conductor's timeline at first draw
    // The picture opens clean; F3 can reveal the timeline for section debug.
    this.hudInFrame = false;
    // Drop motion blur: a 3-slot ring of backing-store-sized canvases holding
    // the last three composed frames, captured every frame so the ring is
    // already warm when a drop lands. Lazy: allocated on first draw, resized
    // if the canvas ever does.
    this._motionHistory = null;
    this._motionRing = 0;
    this._lastShakeX = null; // last frame's camera position, for per-frame travel
    this._lastShakeY = null;
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

  dispose() { this.discardFrameCaptures(); this._postBuffers.dispose(); this._groundResponse.dispose(); this._capture?.dispose(); }

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
    this.inhabitedShoreDraws = 0;
    const { ctx, canvas } = this;
    if (sim.trio) {
      this.rangeListeningActive = false;
      this._styleDials = styleDials(sim.visualStyle);
      this._capture?.dispose(); this._capture = null;
      for (const name of ['motion', 'shock', 'heat', 'pixel-glow']) this._postBuffers.release(name);
      drawTrioStage(ctx, canvas, sim.trio, { drawMidio: (pose, performer, seconds, ensemble) => {
        const beat = sim.songBeat.snapshotAt(sim.heardTimeMs);
        this._drawMidio(ctx, pose, performer, seconds, 0, null, !!sim.reducedFlash, 210, ensemble, null, 1, null,
          beat.freeTime ? null : beat.phase01);
      } });
      return;
    }
    const fracture = sim.fracture || null;
    this._styleDials = styleDials(sim.visualStyle);

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
    const zoom = (sim.camera && sim.camera.zoom) || 1;
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
    const outputFit = fitStageOutput(nominalW, nominalH, canvas.width, canvas.height);
    const sx = outputFit.scale * nominalW / baseStageW;
    const sy = sx;
    // Unpadded counterpart for everything drawn AFTER the shake transform is
    // restored below (vignette/fever aura/hype frame/film finish) -- those
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
    const presentation = resolveLandscapePresentation(biomeManager?.world);
    if (!presentation.performers) {
      this._postBuffers.release('motion'); this._motionHistory = null;
    }
    if (!presentation.performers || sim.perf?.particleMul < 1) {
      this._postBuffers.release('shock'); this._shockCanvas = null;
    }
    const groundY = sim.stageAnchor?.groundY ?? sim.midio?.groundY ?? 625;
    this._capture?.dispose(); this._capture = null;
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
    let scenicMatrix = null;
    if (biomeManager) {
      biomeManager.salience = salience;
      biomeManager.inhabitedShore = false;
      // The scenic transform the celestial bodies are painted with, so the
      // shore's glitter path can sit under the sun or moon on screen.
      scenicMatrix = ctx.getTransform();
      biomeManager.draw(ctx, stage, pose.worldX, pose.midioX, null, worldParticleMul, perf, groundView);
    } else {
      this._drawFallbackSky(ctx, stage);
      groundView.apply();
      this._drawGround(ctx, groundView.stage, pose, groundY);
    }
    // Shared performers, personal lights, brush, shadows and reflections
    // have no listening ownership. Water/sky/terrain still draw in biomes.
    if (biomeManager?.world?.kind === 'alpine' && biomeManager._pass?.('ground-response') !== false) {
      const lights = [];
      this._groundResponse.draw(ctx, { receivers: biomeManager._groundReceivers,
        lights, nowMs: sim.heardTimeMs ?? sim.timeMs,
        hits: recentConductorHits(sim.conductor?.timeline, sim.heardTimeMs ?? sim.timeMs),
        reducedFlash: !!sim.reducedFlash, reducedMotion: !!sim.reducedMotion,
        quality: perf?.level ?? 0 });
    }
    // The inhabited shore: near sea over the bottom third, with Midio's
    // ship, Broshi on the beach and Midasus in the sky. Nominal stage space
    // on the fixed-ground transform, so it shakes and rolls with the land.
    if (biomeManager && biomeManager.inhabitedShore && biomeManager._pass?.('inhabited-shore') !== false) {
      this.inhabitedShoreDraws++;
      // Heard time, like the rest of the world, so latency compensation
      // keeps the residents (and Broshi's kick hop) on the audible beat.
      const heardMs = sim.heardTimeMs ?? sim.timeMs;
      const cs = biomeManager.celestialState;
      const lit = cs?.activeBody ? cs[cs.activeBody] : null;
      const glitterX = lit && scenicMatrix
        ? (scenicMatrix.transformPoint({ x: lit.xFrac * stage.width, y: lit.yFrac * stage.height }).x - outputFit.x) / sxFixed - (camera.shakeX || 0)
        : null;
      ctx.save();
      // The fixed-ground transform (shake and roll) without the glacial
      // offset, shifted so nominal stage (0,0) is the frame's corner.
      applyFixedGroundTransform(ctx, { sx: sxFixed, sy: syFixed, width: nominalW, height: nominalH, camera,
        outputX: outputFit.x, outputY: outputFit.y });
      ctx.translate(SHAKE_MARGIN_PX, SHAKE_MARGIN_PX);
      drawInhabitedShore(ctx, {
        W: nominalW, H: nominalH, tSec: heardMs / 1000,
        bands: biomeManager._eqSmoothed, kick: kickHop01(recentConductorHits(sim.conductor?.timeline, heardMs), heardMs),
        airColor: biomeManager._airColor || '#2a3850', landColor: biomeManager._landTint || '#3a3024',
        haloColor: biomeManager.currentHaloColor(), night01: biomeManager.celestialState?.night01 ?? 0.5,
        celestial: cs, glitterX, reducedMotion: !!sim.reducedMotion, reducedFlash: !!sim.reducedFlash,
      });
      ctx.restore();
      // The flood rises over the shore, not under it, in the shore's own
      // (unshifted) frame: cancel the glacial ground offset.
      ctx.save();
      ctx.translate(0, -groundOffsetY);
      biomeManager._drawFlood(ctx, groundView.stage);
      ctx.restore();
      // Transition flashes cover the whole composed frame, shore included.
      biomeManager._drawTransitionOverlays(ctx, groundView.stage, null);
    }
    if (sim.battle && presentation.performers) this._drawBattleFX(ctx, sim);
    if (sim.gnat && presentation.performers) sim.gnat.draw(ctx, sim.timeMs);
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
    if (sim.keyDirector && presentation.performers) this._drawTranspositionWave(ctx, groundView.stage, sim.keyDirector);

    ctx.restore(); // camera transform

    // The opening assembly's target frame: grabbed right here, once, so it's
    // the clean world+characters composite -- not last frame's bloom/vignette
    // riding along, and not a HUD strip that hasn't drawn yet this frame.
    if (sim.assembly && sim.assembly.wantsCapture(sim.timeMs)) {
      this._captureSceneFrame(canvas, source => sim.assembly.captureFrame(source, sim.timeMs));
    }

    if (sim.fever && presentation.performers) this._drawFeverAura(ctx, viewStage, sim.fever.level, sim.biomes, sim.reducedFlash);
    if (sim.hype && presentation.performers) this._drawHypeFrame(ctx, viewStage, sim);
    // Drop impact pack: a chromatic shock + radial speed-lines from Midio,
    // both keyed off the same window as the shockwave rings -- drawn last so
    // they shock the fully composed frame, hype border and highway included.
    if (sim.hype && presentation.performers) this._drawDropImpact(ctx, viewStage, sim, pose);

    // Post FX that sample the pixel buffer need identity transform + full
    // physical canvas size (bloom / retro / freeze capture). Motion blur
    // first: the accumulation smears the fully composed frame (hype border
    // and drop impact included), and bloom then blooms the smeared result.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (presentation.performers) this._drawDropMotionBlur(ctx, canvas, sim, camera, sx, sy);
    this._drawBloom(ctx, canvas, sim, salience);
    // After bloom, not before: heat is a lens on the whole scene, so it
    // should bend the glow bloom just added too, not just the world under it.
    this._drawHeatDistortion(ctx, canvas, sim, pose, viewStage, outputFit);
    if (narrative || (sim.filmFinish && (perf ? perf.heavyPostFx : true))) {
      // Film finish was authored in logical space; scale its fill rects.
      ctx.setTransform(sx, 0, 0, sy, outputFit.x, outputFit.y);
      this._drawFilmFinish(ctx, viewStage, sim);
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
    if (sim.conductor && this.hudInFrame && !narrative) {
      const sxN = outputFit.scale;
      const syN = sxN;
      const nominalStage = this._nominalStageView
        || (this._nominalStageView = { width: nominalW, height: nominalH });
      nominalStage.width = nominalW;
      nominalStage.height = nominalH;
      ctx.setTransform(sxN, 0, 0, syN, outputFit.x, outputFit.y);
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
      this.composer.draw(ctx, nominalStage, sim.timeMs, {
        showLabels: !!(sim.showSectionLabels || sim.paramBus?.showSectionLabels),
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // The real range's name (RangeCaption.js). Not HUD chrome: it is part of
    // the picture, so it is drawn whether or not the HUD is in frame, and
    // recordings and bulk exports carry it.
    if (sim.rangeCaption || sim.rangeCaptions) {
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

    // The reassembling shards sit on top of the fully composed live frame
    // (HUD included) and dissolve away once landed, revealing whatever the
    // actually-live game looks like by then -- not a freeze, just a veil.
    if (sim.assembly && sim.assembly.active && presentation.performers) {
      ctx.setTransform(sx, 0, 0, sy, outputFit.x, outputFit.y);
      sim.assembly.draw(ctx, sim.timeMs);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    ctx.restore(); // fitted output clip
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawOutputBars(ctx, canvas, outputFit);

    if (fracture && fracture.isAboutToFreeze)
      this._captureSceneFrame(canvas, source => fracture.captureFreeze(source, sim.timeMs));

    // Semantic winners come from song evidence; only the current composed
    // frame can confirm that their producer was admitted and is visible.
    // captureFreeze has already consumed isAboutToFreeze, so retain its
    // actual capture frame separately from the immutable Finale time.
    if (sim.highlightReel) this._captureSceneFrame(canvas, source => {
      const heardMs = sim.heardTimeMs ?? sim.timeMs;
      const dropAgeMs = sim.timeMs - (sim.hype?.dropAtMs ?? -Infinity);
      const bloomVisible = (!!this._pixelGlowVisible || !!this._bloomA && !!this._bloomB) && biomeManager?.world?.kind !== 'alpine'
        && (perf?.bloomEnabled ?? true)
        && bloomStrength(sim.hype, sim.fever, !!sim.reducedFlash, sim.opening?.gain ?? 1, salience.bloom) > BLOOM_BASE + .005;
      const filmVisible = !!sim.filmFinish && (perf?.heavyPostFx ?? true) && biomeManager?._pass?.('film') !== false;
      sim.highlightReel.notify(highlightCandidatesFor(sim, sim.timeMs), source, heardMs, {
        frameTimeMs: sim.timeMs,
        producerTimeMs: sim.timeMs,
        isVisible: candidate => candidate.category === 'finale'
          ? !!fracture && (fracture.isAboutToFreeze || fracture.freezeMs === sim.timeMs && !!fracture.freezeFrame)
          : dropAgeMs >= 0 && dropAgeMs < 100 && sim.hype?.surge > 0 && (bloomVisible || filmVisible),
      });
    });
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

  /** The Key of the World: a kick-synced vertical chromatic wash, in the
   *  new tonic's hue, sweeping across the frame over a confirmed key change. */
  /** Compatibility entry point for old consumers; releases retired graphics. */
  _captureCastForReflections(ctx, sim, pose, biomeManager, perf, { drawMidioBody, drawBroshiBody, drawMidasusBody, voyageMul }) {
    this._capture?.dispose?.();
    this._capture = null;
    return { broshi: null, midio: null, midasus: null };
  }

  _drawTranspositionWave(ctx, canvas, keyDirector) {
    if (!keyDirector.transitionActive || !keyDirector.lastKeyChange) return;
    const hue = (((keyDirector.lastKeyChange.to % 12) + 12) % 12) * 30;
    const u = keyDirector.transitionProgress;
    const bandWidth = canvas.width * 0.55;
    const cx = -bandWidth + u * (canvas.width + bandWidth * 2);
    const alpha = Math.sin(Math.PI * u); // eases in and back out across the sweep
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(cx - bandWidth / 2, 0, cx + bandWidth / 2, 0);
    g.addColorStop(0, `hsla(${hue},80%,60%,0)`);
    g.addColorStop(0.5, `hsla(${hue},85%,65%,${(0.35 * alpha).toFixed(3)})`);
    g.addColorStop(1, `hsla(${hue},80%,60%,0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

  /** Drop shockwave: two expanding rings thrown from Midio on a detected drop. */
  _drawDropShockwave(ctx, canvas, sim, pose) {
    const hype = sim.hype;
    if (!hype) return;
    const u = hype.ringU(sim.timeMs);
    if (u == null) return;
    const cx = pose.midioDrawX, cy = sim.midio.groundY - 60;
    const maxR = Math.hypot(canvas.width, canvas.height) * 0.75;
    const focusMul = sim.focus ? sim.focus.mul('drop') : 1;
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(sim.reducedFlash);
    for (const [lag, alphaMul, lw] of [[0, 1, 3.5], [0.12, 0.5, 1.8]]) {
      const uu = u - lag;
      if (uu <= 0) continue;
      const r = maxR * (1 - (1 - uu) ** 2); // ease-out: it detonates, then coasts
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = capFlashAlpha((1 - uu) ** 2 * 0.55 * alphaMul * focusMul, sim.reducedFlash);
      ctx.lineWidth = lw + 10 * (1 - uu);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Battle enemies: angular wireframe glyphs (flyers wobble in the air,
   *  crawlers hug the ground), screen-locked like the characters -- world
   *  scroll doesn't apply to them, they live where they're drawn. */
  _drawBattleEnemies(ctx, sim) {
    const battle = sim.battle;
    const tSec = sim.timeMs / 1000;
    const nowMs = sim.timeMs;
    const SCALE = 1.5; // "slightly bigger" -- fewer, tougher, more visible
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of battle.enemies.active) {
      const bob = e.kind === 'flyer' ? Math.sin(tSec * 5 + e.bobPhase) * 8 : 0;
      // A recent stagger reads as a hot white flash that cools back to the
      // menace hue -- visible proof the hit landed without killing it.
      const sinceStagger = nowMs - e.staggerMs;
      const hot = clamp01(1 - sinceStagger / 220);
      const hue = e.locked ? 350 : 5; // faint menace, brightens once locked/targeted
      const light = 65 + 25 * hot;
      ctx.save();
      ctx.translate(e.sx, e.sy + bob);
      ctx.scale(SCALE, SCALE);
      ctx.strokeStyle = `hsla(${hue}, 70%, ${light}%, ${capFlashAlpha(0.8, sim.reducedFlash).toFixed(3)})`;
      ctx.lineWidth = 2 / SCALE;
      ctx.beginPath();
      if (e.kind === 'flyer') {
        const wingFlap = Math.sin(tSec * 14 + e.bobPhase);
        ctx.moveTo(0, -10);
        ctx.lineTo(9, wingFlap * 4);
        ctx.lineTo(0, 10);
        ctx.lineTo(-9, wingFlap * 4);
        ctx.closePath();
        ctx.moveTo(-9, 0); ctx.lineTo(9, 0);
      } else {
        ctx.moveTo(-10, 0);
        ctx.lineTo(-4, -9);
        ctx.lineTo(4, -9);
        ctx.lineTo(10, 0);
        ctx.lineTo(6, 4);
        ctx.lineTo(-6, 4);
        ctx.closePath();
        const leg = Math.sin(tSec * 16 + e.bobPhase) * 3;
        ctx.moveTo(-6, 4); ctx.lineTo(-6 + leg, 9);
        ctx.moveTo(6, 4); ctx.lineTo(6 - leg, 9);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /** Battle FX: muzzle glints, the dots of light in flight, and the
   *  vaporize bursts when they arrive exactly on the 16th-note beat. Drawn
   *  over all three characters so every shot reads as fired from them. */
  _drawBattleFX(ctx, sim) {
    const battle = sim.battle;
    const vNow = sim.timeMs - (sim.visualLagMs || 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const bezier = (u, x0, y0, lx, ly, tx, ty) => {
      const omu = 1 - u;
      return [
        omu * omu * x0 + 2 * omu * u * lx + u * u * tx,
        omu * omu * y0 + 2 * omu * u * ly + u * u * ty,
      ];
    };
    for (const d of battle.dots.active) {
      const u = clamp01((vNow - d.departMs) / Math.max(1e-6, d.travelMs));
      const e = battle.enemies.active.find((en) => en.id === d.enemyId);
      const tx = e ? e.sx : d.x0, ty = e ? e.sy : d.y0;
      const liftX = (d.x0 + tx) / 2, liftY = Math.min(d.y0, ty) - 30;
      const [x, y] = bezier(u, d.x0, d.y0, liftX, liftY, tx, ty);
      // Muzzle glint at departure.
      if (u < 0.15) {
        ctx.fillStyle = `rgba(255,245,200,${capFlashAlpha(0.6 * (1 - u / 0.15), sim.reducedFlash).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(d.x0, d.y0, 6, 0, Math.PI * 2); ctx.fill();
      }
      const [tailX, tailY] = bezier(Math.max(0, u - 0.08), d.x0, d.y0, liftX, liftY, tx, ty);
      ctx.strokeStyle = `rgba(255,250,210,${capFlashAlpha(0.9, sim.reducedFlash).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,235,${capFlashAlpha(1, sim.reducedFlash).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }

    for (const b of battle.bursts.active) {
      const t = b.age / b.life;
      const alpha = capFlashAlpha((1 - t) ** 2, sim.reducedFlash);
      ctx.strokeStyle = `rgba(255,235,190,${alpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      for (const s of b.shards) {
        const r = s.speed * b.age;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + Math.cos(s.ang) * r, b.y + Math.sin(s.ang) * r);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(255,255,240,${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, 14 * (1 - t), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** Film finish: the last cinematography pass before the HUD. A soft-light
   *  color grade wash (warm push when hot/high-budget, cool push when
   *  calm) drawn first, then a radial-gradient vignette on top -- grade-
   *  then-vignette matches a real post pipeline, where the vignette is a
   *  neutral lens artifact applied after grading. Neither channel ever
   *  spikes upward on a kick/drop (edgeAlpha only ever opens on hype,
   *  gradeAlpha has no percussive term at all), so this deliberately never
   *  routes through capFlashAlpha. */
  _drawFilmFinish(ctx, canvas, sim) {
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
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = heavy ? Math.min(0.22, gradeAlpha) * filmWeight * (narrative?.materials ?? 1) : 0;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    const depth = Math.min(1, ff.vignetteDepth * vigMul);
    const heardMs = sim.heardTimeMs ?? sim.timeMs;
    const hits = narrative ? recentConductorHits(sim.conductor?.timeline, heardMs) : [];
    const kick = hits.length ? hits[0].strength * Math.exp(-(heardMs - hits[0].tMs) / 180) : 0;
    const pressure = narrativePressure(narrative, kick, sim);
    const onset = narrative ? .56 - pressure.contraction : VIGNETTE_ONSET_MAX - (VIGNETTE_ONSET_MAX - VIGNETTE_ONSET_MIN) * depth;
    const filmEdge = heavy ? VIGNETTE_MIN_ALPHA + (VIGNETTE_MAX_ALPHA - VIGNETTE_MIN_ALPHA) * depth : 0;
    const edgeAlpha = narrative ? composedNarrativeEdge(pressure.edgeAlpha, filmEdge * narrative.skyDark) : filmEdge;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(cx, cy, outerR * onset, cx, cy, outerR);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${edgeAlpha.toFixed(3)})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /** Fever aura: above the threshold, the screen edges glow inward -- an
   *  inverse vignette (bright at the rim, clear toward center) so a hot
   *  streak visibly ignites the whole frame, not just Midio and the
   *  highway. Silent below FEVER_AURA_THRESHOLD; ramps to FEVER_AURA_MAX_ALPHA
   *  at fever=1. Tinted toward the current biome halo color so it reads as
   *  part of the world rather than a generic UI glow. */
  _drawFeverAura(ctx, canvas, fever, biomeManager, reducedFlash) {
    if (fever <= FEVER_AURA_THRESHOLD) return;
    const u = (fever - FEVER_AURA_THRESHOLD) / (1 - FEVER_AURA_THRESHOLD);
    const alpha = capFlashAlpha(FEVER_AURA_MAX_ALPHA * u, reducedFlash);
    if (alpha <= 0.002) return;
    const haloHex = biomeManager && biomeManager.currentHaloColor ? biomeManager.currentHaloColor() : '#ffd76a';
    const { r, g, b } = hexToRgb(haloHex);
    const rgb = `${r},${g},${b}`;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const outerR = Math.hypot(cx, cy);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(cx, cy, outerR * 0.55, cx, cy, outerR);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},${alpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /** Drop impact pack: a brief RGB-split shock (two color-isolated copies of
   *  the already-composited frame, nudged apart on the 'lighter' blend --
   *  same self-blit family as the hype echo and the lake reflection) plus
   *  radial speed-lines thrown from Midio. Both live only for
   *  DROP_IMPACT_LIFE_MS after hype.dropAtMs, and both skip entirely once
   *  PerfGovernor has shed particle budget -- this is squarely a "budget
   *  allowing" flourish, not core feedback. */
  _drawDropImpact(ctx, canvas, sim, pose) {
    const perf = sim.perf;
    if (perf?.particleMul < 1) {
      this._postBuffers?.release('shock'); this._shockCanvas = null;
      return;
    }
    const hype = sim.hype;
    // This IS the drop's own vocabulary, so folding focusMul into the
    // source strength scales every downstream alpha in this function at
    // once (the RGB-split shock and the speed-lines both derive from `s`).
    const s = dropImpactStrength(sim.timeMs, hype.dropAtMs) * (sim.focus ? sim.focus.mul('drop') : 1);
    if (s <= 0) return;
    const reducedFlash = !!sim.reducedFlash;

    // Chromatic shock — half-res offscreen: the RGB split is a soft additive
    // glow, so the upscale blur is actually desirable and saves 4x fill.
    const src = ctx.canvas;
    const shockScale = src.width > 1920 ? 2 : 1;
    const shockW = Math.round(src.width / shockScale);
    const shockH = Math.round(src.height / shockScale);
    if (this._postBuffers) {
      this._shockCanvas = this._postBuffers.ensure('shock', shockW, shockH);
      if (!this._shockCanvas) return;
    }
    if (!this._shockCanvas) this._shockCanvas = document.createElement('canvas');
    const off = this._shockCanvas;
    if (off.width !== shockW || off.height !== shockH) {
      off.width = shockW;
      off.height = shockH;
    }
    const offCtx = off.getContext('2d');
    // Reduced-flash halves the pixel split too -- what's left reads as
    // motion blur, not a flash, which is the whole point of the toggle.
    const offsetPx = (reducedFlash ? 0.5 : 1) * SHOCK_MAX_OFFSET_PX * s;
    const shockAlpha = capFlashAlpha(SHOCK_MAX_ALPHA * s, reducedFlash);
    for (const [color, dir] of [['rgba(255,60,60,1)', 1], ['rgba(60,220,255,1)', -1]]) {
      offCtx.globalCompositeOperation = 'copy';
      offCtx.drawImage(src, 0, 0, shockW, shockH);
      offCtx.globalCompositeOperation = 'multiply';
      offCtx.fillStyle = color;
      offCtx.fillRect(0, 0, shockW, shockH);
      ctx.save();
      ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
      ctx.globalAlpha = shockAlpha;
      // Device-pixel source back into the logical rect the transform expects,
      // shifted by a logical-space offset so the split is the same visual
      // width at every stage resolution.
      ctx.drawImage(off, dir * offsetPx, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    // Radial speed-lines from Midio.
    const count = Math.max(6, Math.round(SPEED_LINE_COUNT * (perf ? perf.particleMul : 1)));
    const maxR = Math.hypot(canvas.width, canvas.height) * 0.42;
    const cx = pose.midioDrawX, cy = sim.midio.groundY - 60;
    const segs = speedLineSegments(cx, cy, count, s, hype.dropCount, maxR);
    const lineAlpha = capFlashAlpha(SPEED_LINE_MAX_ALPHA * s, reducedFlash);
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(reducedFlash);
    ctx.strokeStyle = `rgba(255,255,255,${lineAlpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const seg of segs) {
      ctx.moveTo(seg.x0, seg.y0);
      ctx.lineTo(seg.x1, seg.y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Heat distortion: a UV-warp lens over the fully composed frame, for the
   *  two things in this world that are actually on fire -- a drop's shock
   *  wave and an active wildfire (FireDirector) or EMBER's own ambient
   *  ember-haze. Same offscreen-buffer-then-composite shape as bloom and the
   *  chromatic shock above, just used to WARP the source instead of ADD to
   *  it: copy the composited frame into a buffer, then redraw it back
   *  through a grid of overlapping sub-rectangles, each nudged by a small
   *  sinusoidal offset. A drop's offset is radial -- an expanding shockwave
   *  lens centered on Midio; a wildfire/ember's is a slow horizontal sway,
   *  strongest low in frame and fading toward the top (real heat haze bends
   *  light sideways as it convects upward off the ground, not the sky).
   *  Sheds under PerfGovernor pressure like its siblings -- a flourish,
   *  never core feedback. */
  _drawHeatDistortion(ctx, canvas, sim, pose, viewStage, outputFit = null) {
    const perf = sim.perf;
    if (perf && !perf.heavyPostFx) { this._postBuffers?.release('heat'); this._heatCanvas = null; return; }
    // Reduced motion: no animated whole-frame displacement at all. Fire
    // keeps its colour and light (drawn elsewhere); only the shimmer goes.
    if (sim.reducedMotion || this.pixelPolicy?.active && this.pixelPolicy.heatMaxOffset === 0) { this._postBuffers?.release('heat'); this._heatCanvas = null; return; }

    // A performer shock requires a visible performer. Landscape presentation
    // keeps fire and ember heat, whose visible owners remain in the scene.
    const dropS = sim.presentation?.performers && sim.hype && sim.biomes?.world?.kind !== 'alpine'
      ? dropImpactStrength(sim.timeMs, sim.hype.dropAtMs) : 0;
    const emberFxAlpha = sim.biomes && sim.biomes.currentFxAlpha ? sim.biomes.currentFxAlpha('emberGlow') : 0;
    const ambient = heatAmbient01(!!(sim.fire && sim.fire.active), sim.fire ? sim.fire.intensity01 : 0, emberFxAlpha);
    if (dropS <= 0.02 && ambient <= 0.02) return;

    const ampMul = sim.reducedFlash ? 0.5 : 1; // less pixel-shove, reads as haze not a jolt
    const pixelUnit = this.pixelPolicy?.active ? this.pixelPolicy.unit : 0;
    const dropAmpPx = HEAT_DROP_MAX_PX * dropS * ampMul * (pixelUnit || 1);
    const ambientAmpPx = HEAT_AMBIENT_MAX_PX * ambient * ampMul * (pixelUnit || 1);
    if (dropAmpPx < 0.15 && ambientAmpPx < 0.15) return;

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
    const cell = pixelUnit ? 8 * pixelUnit : HEAT_GRID_PX * (canvas.width > 2560 ? 2.2 : canvas.width > 1920 ? 1.6 : 1);
    const pad = pixelUnit || HEAT_PAD_PX;
    const picture = outputFit || { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const cols = Math.ceil(picture.width / cell);
    const rows = Math.ceil(picture.height / cell);
    const t = (pixelUnit ? (sim.heardTimeMs ?? sim.timeMs) : sim.timeMs) / 1000;
    // pose.midioDrawX / sim.midio.groundY are logical (viewStage) coords;
    // this pass runs post identity-reset against the full physical canvas,
    // so rescale by the same sx/sy the rest of draw() uses for that jump.
    const scaleX = viewStage && viewStage.width ? picture.width / viewStage.width : 1;
    const scaleY = viewStage && viewStage.height ? picture.height / viewStage.height : 1;
    const originX = picture.x + (pose ? pose.midioDrawX * scaleX : picture.width / 2);
    const originY = picture.y + (sim.midio ? sim.midio.groundY * scaleY : picture.height * 0.7);

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
        if (dropAmpPx > 0.05) {
          const dx = cx - originX, dy = cy - originY;
          const dist = Math.hypot(dx, dy);
          const nx = dist > 1e-3 ? dx / dist : 0, ny = dist > 1e-3 ? dy / dist : 0;
          const radial = Math.sin(dist / (pixelUnit || 1) * 0.05 - t * 9) * dropAmpPx;
          offX += radial * nx;
          offY += radial * ny;
        }
        if (ambientAmpPx > 0.05) {
          // Canvas Y grows downward. Reach full sway at the actual ground
          // in backing-store coordinates, with the weaker floor above it.
          const heightFrac = clamp01((cy - picture.y) / Math.max(1, originY - picture.y));
          offX += Math.sin((cx - picture.x) / (pixelUnit || 1) * 0.045 + t * 2.4 + (cy - picture.y) / (pixelUnit || 1) * 0.03) * ambientAmpPx * (0.35 + 0.65 * heightFrac);
        }
        if (pixelUnit) { offX = pixelHeatOffset(offX, { unit: pixelUnit }); offY = pixelHeatOffset(offY, { unit: pixelUnit }); }
        if (Math.abs(offX) < 0.05 && Math.abs(offY) < 0.05) continue; // no-op cell -- skip the blit entirely
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
   *  aurora bleeds green. Sheds under PerfGovernor pressure like the drop
   *  impact pack (a budget-allowing flourish, not core feedback). */
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
      sim.hype, sim.fever, !!sim.reducedFlash, sim.opening ? sim.opening.gain : 1,
      salience?.bloom ?? 1,
    );
    if (strength <= 0.005) return;

    if (this.pixelPolicy?.active) {
      this._postBuffers?.release('bloom'); this._bloomA = this._bloomB = null;
      this._pixelGlowVisible = drawPixelGlow(ctx, canvas, { buffers: this._postBuffers, unit: this.pixelPolicy.unit, strength, reducedFlash: !!sim.reducedFlash });
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

  /** The energy frame: a thin border that breathes with the track, slams on
   * kicks, and echoes the whole frame during a drop surge. Calm sections
   * nearly extinguish the idle rim and kick strobe (see hypeFrameStyle) so
   * quiet music doesn't flash the edges. */
  _drawHypeFrame(ctx, canvas, sim) {
    const hype = sim.hype;
    const color = sim.biomes && sim.biomes.currentHaloColor ? sim.biomes.currentHaloColor() : '#ffffff';
    const calmLevel = sim.calm ? sim.calm.level : 0;
    const style = hypeFrameStyle(hype, calmLevel);
    // This IS the drop's own vocabulary, so it reads full strength when
    // focus picks 'drop' and dampens like everything else otherwise.
    const focusMul = sim.focus ? sim.focus.mul('drop') : 1;

    // Frame echo: on hard hits the previous frame ghosts outward once.
    // The Reel: reduced-flash disables it outright (a rapid self-blit
    // ghost is exactly the kind of flash the toggle exists to remove).
    // Calm also kills most of the echo via hypeFrameStyle.
    const echo = sim.reducedFlash ? 0 : style.echo;
    // Same reasoning as the motion-blur ring: the echo re-blits the entire
    // composed frame, so it sheds on backing-store size, not draw calls.
    if (echo > 0.05 && (sim.perf ? sim.perf.fullFrameFxEnabled : true)) {
      const off = 3 + 5 * echo;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.12 * echo * focusMul;
      // `canvas` here is draw()'s LOGICAL stage view -- a plain
      // {width, height}, not a drawable. Passing it to drawImage threw every
      // time this branch ran, and because main.js wraps the whole draw in a
      // try/catch, the throw silently took the entire rest of the frame with
      // it: the drop-impact pack, bloom, the film finish and the HUD strip
      // all vanished for that frame. On hard hits, which is precisely when
      // the echo fires. The source is the real backing store; the
      // destination rect is in logical units because we are under the sx/sy
      // transform, which maps it back 1:1.
      ctx.drawImage(ctx.canvas, this._echoFlip ? off : -off, 0, canvas.width, canvas.height);
      ctx.restore();
      this._echoFlip = !this._echoFlip;
    }

    if (style.alpha < 0.02) return; // fully calm, no rim stroke
    ctx.save();
    ctx.globalCompositeOperation = flashCompositeOp(sim.reducedFlash);
    ctx.strokeStyle = color;
    ctx.globalAlpha = capFlashAlpha(style.alpha * focusMul, sim.reducedFlash);
    ctx.lineWidth = style.lineWidth;
    const inset = style.inset;
    ctx.beginPath();
    ctx.roundRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2, 14);
    ctx.stroke();
    ctx.restore();
  }

  /** Drop motion blur: a 2-3 frame accumulation over the fully composed
   *  frame, fired only inside the drop's impact window while the camera is
   *  actually traveling -- the same self-blit family as the hype frame echo
   *  above, but blended as an exposure (source-over, ghosts trailing the
   *  motion) instead of an additive flash, and over two frames of history
   *  rather than one. Capture runs every frame (a single blit) so the ring
   *  is warm the instant a drop lands; the composite only runs in-window.
   *  Gated like the echo: reduced-flash disables it outright, perf pressure
   *  skips the ring entirely (and frees it). Runs at identity transform on
   *  the physical backing store; `stageSx/stageSy` convert the camera's
   *  logical travel into physical px. */
  _drawDropMotionBlur(ctx, canvasEl, sim, camera, stageSx, stageSy) {
    // Camera travel this frame, logical px. The first frame of a session has
    // no previous position to difference against: travel 0, no smear. Tracked
    // before the gates below so a mid-song perf shed (which skips this whole
    // method) can't leave a stale last position behind -- the frame the
    // feature recovers on would otherwise read a huge spurious velocity.
    const vx = this._lastShakeX == null ? 0 : camera.shakeX - this._lastShakeX;
    const vy = this._lastShakeY == null ? 0 : camera.shakeY - this._lastShakeY;
    this._lastShakeX = camera.shakeX;
    this._lastShakeY = camera.shakeY;

    const perf = sim.perf;
    // fullFrameFxEnabled, not heavyPostFx: this pass copies the WHOLE
    // composed frame every frame of the song, so its cost scales with the
    // backing store rather than with draw calls. Profiled at a 3840x2160
    // stage it was 23% of wall time -- the single most expensive thing in
    // the frame -- while sitting on the ladder's LAST rung, so a 4K machine
    // shed its vision loop, particles, rim light, bloom, the veil and the
    // entire phenomena layer before ever reaching it. The new gate sheds it
    // first at that size and is identical to the old one at 1080p and below.
    if (perf && !perf.fullFrameFxEnabled || sim.reducedFlash || sim.reducedMotion) {
      this._postBuffers?.release('motion');
      this._motionHistory = null;
      return;
    }

    // The ring captures at reduced resolution -- see postFxDownscale. This
    // is not the drop shock's situation (a single-frame effect that only
    // runs near a drop, so a full-resolution copy above 1920px was cheap
    // enough to leave alone): the capture below runs on EVERY frame for the
    // entire song, not just the ~320ms window the ghosts themselves are
    // ever visible in, because the ring has to already hold real content by
    // the moment a drop lands (see the capture comment below). Measured as
    // the single most expensive draw call in the whole frame at 1080p --
    // reported as 2-3fps on a flagship phone, ~94ms of a ~107ms frame in
    // this one pass alone, dwarfing bloom, the film finish and every
    // character draw combined. The ghost is blended at <=0.30 alpha and
    // already offset from the live frame, so the softening a
    // downsample-then-upsample gives it for free (the same trick bloom
    // already uses one pass up) costs nothing visible -- if anything it
    // reads more like exposure smear than a sharp duplicate would have.
    const scale = postFxDownscale(canvasEl.width);
    const histW = Math.max(1, Math.round(canvasEl.width / scale));
    const histH = Math.max(1, Math.round(canvasEl.height / scale));

    // (Re)allocate the ring if the backing store (or its downscale) changed.
    let history = this._motionHistory;
    if (!history || !history[0] || history[0].width !== histW || history[0].height !== histH) {
      history = this._postBuffers ? this._postBuffers.ensure('motion', histW, histH, 3) : [0, 1, 2].map(() => {
        const c = document.createElement('canvas'); c.width = histW; c.height = histH; return c;
      });
      if (!history) { this._motionHistory = null; return; }
      this._motionHistory = history;
      this._motionRing = 0;
    }
    if (history.some(c => !c)) { this._motionHistory = null; return; }

    const hype = sim.hype;
    const strength = hype
      ? dropMotionBlurStrength(sim.timeMs, hype.dropAtMs, Math.hypot(vx, vy))
      : 0;
    // This IS the drop's own vocabulary, so it reads full strength when
    // focus picks 'drop' and dampens like everything else otherwise.
    const focusMul = sim.focus ? sim.focus.mul('drop') : 1;

    // Ghost offsets run AGAINST the camera's travel: raising shakeX shifts
    // content right, so frame t-k's content sits k*vx px to the LEFT of where
    // it is now -- exactly where a real exposure would have accumulated it.
    // Computed in full backing-store px (stageSx/stageSy already scale from
    // logical space), which is also the space the upscaled composite below
    // draws into -- the downscale is purely an internal storage detail of
    // the ring, invisible to the offset math on either side of it.
    const passes = dropMotionBlurPasses(strength * focusMul, -vx * stageSx, -vy * stageSy);

    // Capture the current frame FIRST, before any ghost is composited onto
    // the live canvas -- the ring must only ever hold clean composed frames,
    // or frame t's smear would re-enter as frame t+1's history and compound
    // with itself across the window. The ghosts read sibling slots, so this
    // capture never clobbers what they're about to draw.
    const slot = history[this._motionRing];
    const sctx = slot.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, slot.width, slot.height);
    sctx.drawImage(canvasEl, 0, 0, slot.width, slot.height);

    if (passes.length > 0) {
      // Ring bookkeeping: slot (ring+2)%3 was written last frame (t-1),
      // slot (ring+1)%3 two frames ago (t-2); slot ring was just recaptured.
      const ring = this._motionRing;
      const ghosts = [history[(ring + 2) % 3], history[(ring + 1) % 3]];
      for (let i = 0; i < passes.length; i++) {
        ctx.save();
        ctx.globalAlpha = passes[i].alpha;
        ctx.drawImage(
          ghosts[i], 0, 0, ghosts[i].width, ghosts[i].height,
          passes[i].dx, passes[i].dy, canvasEl.width, canvasEl.height,
        );
        ctx.restore();
      }
    }
    this._motionRing = (this._motionRing + 1) % 3;
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

  /** One contact-shadow ellipse. 'multiply' darkens whatever terrain color
   *  sits underneath instead of flattening it to a fixed gray. */
  _drawContactShadow(ctx, s) {
    if (s.alpha <= 0.002 || s.rx <= 0.5) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(s.cx, s.cy, Math.max(0.5, Math.min(s.rx, s.ry) * 0.2), s.cx, s.cy, Math.max(s.rx, s.ry));
      g.addColorStop(0, `rgba(10,10,18,${s.alpha.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(10,10,18,${(s.alpha * 0.42).toFixed(3)})`);
      g.addColorStop(1, 'rgba(10,10,18,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle = '#0a0a12';
    }
    ctx.beginPath();
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawMidio(ctx, pose, performer, tSec = 0, melt = 0, apotheosis = null, reducedFlash = false, baseHue = MIDIO_IDENTITY_HUE, ensemble = null, lights = null, focusMul = 1, gaze = null, beatPhase01 = null) {
    const flash = performer ? performer.goldFlash : 0;
    const blink = performer ? performer.blinkScale : 1;
    const apoProgress = apotheosis ? apotheosis.progress : 0;
    // A slow ambient breath plus a quick kick-synced swell -- the same
    // "always slightly alive" pulse that makes Midasus's core read as an
    // instrument rather than a static glyph.
    const breatheBeatFlash = performer ? performer.beatFlash : 0;
    // Shared build-up swell (EnsembleDirector.swell): during a crescendo,
    // beat-phased with the same Kuramoto clock Broshi/Midasus read too, so
    // the trio visibly swells together rather than each pulsing in
    // isolation. 1 (no-op) outside a build-up.
    const swell = ensemble ? ensemble.swell(0) : 1;
    const breathe = (1 + 0.025 * Math.sin(tSec * 2.4) + 0.05 * breatheBeatFlash) * swell;
    // Always-on motion (MidioMotion.js): he hovers and precesses whether or
    // not anything is happening, which is what makes him a sibling of
    // Midasus and Broshi rather than the one standing still between events.
    // Applied HERE, in the draw transform only -- pose.midioY stays the true
    // physical position, so the jump reads unchanged and his contact shadow
    // stays anchored to the ground instead of bobbing with the float (which
    // is what actually sells the hover).
    // Reduced-flash is the accessibility setting for exactly this, so it
    // scales the whole thing to rest.
    const motionScale = reducedFlash ? 0.25 : 1;
    // beatPhase01 comes from BeatAnchor at the call site -- the same grid
    // every kick-quantized thing in the show already hangs off, so the pulse
    // stays in step through tempo changes without its own tracking. Null when
    // there is no usable grid yet, and midioMotion then returns a pulse of
    // exactly 1: a pulse off the beat is worse than no pulse.
    const motion = midioMotion(tSec, clamp01(melt / 8), motionScale, beatPhase01);
    const pulse = motion.pulseScale;
    const transform = {
      tx: pose.midioDrawX, ty: pose.midioY + motion.hoverPx,
      rot: ((pose.leanDeg + motion.precessDeg) * Math.PI) / 180,
      scaleX: pose.scaleX * MIDIO_DRAW_SCALE * breathe * pulse * (1 + 0.25 * apoProgress),
      scaleY: pose.scaleY * MIDIO_DRAW_SCALE * breathe * pulse * (1 + 0.25 * apoProgress),
      // Rare shared transition tumble (see EnsembleDirector.maybeTumble) --
      // 0 outside of a move, so this is a no-op almost all the time.
      rotX: ensemble ? ensemble.rotX(0) : 0,
      rotY: ensemble ? ensemble.rotY(0) : 0,
    };
    // Midasus style: he wears his eased spectral key-hue (baseHue); the
    // milestone gold flash still ignites him toward gold (48) on top of it.
    const hue = flash > 0 ? easeHueDeg(baseHue, REWARD_HUE, flash) : baseHue;
    // Pale, bright -- the same "pale, never candy" treatment Midasus's
    // core uses, not the old narrow near-white gold. The color law: his
    // hue itself (baseHue, above) stays MIDIO_IDENTITY_HUE even through
    // the Apotheosis -- only saturation/lightness climb with it now.
    const dials = this._styleDials || styleDials('classic');
    const options = {
      satBase: 32 + flash * 40 + 18 * apoProgress,
      lightBase: 72 + flash * 12 + 8 * apoProgress,
      widthBase: dials.widthBase,
      widthGlow: dials.widthGlow,
      rimAmount: dials.rimAmount,
      // Movement VII: the celestial (and, per LightField's secondary
      // sources, a nearby kick-glow pulse or Midasus's own core) actually
      // lights him now instead of this array only ever being computed.
      lights,
    };
    const outlineOpts = { widthAdd: dials.outlineWidthAdd };

    // Modal vibration: rim vertices ride the performer's ring-down field.
    // Rest lengths stay the undisplaced ones, so the wobble reads as edge
    // deformation and lights up the glow automatically. Below the morph
    // threshold this stays on the original 9-rim MIDIO_BODY untouched;
    // the Apotheosis swaps in the 18-rim folded/unfolded blend, whose own
    // lengthening edges (relative to the FOLDED rest lengths) add the
    // unfolding glow on top of the modal one.
    const hub = MIDIO_BODY.vertices[0];
    const bodyBase = apoProgress > 0.001 ? lerpMesh(MIDIO_APOTHEOSIS_FOLDED, MIDIO_APOTHEOSIS_UNFOLDED, apoProgress) : MIDIO_BODY;
    const bodyRest = apoProgress > 0.001 ? this._apoBodyRest : this._midioBodyRest;
    const bodyMesh = meltMesh(
      displaceMeshRadial(bodyBase, hub.x, hub.y, performer ? performer.modal : null),
      hub.x, hub.y, tSec, melt, 1,
    );

    // Stellar under-glow (Midasus's own trick): a blurred, larger, additive
    // copy of the body drawn first so he reads like an instrument catching
    // light, not a flat outline -- brighter on fever and right on the beat.
    const excitement = clamp01(melt / 8); // vibe/fever/apotheosis "melt" doubles as how hard he's glowing
    const glowAlpha = capFlashAlpha(
      (0.14 + 0.22 * excitement + 0.28 * breatheBeatFlash) * dials.glowHaloMul * focusMul,
      reducedFlash,
    );
    if (glowAlpha > 0.02) {
      const glowCenter = applyTransform(hub, transform);
      drawGlowHalo(
        ctx, glowCenter.x, glowCenter.y,
        24 * transform.scaleX, 30 * transform.scaleY,
        hue, glowAlpha, { sat: 38, light: 74 },
      );
    }
    // The crisp pass carries an ink contour underneath so his silhouette
    // stays razor-edged against his own under-glow (and soft sculpted fill).
    drawMeshPart(ctx, bodyMesh, bodyRest, transform, hue, { ...options, outline: outlineOpts });

    // The iris leans toward whatever Gaze picked this step (the incoming
    // obstacle, Midasus, or the celestial), scaled by blink * openness --
    // the same offset-from-hub scale blink alone used to own, generalized
    // so a closing eye also neutralizes gaze (nothing to look at while
    // shut) and an anticipation/flinch pulse widens the socket a little.
    // The moved iris's own edge naturally reads a touch brighter too (its
    // length now differs from MIDIO_EYE's neutral rest length) -- a free
    // "caught the light" cue that needed no extra code.
    const gazeOpen = gaze ? gaze.openness : 1;
    const eyeScale = blink * gazeOpen;
    const iris = gaze ? gaze.irisOffset(MIDIO_EYE_SOCKET_R) : { x: 0, y: 0 };
    if (eyeScale < 0.999 || iris.x !== 0 || iris.y !== 0) {
      const liveEye = midioEyeMesh(iris.x * eyeScale, iris.y * eyeScale);
      drawMeshPart(ctx, liveEye, this._midioEyeRest, transform, hue, { ...options, outline: outlineOpts });
    } else {
      drawMeshPart(ctx, MIDIO_EYE, this._midioEyeRest, transform, hue, { ...options, outline: outlineOpts });
    }

    // The gyre: three motes orbiting his core, turning continuously and
    // AGAINST the body's precession. This is the term that reads as
    // "powered" rather than merely "adrift" -- the same job Midasus's
    // orbiting baby stars do for her, in the same visual vocabulary, and
    // the reason it lives out here instead of on the eye is that the eye
    // carries Gaze: a spinning pupil would be pointing at nothing.
    // Three short arcs, so it costs a rounding error next to the body's
    // own glow passes.
    if (motionScale > 0.01) {
      const spin = (motion.coreSpinDeg * Math.PI) / 180;
      const rBase = MIDIO_EYE_SOCKET_R * 2.9;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const a = -spin + (i * Math.PI * 2) / 3;
        // Elliptical, so the ring reads as a tilted orbit rather than a
        // flat circle stuck to the screen.
        const ox = Math.cos(a) * rBase;
        const oy = Math.sin(a) * rBase * 0.42 + MIDIO_EYE_CY;
        const p = applyTransform({ x: ox, y: oy }, transform);
        const depth = 0.55 + 0.45 * Math.sin(a); // far side dims
        ctx.globalAlpha = capFlashAlpha(0.5 * depth * focusMul * motionScale, reducedFlash);
        ctx.strokeStyle = `hsl(${hue} 70% 82%)`;
        ctx.lineWidth = 1.6 * depth;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(a + Math.PI / 2) * 3.4, p.y + Math.sin(a + Math.PI / 2) * 1.6);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Kick ignition: the sigil flashes additively right on the beat.
    const beatFlash = performer ? performer.beatFlash : 0;
    if (beatFlash > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawMeshPart(ctx, bodyMesh, this._midioBodyRest, transform, hue, {
        alpha: capFlashAlpha(0.65 * beatFlash, reducedFlash), satBase: 70, lightBase: 74, widthBase: 2.4,
      });
      ctx.restore();
    }

    // Hold-slide charge: beatFlash's additive shape, but sustained — it
    // lights when a hold arms and brightens with every paid tick.
    const holdGlow = performer ? performer.holdGlow : 0;
    if (holdGlow > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawMeshPart(ctx, bodyMesh, this._midioBodyRest, transform, hue, {
        alpha: capFlashAlpha(0.5 * holdGlow, reducedFlash), satBase: 80, lightBase: 70, widthBase: 2.0,
      });
      ctx.restore();
    }
  }

  /** Motion-streak ghosts trailing a fast jump (follow-up item 6). */
  _drawMidioAfterimages(ctx, performer, midioX, baseHue = MIDIO_IDENTITY_HUE) {
    const frames = performer.afterimages;
    const n = frames.length;
    if (n === 0) return;
    ctx.save();
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const alpha = 0.28 * ((i + 1) / n);
      ctx.globalAlpha = alpha;
      drawMeshPart(ctx, MIDIO_MESH, this._midioRestLengths, {
        tx: midioX, ty: f.y, rot: (f.rot * Math.PI) / 180,
        scaleX: f.scaleX * MIDIO_DRAW_SCALE, scaleY: f.scaleY * MIDIO_DRAW_SCALE,
      }, baseHue, { alpha: 1, satBase: 22, lightBase: 64 });
    }
    ctx.restore();
  }

  /** Apotheosis-only: gold, beat-quantized afterimages (captured on every
   * kick while transformed, independent of MidioPerformer's airborne-only
   * trick-jump streaks above). */
  _drawGoldAfterimages(ctx, performer, midioX, nowMs) {
    const frames = performer.goldAfterimages;
    if (!frames.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of frames) {
      const age = clamp01((nowMs - f.bornMs) / GOLD_AFTERIMAGE_LIFE_MS);
      const alpha = 0.4 * (1 - age);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      drawMeshPart(ctx, MIDIO_MESH, this._midioRestLengths, {
        tx: midioX, ty: f.y, rot: (f.rot * Math.PI) / 180,
        scaleX: f.scaleX * MIDIO_DRAW_SCALE, scaleY: f.scaleY * MIDIO_DRAW_SCALE,
      }, REWARD_HUE, { alpha: 1, satBase: 85, lightBase: 68 });
    }
    ctx.restore();
  }
}

/**
 * Music-reactive bloom strength: a small steady base (a lit scene always
 * catches a little light, not a flash -- never capped by reduced-flash)
 * plus a reactive swell from the same signals that already throw the drop
 * shockwave and the fever aura (HypeDirector.slam/surge, FeverMeter.level).
 * Only the reactive term runs through capFlashAlpha, so reduced-flash tames
 * the pulsing on drops/kicks while the base glow stays intact. Clamped to
 * BLOOM_MAX so a maxed-out drop-during-fever never blows the frame out.
 */
export function bloomStrength(hype, fever, reducedFlash = false, openingGain = 1, supportingBloomMul = 1) {
  const slam = hype ? hype.slam : 0;
  const surge = hype ? hype.surge : 0;
  const feverLevel = fever ? fever.level : 0;
  const reactive = 0.25 * capFlashAlpha(0.45 * slam + 0.35 * surge + 0.3 * feverLevel, reducedFlash);
  // The base glow is unconditional, which meant a song fading in from silence
  // still opened on a fully bloomed frame -- the single loudest thing on
  // screen at t=0, and the one least justified by anything audible.
  // OpeningDirector's gain scales it until the song has actually started.
  // The reactive term belongs to an earned hit; only the resting spill has
  // to yield when another subject owns the frame.
  return Math.min(BLOOM_MAX, BLOOM_BASE * openingGain * clamp01(supportingBloomMul) + reactive);
}

/** Drop impact envelope: 1 right at the drop, easing to 0 over
 *  DROP_IMPACT_LIFE_MS. 0 before the drop or once it's long past --
 *  dropAtMs starts at -Infinity (HypeDirector), so "no drop yet" is 0 too. */
export function dropImpactStrength(nowMs, dropAtMs) {
  const age = nowMs - dropAtMs;
  if (!(age >= 0) || age >= DROP_IMPACT_LIFE_MS) return 0;
  const u = age / DROP_IMPACT_LIFE_MS;
  return (1 - u) * (1 - u); // ease-out: sharp at the hit, tapering fast
}

/** Drop motion blur envelope: the drop impact window, scaled by how fast
 *  the camera is actually traveling (logical px/frame) -- no shake travel,
 *  no smear, whatever the music is doing. Saturates at
 *  MOTION_BLUR_SPEED_REF_PX so the hardest shakes all read full strength.
 *  Pure so it's testable without a canvas. */
export function dropMotionBlurStrength(nowMs, dropAtMs, shakeSpeedPx) {
  const impact = dropImpactStrength(nowMs, dropAtMs);
  if (!(impact > 0)) return 0;
  return impact * (0.35 + 0.65 * clamp01(shakeSpeedPx / MOTION_BLUR_SPEED_REF_PX));
}

/** Per-history-frame draw list for the accumulation composite: up to two
 *  ghosts (frames t-1, t-2), each offset further along the camera's travel
 *  and fainter with age. [] when too weak to bother -- the caller skips the
 *  composite but still captures, keeping the ring warm. Pure and
 *  deterministic so the offsets/alphas are testable without a canvas. */
export function dropMotionBlurPasses(strength, vxPx, vyPx) {
  if (!(strength > 0)) return [];
  const passes = [];
  for (let k = 1; k <= MOTION_BLUR_GHOST_ALPHA.length; k++) {
    const alpha = strength * MOTION_BLUR_GHOST_ALPHA[k - 1];
    if (alpha <= MOTION_BLUR_MIN_ALPHA) break; // older ghosts only get fainter
    passes.push({ dx: vxPx * k, dy: vyPx * k, alpha });
  }
  return passes;
}

/** 0..1 ambient heat level driving the wildfire/ember side of the heat
 *  distortion (the drop side is dropImpactStrength, unrelated). An active
 *  FireDirector strike drives this directly by its own intensity01; absent
 *  that, EMBER's ambient fx alpha contributes a capped, gentler haze -- a
 *  mood, not a blaze. Pure so it's testable without a canvas. */
export function heatAmbient01(fireActive, fireIntensity01 = 0, emberFxAlpha = 0) {
  const fire = fireActive ? clamp01(fireIntensity01) : 0;
  return clamp01(Math.max(fire, clamp01(emberFxAlpha) * EMBER_AMBIENT_LEVEL));
}

/** `count` line segments radiating from (cx, cy), angles fixed per `seed`
 *  (a drop's own dropCount, so repeat drops don't all fan out identically),
 *  each spanning [0.55, 0.75+0.25*s] of maxR -- pure and deterministic so
 *  it's cheaply testable without a canvas. */
export function speedLineSegments(cx, cy, count, s, seed, maxR) {
  const segs = [];
  const jitterBase = seed * 2.399963; // irrational-ish stride so lines don't repeat between drops
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + jitterBase;
    const rInner = 0.55 * maxR;
    const rOuter = (0.75 + 0.25 * s) * maxR;
    segs.push({
      x0: cx + Math.cos(a) * rInner, y0: cy + Math.sin(a) * rInner,
      x1: cx + Math.cos(a) * rOuter, y1: cy + Math.sin(a) * rOuter,
    });
  }
  return segs;
}
