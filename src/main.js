import { resizeStageCanvas } from './render/CanvasResidency.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from './world/RidgeMotionHistory.js';
// Bootstrap: file loading UI, audio-clock-driven game loop (spec §6.1).
import { Conductor } from './core/Conductor.js';
import { advanceFixedStepClock } from './core/FixedStepClock.js';
import { ParamBus } from './core/ParamBus.js';
import { synthesizeEnergyCurves } from './core/EnergyCurvesSynth.js';
import { buildDemoSong } from './core/DemoSong.js';
import { audioToTimeline } from './audio/AudioAdapter.js';
import {
  OPENING_SECONDS, asOpening, buildAudioOverview, sliceAudioBuffer, useOpeningAnalysis,
} from './audio/OpeningAnalysis.js';
import {
  AUDIO_LOAD_LIMITS, accumulateDecodedAudioBytes, accumulateDecodedByteLength,
  accumulateEncodedAudioBytes, audioAbortError, throwIfAborted, validateAudioFiles,
  validateDecodedAudioBuffer, validateDecodedByteLength,
} from './audio/loadLimits.js';
import { Simulation } from './sim/Simulation.js';
import { resolveRendererMode } from './render/WebGLRenderer.js';
import { graphicsReport } from './render/GraphicsDiagnostics.js';
import { hitTestComposerStrip } from './render/Renderer.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { SimpleSynth } from './audio/SimpleSynth.js';
import { Sf2Synth } from './audio/Sf2Synth.js';
import { SoundfontLibrary, SynthRouter } from './audio/SoundfontLibrary.js';
import { FontRecommender } from './audio/FontRecommender.js';
import { VisionLoop } from './vision/VisionLoop.js';
import { DebugOverlay } from './ui/DebugOverlay.js';
import { FileChooserSupport } from './ui/FileChooserProbe.js';
import { prepareSongTerrain } from './world/terrain/RangeLibrary.js';
import {
  ASK as ASK_WORLD, AUTO as TITLE_AUTO, readTitleWorld, resolveTitleWorldChoice, writeTitleWorld,
} from './ui/TitleWorldChoice.js';
// How long a title-screen world choice waits for the song's range to load
// before starting anyway on the bundled Tetons.
const RANGE_WAIT_MS = 1500;
import {
  openAudioUrl, UrlAudioError, fetchAudioAsFile, classifyUrl,
} from './net/UrlAudioSource.js';
import { RecalibrationOverlay } from './ui/RecalibrationOverlay.js';
import { rangeCaptionFor, sceneCaptionFor, captionAt, CAPTION_DELAY_MS } from './ui/RangeCaption.js';
import { setCaptionDetails } from './ui/PixelCaption.js';
import { pixelRenderPolicy } from './render/PixelRenderPolicy.js';
import { realBiomeByName, ecoregionOfRange } from './world/RealBiomes.js';
import { travelMs } from './world/BiomeSchedule.js';
import { noteRangeShown } from './world/terrain/RangeHistory.js';
import { groundSpeedMps } from './world/terrain/ProfileTravel.js';
import { TERRAIN_STRIP_WIDTH } from './world/terrain/StripRead.js';
import { DrawErrorLog } from './render/DrawErrorLog.js';
import { ROLE_LOW, ROLE_HIGH, GrooveFingerprint } from './sim/GrooveFingerprint.js';
import { generateCustomBiomeFromMidi, rememberCustomBiome } from './world/BiomeImporter.js';
import {
  getReducedFlash, setReducedFlash, getReducedMotion, setReducedMotion, getLyricsDisabled, setLyricsDisabled,
  getBtLatencyTrimMs, setBtLatencyTrimMs, BT_LATENCY_TRIM_MS,
  getStoredGroove, setStoredGroove,
} from './ui/Accessibility.js';
import { getVisualStyle, resolveVisualStyle } from './render/VisualStyle.js';
import { PerfGovernor, resolvePerfStartLevel, MAX_LEVEL as PERF_MAX_LEVEL } from './render/PerfGovernor.js';
import { sharedResidency } from './render/GraphicsResidency.js';
import { RangePresentation, resolveRangeMode } from './world/alpine/RangePresentation.js';
import { rangeTourControlState } from './ui/RangeTourControl.js';
import { residencyBudgetFor } from './render/GraphicsResidency.js';
import { shouldSuggestLandscape } from './render/StagePresets.js';
import { createPresentingRenderer } from './render/PresentingRenderer.js';
import { PixelPresentation, fitPixelRect } from './render/PixelPresentation.js';
import { FrameCadence } from './render/FrameCadence.js';
import { readDisplayPrefs, writeDisplayPrefs, resolvePresentation, resolveDisplayPrefs } from './render/DisplayProfile.js';
import { emaFps, resolveFpsHudVisible, PresentedFpsMeter } from './render/FpsMeter.js';
import { LoadingShow } from './ui/LoadingShow.js';
import { TitleBackdrop } from './ui/TitleBackdrop.js';
import { clientToStageCoords } from './ui/StageCoords.js';
import {
  KeepAwake, shouldAbsorbTap, isSystemFullscreenDrop, isDisplaySleepGap,
} from './ui/KeepAwake.js';
import { cssVarMap } from './render/spectral.js';
import { resolveDurationMs } from './core/SongDuration.js';
import { formatSeed, parseSeed, resolveSongSeed } from './utils/seed.js';
import { groundLyrics, hasUsableLyrics } from './lyrics/LyricGrounding.js';
import { fetchLyricsCached } from './lyrics/LyricsClient.js';
import { toBlocks, labelBlocks } from './lyrics/LyricStructure.js';
import { isVocalStemName, vocalActivity, syllableOnsets, alignBlocks } from './lyrics/StemAlign.js';
import { visualNow, VISUAL_LEAD_MS } from './core/ChoreoClock.js';
import { CaptureClock } from './core/CaptureClock.js';
import {
  SyncCalibrator, syncStatusText, syncResultText, positiveTrimCeilingMs, beatPulse01,
  PHASE_EAR, PHASE_EYE,
} from './sim/SyncCalibrator.js';
import { buildWorldVariant, scoreWorlds, pickRecommended, formatFitDiagnostic } from './world/WorldScore.js';
import { buildSongProfile, PROFILE_VERSION } from './audio/SongProfile.js';
import {
  DEFAULT_WORLD_ID, setCustomWorld, clearCustomWorld, getCustomWorld, getWorld, listWorlds, resolveWorldId,
} from './world/Worlds.js';
import { buildWorldChoices, moveChoiceIndex } from './ui/WorldChooser.js';
import {
  PreviewSession, loadPreviewRenderer,
} from './ui/WorldPreview.js';
import { fingerprintBufferOffThread } from './audio/FingerprintWorkerClient.js';
import { readVisionConfig, persistVisionConfig } from './vision/config.js';
import { packBundle, unpackBundle } from './audio/AnalysisBundle.js';
import { analysisCacheKey, getBundle, putBundle } from './audio/AnalysisCache.js';
import { SongRecorder } from './render/SongRecorder.js';
import {
  RENDER_PRESETS, DEFAULT_PRESET_ID, presetById, reachSummary, estimateBytes,
  formatBytes, formatElapsed, exportFileName, describeResult,
} from './render/VideoExport.js';
import { stepExportClock, evenExportSize } from './render/BulkExport.js';
import { rangeUserCamera } from './world/alpine/RangeCamera.js';
import { attachRangeZoomInput } from './ui/RangeZoomInput.js';
import { MusicLibrary } from './library/MusicLibrary.js';
import { LibraryPanel } from './ui/LibraryPanel.js';
import { createAudioSelection } from './audio/AudioSelection.js';
import { normalizeSourceMetadata } from './audio/SourceMetadata.js';
import {
  resolveAudioIdentity, sessionSongName, adoptAudioSessionAnalysis, adoptAudioSessionLyrics,
} from './audio/AudioSessionIdentity.js';
import { PlexSource } from './net/PlexSource.js';
import { PlexLibraryPanel } from './ui/PlexLibraryPanel.js';
import { recentlyPlayed, displayTitle, displayArtist, untaggedTracks } from './library/TrackIndex.js';


const STEP_MS = 1000 / 120;

const canvas = document.getElementById('stage');
const errorBannerEl = document.getElementById('errorBanner');
const errorBannerTextEl = document.getElementById('errorBannerText');
const errorBannerCloseEl = document.getElementById('errorBannerClose');
let errorBannerTimer = null;
/** The one user-facing failure surface for this whole app -- replaces the
 *  five native alert() calls that used to dump raw exception text into a
 *  browser dialog. Auto-dismisses after a while but stays reachable via
 *  the close button; a second failure just restarts the timer/text rather
 *  than stacking banners. */
function showErrorBanner(message) {
  if (!errorBannerEl || !errorBannerTextEl) { window.alert(message); return; } // defensive: markup missing
  errorBannerTextEl.textContent = message;
  errorBannerEl.classList.remove('hidden');
  clearTimeout(errorBannerTimer);
  errorBannerTimer = setTimeout(() => errorBannerEl.classList.add('hidden'), 9000);
}
errorBannerCloseEl?.addEventListener('click', () => {
  clearTimeout(errorBannerTimer);
  errorBannerEl?.classList.add('hidden');
});

// Any failure that escapes every local try/catch still reaches the player
// as a plain-language banner instead of vanishing into the console --
// previously the only user-facing error surface was five specific
// alert() call sites, so anything outside those was invisible.
window.addEventListener('error', (e) => {
  console.error('[unhandled error]', e.error || e.message);
  showErrorBanner('Something went wrong. Try reloading, or drop your file again.');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
  showErrorBanner('Something went wrong. Try reloading, or drop your file again.');
});

const loaderEl = document.getElementById('loader');
const dropzoneEl = document.getElementById('dropzone');
const fileInputEl = document.getElementById('fileInput');
const demoBtnEl = document.getElementById('demoBtn');
const browseBtnEl = document.getElementById('browseBtn');
const urlLoadEl = document.getElementById('urlLoad');
const urlLoadWhyEl = document.getElementById('urlLoadWhy');
const urlLoadFormEl = document.getElementById('urlLoadForm');
const urlLoadInputEl = document.getElementById('urlLoadInput');
const urlLoadBtnEl = document.getElementById('urlLoadBtn');
const urlLoadStatusEl = document.getElementById('urlLoadStatus');
const urlLoadListEl = document.getElementById('urlLoadList');
const urlLoadCrumbEl = document.getElementById('urlLoadCrumb');
const urlLoadOpenBtnEl = document.getElementById('urlLoadOpenBtn');
const worldSelectEl = document.getElementById('worldSelect');
const titleWorldEl = document.getElementById('titleWorld');
// One-world mode: The Range is the game, so a song starts in it without a
// picker. The other worlds are still registered, and `?worlds=all` brings
// the picker and the title-screen world menu back (the smoke tools that
// exercise them use it).
const ALL_WORLDS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('worlds') === 'all';
const ONE_WORLD_ID = 'alpine';
// How long a one-world start waits for the song's biomes to load before
// starting on the bundled Tetons instead.
const BIOME_WAIT_MS = 2500;
const worldSelectGridEl = document.getElementById('worldSelectGrid');
const worldSelectBackEl = document.getElementById('worldSelectBack');
const worldPassageQuietEl = document.getElementById('worldPassageQuiet');
const worldPassagePeakEl = document.getElementById('worldPassagePeak');
const worldChooseForMeEl = document.getElementById('worldChooseForMe');
const progressEl = document.getElementById('progressText');
const hudEl = document.getElementById('hud');
const hudRightEl = document.getElementById('hudRight');
const hudLeftEl = document.getElementById('hudLeft');
const rangeCaptionDetailsEl = document.getElementById('rangeCaptionDetails');
const completePanelEl = document.getElementById('completePanel');
const completeSongNameEl = document.getElementById('completeSongName');
const completeSeedEl = document.getElementById('completeSeed');
const copySeedBtnEl = document.getElementById('copySeedBtn');
const resultsGridEl = document.getElementById('resultsGrid');
const playAgainBtnEl = document.getElementById('playAgainBtn');
const replaySameSeedBtnEl = document.getElementById('replaySameSeedBtn');
const replayNewSeedBtnEl = document.getElementById('replayNewSeedBtn');
const completeNewSeedRowEl = document.getElementById('completeNewSeedRow');
const completeNewSeedInputEl = document.getElementById('completeNewSeedInput');
const completeNewSeedStartBtnEl = document.getElementById('completeNewSeedStartBtn');
const completeNewSeedCancelBtnEl = document.getElementById('completeNewSeedCancelBtn');
const stageFpsEl = document.getElementById('stageFps');
const landscapeHintEl = document.getElementById('landscapeHint');
const debugOverlayEl = document.getElementById('debugOverlay');
const fpsHudEl = document.getElementById('fpsHud');
const pauseBtnEl = document.getElementById('pauseBtn');
const stopBtnEl = document.getElementById('stopBtn');
const fullscreenBtnEl = document.getElementById('fullscreenBtn');
const btLatencyBtnEl = document.getElementById('btLatencyBtn');
const btLatencyPopoverEl = document.getElementById('btLatencyPopover');
const btLatencyInputEl = document.getElementById('btLatencyInput');
const btLatencyApplyBtnEl = document.getElementById('btLatencyApplyBtn');
const btLatencyOffBtnEl = document.getElementById('btLatencyOffBtn');
const trackBadgeEl = document.getElementById('trackBadge');
const trackBadgeBtnEl = document.getElementById('trackBadgeBtn');
const trackListEl = document.getElementById('trackList');
const dragOverlayEl = document.getElementById('dragOverlay');
const filmstripEl = document.getElementById('filmstrip');
const filmstripModalEl = document.getElementById('filmstripModal');
const filmstripModalTitleEl = document.getElementById('filmstripModalTitle');
const filmstripModalCloseEl = document.getElementById('filmstripModalClose');
const filmstripModalImgEl = document.getElementById('filmstripModalImg');
const filmstripModalDownloadEl = document.getElementById('filmstripModalDownload');
const auditionPanelEl = document.getElementById('auditionPanel');
const auditionHeadingEl = document.getElementById('auditionHeading');
const auditionCanvasEl = document.getElementById('auditionCanvas');
const auditionTextEl = document.getElementById('auditionText');
const auditionBarFillEl = document.getElementById('auditionBarFill');
const lyricsRowEl = document.getElementById('lyricsRow');
const lyricsStatusEl = document.getElementById('lyricsStatus');
const lyricsFieldsEl = document.getElementById('lyricsFields');
const lyricsArtistInputEl = document.getElementById('lyricsArtistInput');
const lyricsTitleInputEl = document.getElementById('lyricsTitleInput');
const lyricsFindBtnEl = document.getElementById('lyricsFindBtn');
const lyricsSkipBtnEl = document.getElementById('lyricsSkipBtn');
const lyricsNoneBtnEl = document.getElementById('lyricsNoneBtn');
const lyricGroundingBtnEl = document.getElementById('lyricGroundingBtn');
const calibrateBtnEl = document.getElementById('calibrateBtn');
const recalibration = new RecalibrationOverlay({
  panel: document.getElementById('recalPanel'),
  number: document.getElementById('recalNumber'),
  instruction: document.getElementById('recalInstruction'),
  pips: document.getElementById('recalPips'),
  confFill: document.getElementById('recalConfFill'),
  status: document.getElementById('recalStatus'),
  marker: document.getElementById('recalMarker'),
});
// Cross-song groove profile (GrooveFingerprint), rehydrated once at startup
// and handed to every Simulation built afterwards.
const groove = new GrooveFingerprint(getStoredGroove());
// Frame-loop failures, counted and shown rather than swallowed.
const drawErrors = new DrawErrorLog();
let grooveSaveDue = false;
let grooveSaveAtMs = 0;
const GROOVE_SAVE_DEBOUNCE_MS = 2000; // wall-clock auto-dismiss for the nudge

const conductor = new Conductor();
const paramBus = new ParamBus();
let audioEngine = null;
let synth = null;
let sim = null;
const rangeNavigationEl = document.getElementById('rangeNavigation');
const rangeSeekEl = document.getElementById('rangeSeek');
rangeSeekEl?.addEventListener('change', () => { if (sim) seekSong(Number(rangeSeekEl.value) * 1000); });
document.getElementById('rangeRestart')?.addEventListener('click', () => { if (sim) seekSong(0); });
const rangeListening = true;
let renderer = null;
let titleBackdrop = null; // living title-screen backdrop (drawn while !running)
let titleRafHandle = null;
const playbackCadence = new FrameCadence();
const titleCadence = new FrameCadence();
let lastSpecSig = null; // cache-gate for the One-Spectrum CSS var sync (write only on key/form change)
// A second, much coarser gate for the --glow-* tokens. See the note on
// #app::before in style.css: those three feed a larger-than-viewport element
// under a 48px blur, so each rewrite is a full-viewport repaint at display
// resolution -- the one CSS variable write in this app whose cost is worth a
// gate of its own. 30 degrees rather than the chrome's 3.
const GLOW_SHIFT_STEP_DEG = 30;
let lastGlowSig = null;
let visionLoop = null;
let debugOverlay = null;
let perfGovernor = null;
let lastRafMs = null; // separate from lastNowMs (audio clock) -- tracks real rAF-to-rAF cadence for the perf governor
let sf2Engine = null;
let fontLibrary = null;
let fontRecommender = null;
let rafHandle = null; // tracks the pending frame() call so a mid-song file
                       // drop can cancel the old loop instead of stacking a
                       // second one alongside it
let reducedFlash = getReducedFlash(); // The Reel (Movement VI): persisted accessibility toggle
let reducedMotion = getReducedMotion();
const reducedFlashBtn = document.getElementById('reducedFlashBtn');
/** Pointer, Enter/Space (native button) and R all reach toggleReducedFlash,
 *  so the chip, persistence and the running sim never disagree. */
function syncFlashButton() {
  if (!reducedFlashBtn) return;
  reducedFlashBtn.textContent = `Reduced flashing: ${reducedFlash ? 'on' : 'off'}`;
  reducedFlashBtn.setAttribute('aria-pressed', String(reducedFlash));
}
syncFlashButton();
reducedFlashBtn?.addEventListener('click', () => toggleReducedFlash());
const reducedMotionBtn = document.getElementById('reducedMotionBtn');
function syncMotionButton() {
  if (!reducedMotionBtn) return;
  reducedMotionBtn.textContent = `Reduced motion: ${reducedMotion ? 'on' : 'off'}`;
  reducedMotionBtn.setAttribute('aria-pressed', String(reducedMotion));
}
syncMotionButton();
reducedMotionBtn?.addEventListener('click', () => {
  reducedMotion = !reducedMotion;
  setReducedMotion(reducedMotion);
  sim?.setReducedMotion(reducedMotion);
  syncMotionButton();
  if (pendingWorldStart) startChooserPreviews();
});
let lyricsDisabled = getLyricsDisabled(); // "No lyrics": persisted opt-out from the lyric fetch/prompt
let btLatencyTrimMs = getBtLatencyTrimMs(); // manual Bluetooth output-latency correction, player-entered ms; 0 = off
/** Derives that trim from tapping during a Sync pass. See SyncCalibrator.js:
 *  the player's taps are treated as canon, and the value moves after each
 *  one rather than at the end of the pass. */
const syncCalibrator = new SyncCalibrator(btLatencyTrimMs);

/** Effective output latency for beat-anchored visuals: AudioEngine's
 *  auto-detected figure, plus the manual Bluetooth trim the player has
 *  typed in (0 if they haven't set one). The one place this composition
 *  happens -- every consumer (Simulation's per-step envelopes, tap
 *  calibration) reads through here rather than each re-adding the trim its
 *  own way.
 *
 *  Only the trim's POSITIVE part belongs here -- a negative trim (audio
 *  needs to run later relative to visuals, not the other way round) is
 *  applied on the audio side instead, via applyBtLatencyToAudioEngine's
 *  audioEngine.setAudioDelayMs, since a visual can never be shown before
 *  its own real time arrives. */
function effectiveOutputLatencyMs() {
  return audioEngine.outputLatencyMs + Math.max(0, btLatencyTrimMs);
}

/** Recorded audio is tapped before hardware output latency, so an export's
 * choreography must use the same zero-latency clock rather than baking this
 * room's device/Bluetooth compensation into the video.
 *
 * NOT the presentation lead, which a captured frame also does not need --
 * that one is still baked into the recorded choreography, and taking it out
 * is its own piece of work. See docs/video-export.md. */
function choreographyOutputLatencyMs() {
  return captureClock.captureRequested ? 0 : effectiveOutputLatencyMs();
}

/** The other half of the signed BT trim (see effectiveOutputLatencyMs): a
 *  negative value delays the actual audio output by that many ms instead of
 *  asking visuals to run backward. Called once at startup and again on
 *  every trim change -- audioEngine itself only exists once the player has
 *  started a song, so this is a no-op (and re-applied by the next call)
 *  until then. */
function applyBtLatencyToAudioEngine() {
  audioEngine?.setAudioDelayMs(Math.max(0, -btLatencyTrimMs));
}
// Dev surfaces (the `` ` ``/V/T debug overlay + its per-frame render cost,
// and the developer-oriented half of the title screen's key legend) are
// gated behind ?dev=1. V and T sit on bare letter keys right next to the
// gameplay keys F/J -- a player mashing during a hard section, or on a
// non-QWERTY layout, can land on them by accident and silently change
// engine behavior with no visible indication of what happened. Ungated:
// P (fps) and F3 (section labels), both self-explanatory and reversible.
const DEV_MODE = new URLSearchParams(location.search).get('dev') === '1';
// Graphics presentation: URL ?style=classic|rendered overrides storage.
const _styleParam = new URLSearchParams(location.search).get('style');
let visualStyle = _styleParam ? resolveVisualStyle(_styleParam) : getVisualStyle();
paramBus.visualStyle = visualStyle;

/** Reflect the "Timed lyric grounding" preference on the loader toggle. */
function syncLyricGroundingBtn() {
  if (!lyricGroundingBtnEl) return;
  // Stated positively: the setting is the FEATURE being on, not an opt-out
  // from it, so `lyricsDisabled` is inverted for display.
  const on = !lyricsDisabled;
  lyricGroundingBtnEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  lyricGroundingBtnEl.textContent = `Timed lyric grounding: ${on ? 'on' : 'off'}`;
}
syncLyricGroundingBtn();
if (lyricGroundingBtnEl) {
  lyricGroundingBtnEl.addEventListener('click', () => {
    lyricsDisabled = !lyricsDisabled;
    setLyricsDisabled(lyricsDisabled);
    syncLyricGroundingBtn();
  });
}


// Guided calibration was previously reachable only via the C key -- this
// is the only way to reach it on a phone or tablet, same gap the reduced-
// flash toggle already had a button for.
if (calibrateBtnEl) {
  calibrateBtnEl.addEventListener('click', () => {
    if (recalibration.active) endRecalibration(); else startRecalibration();
  });
}
// Set per load path (true only for raw decoded audio, which already has
// every voice baked into the buffer) and read by applySynthMutePolicy().
let muteTimelineSynth = false;
let loadShow = null; // percussion loading show, created in bootAudio
const audioSelections = createAudioSelection();
let loadGen = 0;     // a newer load cancels a stale audition gate's start

// Retained so "Replay seed" can restart the same song without a page reload
// (sim is fully seeded + autoplay-driven). `lastAudioBuffer` is only set on
// the raw-audio-file path (MIDI/demo regenerate sound from the timeline).
let lastTimelineData = null;
// The whole-song analysis of a song started on its opening
// (OpeningAnalysis.js), while it is still running; null otherwise.
let fullAnalysisPending = null;
// What the running song was started with, so an in-place rebuild keeps it.
let lastStartExtra = {};
let lastAudioBuffer = null;
let lastWorldId = DEFAULT_WORLD_ID;
let pendingWorldStart = null;
let lastFitDiagnostic = null;
let previewSession = null;
let lastSongName = 'song';
let lastSongSeed = null; // 32-bit seed used for the run that just finished

// Logical composition stays 1280×720. Live output uses the selected pixel
// grid; exports retain their independently requested output dimensions.
const STAGE_W = 1280;
const STAGE_H = 720;
function displayStorage() { try { return localStorage; } catch { return null; } }
let displayPrefs = readDisplayPrefs(displayStorage());
writeDisplayPrefs(displayStorage(), displayPrefs);
let presentation = resolvePresentation(displayPrefs);
const displayControls = Object.fromEntries(['look', 'quality', 'palette', 'dither', 'ditherMode', 'pixelGrid', 'pixelScale', 'scaling'].map(key => [key, document.getElementById(`display-${key}`)]));
const STAGE_FPS_KEY = 'smw:stageFps';
let simTime = 0;
let acc = 0;
let lastNowMs = 0;
const captureClock = new CaptureClock({ liveLeadMs: VISUAL_LEAD_MS });
let running = false;
let paused = false; // suspends the AudioContext itself -- the master clock everything derives from
let fpsHudVisible = resolveFpsHudVisible(typeof location !== 'undefined' ? location.search : '');
let fpsEma = null;
const presentedFps = new PresentedFpsMeter();
fpsHudEl?.classList.toggle('hidden', !fpsHudVisible);
// Renderer path: ?renderer=webgl enables the optional WebGL post-FX overlay.
// Default remains pure Canvas 2D so drag/upload MIDI never depends on GL.
const rendererMode = resolveRendererMode(
  typeof location !== 'undefined' ? location.search : '',
);
paramBus.rendererMode = rendererMode;
// Range v2 (real-terrain scenic views) is the default; ?rangeRenderer=legacy
// opts out, and any v2 failure falls back to legacy per frame on its own.
// ?rangeView=<id> forces one catalog view for diagnostics. One presentation (and one GPU context) per page.
const rangeMode = resolveRangeMode();
let rangePresentation = rangeMode.mode === 'v2'
  ? new RangePresentation({ mode: 'v2', tour: rangeMode.tour, forcedViewId: rangeMode.forcedViewId, diag: rangeMode.diag, residency: sharedResidency(), budget: residencyBudgetFor().name })
  : null;

const rangeTourToggle = document.getElementById('range-tour-toggle');
const rangeTourStatus = document.getElementById('range-tour-status');
function currentTourControlState() {
  return rangeTourControlState(rangePresentation?.status(), { running, worldKind: sim?.biomes?.world?.kind, paused });
}
function rangeStateSnapshot() {
  return rangePresentation?.snapshot() || { mode: 'legacy', requestedMode: 'legacy', resolvedMode: 'legacy',
    active: false, tourMode: null, runtime: 'off', runtimeReady: false, selectedViewId: null,
    tourPreparation: { state: 'off' }, fallbackReason: 'legacy-mode' };
}
function syncRangeTourControl() {
  if (!rangeTourStatus) return;
  const status = currentTourControlState();
  if (rangeTourStatus.textContent !== status.text) rangeTourStatus.textContent = status.text;
  rangeTourStatus.dataset.state = status.state;
  rangeTourStatus.title = status.reason || '';
}
if (rangeTourToggle) {
  rangeTourToggle.checked = rangeMode.tour === 'tetons';
  rangeTourToggle.addEventListener('change', () => {
    const tour = rangeTourToggle.checked ? 'tetons' : null;
    try { if (tour) localStorage.setItem('range-tour', tour); else localStorage.removeItem('range-tour'); } catch { /* Storage may be blocked. */ }
    const url = new URL(location.href); url.searchParams.set('rangeTour', tour || 'off'); history.replaceState(null, '', url);
    rangePresentation ||= new RangePresentation({ mode: 'v2', residency: sharedResidency(), budget: residencyBudgetFor().name });
    if (renderer) renderer.rangePresentation = rangePresentation;
    const terrain = lastTimelineData?.terrain;
    if (terrain) {
      if (tour && getWorld(lastTimelineData.worldId)?.kind === 'alpine') { terrain._rangeTourOriginalBiomes ||= [...terrain.biomes]; terrain.biomes = ['CONIFER']; }
      else if (terrain._rangeTourOriginalBiomes) { terrain.biomes = terrain._rangeTourOriginalBiomes; delete terrain._rangeTourOriginalBiomes; }
    }
    rangePresentation.setTourMode(tour);
    if (running && sim && audioEngine && lastTimelineData) {
      const wasPaused=paused;
      delete lastTimelineData.chapterState;
      startTimeline(lastTimelineData, {
        ...lastStartExtra, songSeed:sim.songSeed,
        startAtMs:Math.max(1,audioEngine.nowMs), keepAudio:true,
        keepUserCamera:true, preservePause:wasPaused, chapterState:null,
      });
      if(wasPaused){paused=true;updatePauseButtonUI();}
    }
    syncRangeTourControl();
  });
}
syncRangeTourControl();
// Downloads/workers can settle while the audio is paused and no scenic
// frames are drawn. Poll only lightweight status, and announce changed text.
if (rangeTourStatus) setInterval(syncRangeTourControl, 250);

// The title screen is alive from the very first frame: a living backdrop
// (starfield + nebula) runs on its own rAF loop until a song
// starts, so the loader is never a dead gradient.
startTitleBackdrop();

const isCoarsePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// Perf tier: ?perf=lite|high overrides; otherwise a coarse-pointer/small-
// viewport device heuristic starts a phone a rung down so the first
// second of play is already smooth instead of janky-then-corrected.
const perfStartLevel = resolvePerfStartLevel(
  typeof location !== 'undefined' ? location.search : '',
  {
    isCoarsePointer,
    isSmallViewport: typeof window !== 'undefined' && Math.min(window.innerWidth || 9999, window.innerHeight || 9999) < 700,
  },
);

function syncDisplayControls() {
  for (const [key, control] of Object.entries(displayControls)) if (control) {
    control.value = String(displayPrefs[key]);
    control.disabled = ['palette', 'dither', 'ditherMode'].includes(key) && displayPrefs.look !== 'palette'
      || key === 'ditherMode' && (displayPrefs.palette === 'rgb332' || displayPrefs.dither === 0);
  }
  const grid = document.getElementById('pixelGridHint');
  const selectedGrid = presentation.grid;
  if (grid) { grid.hidden = false; grid.textContent = `${selectedGrid.width} × ${selectedGrid.height} grid`; }
}

function storedFpsCap() {
  try {
    const stored = Number(localStorage.getItem(STAGE_FPS_KEY));
    return stored === 30 || stored === 60 ? stored : null;
  } catch { return null; }
}

function readFpsCap() {
  const fromUi = Number(stageFpsEl?.value);
  if (fromUi === 30 || fromUi === 60) return fromUi;
  return storedFpsCap() ?? 60;
}

function persistFpsCap(fps) {
  try { localStorage.setItem(STAGE_FPS_KEY, String(fps)); } catch { /* no storage */ }
}

let fpsCapMs = 1000 / readFpsCap();
/** Exact backing-store size while tools/bulk-export.mjs is driving frames.
 *  Display-fit and the perf ladder both stand aside for it. */
let bulkExportSize = null;
let bulkExportArmed = false;
let bulkPresentation = null;
let titlePresentation = null;
function effectivePresentation() { return bulkPresentation || presentation; }
function fitPixelLayout() {
  const p = effectivePresentation();
  const integer = p.pixelated && p.scaling === 'integer' && !bulkExportSize;
  canvas.classList.toggle('integerPixels', integer);
  canvas.parentElement.classList.toggle('pixelDisplay', p.pixelated);
  if (integer) {
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const fit = fitPixelRect(p.grid.width, p.grid.height, box.width * dpr, box.height * dpr, 'integer', { x: box.left * dpr, y: box.top * dpr });
    canvas.style.setProperty('--pixel-grid-width', `${p.grid.width}px`);
    canvas.style.setProperty('--pixel-grid-height', `${p.grid.height}px`);
    canvas.style.setProperty('--pixel-width', `${fit.width / dpr}px`);
    canvas.style.setProperty('--pixel-height', `${fit.height / dpr}px`);
    canvas.style.setProperty('--pixel-scale', String(fit.scale / dpr));
    canvas.style.setProperty('--pixel-left', `${box.left + fit.x / dpr}px`);
    canvas.style.setProperty('--pixel-top', `${box.top + fit.y / dpr}px`);
  }
}

/** `?bulkExport=1&exportW=&exportH=` arms export on the next song start.
 *  An odd or unusable size reads as not armed (evenExportSize -> null);
 *  startTimeline then refuses loudly rather than rendering a wrong size. */
/** An export that can't be armed has to say so where both a person and
 *  tools/bulk-export.mjs will see it. A throw alone doesn't: startTimeline
 *  runs inside the world picker's variant fallback, which catches it as a
 *  variant failure, and its retry is a no-op because confirmWorld already
 *  consumed the pending start. So record it on the page (the tool polls
 *  __SMW_EXPORT_ERROR), show the banner, and hand back the error to throw. */
function failBulkExport(message) {
  if (typeof window !== 'undefined') window.__SMW_EXPORT_ERROR = message;
  showErrorBanner(message);
  return new Error(message);
}

function readBulkExportFromUrl() {
  try {
    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    if (q.get('bulkExport') !== '1') return null;
    return { w: Number(q.get('exportW')), h: Number(q.get('exportH')) };
  } catch {
    return null;
  }
}

/** Keep live/title raster size fixed to its grid; exports choose output size. */
function fitCanvas() {
  const active = effectivePresentation();
  renderer?.setPresentation(active);
  titlePresentation?.setPresentation(active);
  fitPixelLayout();
  if (perfGovernor) {
    perfGovernor.economy = active.quality === 'economy';
    perfGovernor.targetCanvasWidth = active.grid.width;
    perfGovernor.canvasWidth = active.grid.width;
  }
  const size = bulkExportSize || { w: active.grid.width, h: active.grid.height };
  resizeStageCanvas(canvas, size.w, size.h);
  // Canvas resets clear context state, including nearest-neighbor sampling.
  const ctx2d = canvas.getContext('2d');
  if (ctx2d) ctx2d.imageSmoothingEnabled = false;
  canvas.classList.add('retro');
  landscapeHintEl?.classList.toggle(
    'is-visible',
    !bulkExportSize && shouldSuggestLandscape(canvas.clientWidth, canvas.clientHeight),
  );
}

function randomizeSeed() {
  const s = (Math.random() * 0x100000000) >>> 0;
  return s;
}

// Stored display preferences on boot.
{
  for (const [key, control] of Object.entries(displayControls)) {
    if (!control) continue;
    control.value = String(displayPrefs[key]);
    control.addEventListener('change', () => {
      displayPrefs = { ...displayPrefs, [key]: key === 'dither' ? Number(control.value) : control.value };
      presentation = resolvePresentation(displayPrefs);
      writeDisplayPrefs(displayStorage(), displayPrefs);
      syncDisplayControls();
      perfGovernor?.forgetRecoveryHistory();
      fitCanvas();
      if (paused && sim && renderer && !bulkExportArmed) {
        try {
          const frame = renderer.draw(sim, 1);
          if (frame?.presented) songRecorder?.captureFrame(renderer.getCaptureSource());
        } catch (err) { console.warn('[display presentation]', err); }
      }
    });
  }
  syncDisplayControls();
  if (stageFpsEl) {
    stageFpsEl.value = String(storedFpsCap() ?? readFpsCap());
    // Seeding the select above does not itself move the live cap, which was
    // computed from readFpsCap() before the DOM was consulted -- so a
    // restored 30fps has to be pushed into fpsCapMs here or the menu would
    // read "30 fps" while the loop kept drawing 60.
    fpsCapMs = 1000 / readFpsCap();
    stageFpsEl.addEventListener('change', () => {
      const fps = Number(stageFpsEl.value) || 60;
      persistFpsCap(fps);
      fpsCapMs = 1000 / fps;
      playbackCadence.reset(); titleCadence.reset(); presentedFps.reset();
      // As with the pixel detail control: halving the
      // draw rate halves the work, so what the ladder learned at the old
      // rate describes a different workload. The frame callbacks go clean
      // almost immediately -- sampling runs at the full rAF rate whatever
      // the cap, it is the DRAW that is skipped -- and without this the
      // backoff from before the change would hold quality down for minutes
      // after the player has already fixed the problem.
      perfGovernor?.forgetRecoveryHistory();
    });
  }
  fitCanvas();
  // The backing store is now sized against the element's own CSS box, so a
  // rotation or window resize changes the right answer -- nothing re-ran
  // fitCanvas on either before, since the size used to depend only on the
  // preset. Coalesced onto a frame so a drag-resize doesn't reallocate every
  // buffer sized to the backing store (motion-blur ring, bloom, heat) dozens
  // of times per second.
  if (typeof window !== 'undefined') {
    let resizeRaf = null;
    const onResize = () => {
      if (resizeRaf !== null) return;
      resizeRaf = requestAnimationFrame(() => { resizeRaf = null; fitCanvas(); });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }
}

let bootAudioInFlight = null;

/**
 * Starts the audio engine, at most once, and makes every caller wait for
 * the SAME attempt.
 *
 * ORDER MATTERS, and it is the opposite of the obvious one. `bootAudioOnce`
 * assigns `audioEngine` before it awaits `resume()`, so `audioEngine` is
 * truthy for the whole of that window -- which means checking it first
 * returns early against a context that has not resumed, or one the first
 * call is about to null out because resume failed. Checking it first is
 * exactly the bug the in-flight promise exists to close, so the in-flight
 * check has to come first or it is unreachable while it matters.
 *
 * A truthy `audioEngine` with nothing in flight is the only state that
 * means "already booted", and only then is returning immediately correct.
 *
 * `unlockAudio()` fires this from a gesture and discards the promise, so
 * the window is reachable rather than theoretical: a small loopback
 * download can finish well before a slow `resume()` does.
 */
async function bootAudio() {
  if (bootAudioInFlight) return bootAudioInFlight;
  if (audioEngine) return;
  bootAudioInFlight = bootAudioOnce().finally(() => { bootAudioInFlight = null; });
  return bootAudioInFlight;
}

async function bootAudioOnce() {
  audioEngine = new AudioEngine();
  applyBtLatencyToAudioEngine(); // carry over any negative trim set before this song started
  const running = await audioEngine.resume();
  if (!running) {
    // A stuck-suspended context used to fail silently here: the game would
    // still start, but ctx.currentTime never advances, so it renders its
    // first frame forever with no indication why. Fail loudly instead --
    // audioEngine stays set so a later user gesture (a click) can still
    // resume it via the browser's own autoplay-unlock behavior, but this
    // load attempt surfaces the real problem now.
    audioEngine = null;
    throw new Error('Audio is blocked by the browser. Try clicking the page first, then retry.');
  }
  const fallback = new SimpleSynth(audioEngine);
  synth = new SynthRouter(fallback);
  // Connect exactly once: `synth`/`conductor` are both persistent
  // singletons for the lifetime of the page (bootAudio itself only ever
  // runs once, guarded by the early return above), so a second connect —
  // as used to happen on every dropped MIDI file — would add a duplicate
  // listener and fire every note twice.
  synth.connectConductor(conductor);
  loadShow = new LoadingShow({
    canvasEl: auditionCanvasEl, textEl: auditionTextEl, barFillEl: auditionBarFillEl,
    audioEngine,
  });
}

let soundfontsInFlight = null;

/** Optional internal font consumers explicitly request this setup. Normal
 * recording/sample unlock never discovers fonts or constructs an SF2 engine.
 * Concurrent consumers share one page-lifetime setup/discovery promise. */
async function ensureSoundfonts() {
  await bootAudio();
  if (!soundfontsInFlight) {
    soundfontsInFlight = (async () => {
      sf2Engine = new Sf2Synth(audioEngine);
      synth.setSf2Engine(sf2Engine);
      fontLibrary = new SoundfontLibrary();
      fontLibrary.onChange = applyActiveFont;
      fontRecommender = new FontRecommender(fontLibrary);
      fontLibrary.onAdded = (font) => fontRecommender.auditionFont(font);
      // Existing diagnostic handles remain usable after explicit setup.
      if (window.__SMW) Object.assign(window.__SMW, { fontLibrary, sf2Engine, fontRecommender });
      await fontLibrary.autoLoadFromServer('./soundfonts/');
      return fontLibrary;
    })();
  }
  return soundfontsInFlight;
}

function applySynthMutePolicy() {
  // Audio-file playback already has the song in the buffer — stacking the
  // synthetic hi-hat / click / kick voices on top is what the player hears as
  // the unwanted metronome layer. MIDI still needs the synth; the authored
  if (synth) synth.enabled = !muteTimelineSynth;
}

// --- Fullscreen ---
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
async function enterFullscreen() {
  const root = document.documentElement;
  try {
    if (root.requestFullscreen) {
      // navigationUI: 'hide' asks the browser to skip its own "press Esc to
      // exit" banner. It's a hint, not a guarantee -- browsers are free to
      // show it anyway (deliberately: a page can't be allowed to trap
      // someone in fullscreen with no visible way out), but where it's
      // honored this is the only lever a page has.
      await root.requestFullscreen({ navigationUI: 'hide' });
    } else if (root.webkitRequestFullscreen) {
      await root.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn('[fullscreen]', err);
  }
  updateFullscreenBtn();
}
async function toggleFullscreen() {
  if (!isFullscreen()) { await enterFullscreen(); return; }
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
  } catch (err) {
    console.warn('[fullscreen]', err);
  }
  updateFullscreenBtn();
}
function updateFullscreenBtn() {
  if (!fullscreenBtnEl) return;
  fullscreenBtnEl.title = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
  fullscreenBtnEl.setAttribute('aria-pressed', isFullscreen() ? 'true' : 'false');
}
if (fullscreenBtnEl) fullscreenBtnEl.addEventListener('click', () => toggleFullscreen());
if (pauseBtnEl) pauseBtnEl.addEventListener('click', () => togglePause());
if (stopBtnEl) stopBtnEl.addEventListener('click', () => backToTitle());

// --- Car mode: display timeout and fullscreen survival (KeepAwake.js) ---
// On a head-unit projection (Auto Pro X -> car receiver) the display blanks
// after about a minute of no touch input, and the tap that revives it also
// drops the show out of fullscreen. Three parts, none of which fake input --
// a synthesized tap is untrusted and never reaches the OS idle timer:
//   * hold a screen wake lock while a song runs, re-armed on a 30s heartbeat;
//   * if the display blanks anyway, spend the reviving tap on restoring the
//     show instead of letting it reach a button (the HUD's "tap to unlock"
//     beat, one level up);
//   * re-enter fullscreen when the system -- not the player -- dropped it.
const keepAwake = new KeepAwake({ onWarn: (msg, err) => console.warn('[keepawake]', msg, err) });
let lastInputMs = null;
let fullscreenDropped = false;
// Evidence that there was a blanked display to wake: the render loop stopped
// being called, or the page was hidden outright. Without it, a long wait with
// nobody touching the screen -- a 40-second analysis, a song watched straight
// through -- would look exactly like a display timeout, and the next real tap
// would be eaten. Cleared by the tap it is spent on.
let displaySlept = false;
// Touch still synthesizes a click after pointerdown in some browsers even
// when the pointerdown was default-prevented; an absorbed tap has to swallow
// that echo too, or it lands on a button anyway.
let absorbClickUntilMs = 0;
const CLICK_ECHO_MS = 700;

/** Called from the render loop with each frame delta (playing frames only --
 *  a pause leaves the loop running but resets the delta, see togglePause). */
function noteFrameGap(rafDeltaMs) {
  if (isDisplaySleepGap(rafDeltaMs)) displaySlept = true;
}
// Screen-off usually hides the page outright, which is the cleaner signal
// where it happens; the frame-gap check above covers the projection cases
// where it does not.
document.addEventListener('visibilitychange', () => {
  playbackCadence.reset(); titleCadence.reset(); presentedFps.reset();
  lastRafMs = null;
  if (document.visibilityState === 'hidden') { displaySlept = true; return; }
  // Coming back, the first frames are a cold cache and a giant rAF gap, not
  // a scene the machine cannot draw. The ladder must not read them as
  // evidence -- re-arm the same grace a new song gets.
  perfGovernor?.beginWarmup(performance.now());
});

function syncKeepAwake() {
  if (running || isFullscreen()) keepAwake.enable();
  else keepAwake.disable();
}

function onFullscreenChange() {
  updateFullscreenBtn();
  if (isFullscreen()) fullscreenDropped = false;
  else if (isSystemFullscreenDrop(lastInputMs, performance.now())) fullscreenDropped = true;
  syncKeepAwake();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// Capture phase, before every other handler: this is the only place that can
// decide a tap belongs to the screen rather than to the page.
document.addEventListener('pointerdown', (e) => {
  const nowMs = performance.now();
  const absorb = shouldAbsorbTap(lastInputMs, nowMs, displaySlept);
  lastInputMs = nowMs;
  displaySlept = false;
  keepAwake.noteInput();
  if (!absorb) return;
  e.preventDefault();
  e.stopPropagation();
  absorbClickUntilMs = nowMs + CLICK_ECHO_MS;
  if (fullscreenDropped && !isFullscreen()) {
    fullscreenDropped = false;
    // A real user gesture is in hand right now -- the only moment a page is
    // allowed to ask for fullscreen back.
    enterFullscreen();
  }
  if (running) wakeHud();
}, true);

document.addEventListener('click', (e) => {
  if (performance.now() >= absorbClickUntilMs) return;
  absorbClickUntilMs = 0;
  e.preventDefault();
  e.stopPropagation();
}, true);

window.addEventListener('keydown', () => { lastInputMs = performance.now(); displaySlept = false; }, true);

function applyActiveFont(active) {
  sf2Engine?.loadSf2(active?.data || null);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Populates the track badge/list from a loaded MIDI's per-track breakdown
 *  (multi-track MIDI, visible somewhere). No-ops for non-MIDI sources
 *  (raw audio file / procedural demo), which carry no track metadata. */
function renderTracks(tracks, pairs) {
  if (!trackBadgeEl || !trackBadgeBtnEl || !trackListEl) return;
  const shown = (tracks || []).filter((t) => t.noteCount > 0);
  if (shown.length === 0) {
    trackBadgeEl.classList.add('hidden');
    trackBadgeEl.classList.remove('expanded');
    trackListEl.innerHTML = '';
    return;
  }

  const roleCount = new Set(shown.map((t) => t.role)).size;
  trackBadgeBtnEl.textContent =
    `${shown.length} track${shown.length === 1 ? '' : 's'} \u00b7 ${roleCount} role${roleCount === 1 ? '' : 's'}`;

  const panGlyph = (pan) => (pan <= -0.15 ? '\u25c4' : pan >= 0.15 ? '\u25ba' : '\u25cf');
  const partnerName = (track) => {
    const pair = (pairs || []).find((p) => p.channelA === track.channel || p.channelB === track.channel);
    if (!pair) return null;
    const otherChannel = pair.channelA === track.channel ? pair.channelB : pair.channelA;
    const other = shown.find((t) => t.channel === otherChannel);
    return other ? other.name : null;
  };

  const rows = shown.map((t) => {
    const partner = t.intertwined ? partnerName(t) : null;
    const title = partner ? `Widens apart from "${partner}" over the course of the song` : '';
    return `<div class="trackRow${t.intertwined ? ' intertwined' : ''}" title="${escapeHtml(title)}">`
      + `<span class="roleDot role-${t.role}"></span>`
      + `<span class="trackName">${escapeHtml(t.name)}${partner ? ' \u2194' : ''}</span>`
      + `<span class="panGlyph">${panGlyph(t.pan)}</span>`
      + `<span class="trackMeta">${t.noteCount}</span>`
      + `</div>`;
  }).join('');
  const hint = (pairs && pairs.length)
    ? '<div class="trackListHint">\u2194 tracks were mixed hard-panned opposite and play together — their stereo spread widens gradually over the song.</div>'
    : '';
  trackListEl.innerHTML = rows + hint;

  trackBadgeEl.classList.remove('hidden');
}

function toggleTrackList() {
  if (trackBadgeEl) trackBadgeEl.classList.toggle('expanded');
}

/** Tears down whatever is currently playing (if anything) so a new song can
 *  start cleanly: cancels the in-flight frame() loop (otherwise a second
 *  `requestAnimationFrame(frame)` from the new `startTimeline` would run
 *  ALONGSIDE the still-scheduled old one, double-stepping the simulation),
 *  stops any raw audio buffer mid-flight, silences any still-ringing SF2
 *  voices, and resets the UI panels a fresh song should start without. Safe
 *  to call before the very first song too (everything it touches already
 *  tolerates being idle). */
function stopTimeline({ preservePause = false, keepAudio = false } = {}) {
  running = false;
  syncKeepAwake();
  recalibration.stop();
  // conductor is a single instance shared across every song (see its
  // construction above); Simulation and its subsystems subscribe to it at
  // construction and never unsubscribe on their own. Without this, a replay
  // leaves the old sim's listeners registered forever -- each stacking on
  // top of the next, still firing into torn-down state on every future
  // dispatch for the rest of the session.
  if (sim) { sim.dispose(); sim = null; }
  // A stop/restart must never leave the AudioContext suspended -- its
  // currentTime is the master clock every song's timing derives from
  // (see AudioEngine.js header), and a still-suspended context would
  // freeze the NEXT song before it even starts.
  if (paused && !preservePause) {
    paused = false;
    audioEngine?.ctx?.resume();
    updatePauseButtonUI();
  }
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  // A recording running when the song is torn down (Stop, or a new drop)
  // is saved rather than dropped: whatever was captured is work the player
  // asked for, and silently discarding it is the worse surprise.
  // An in-place rebuild (the whole-song analysis arriving) keeps the music
  // and any recording running straight through it.
  if (!keepAudio && (songRecorder?.recording || pendingCapturePresetId)) finishRecording();
  if (!keepAudio) audioEngine?.pause();
  // Forget any decoded buffer from a previous raw-audio song -- otherwise a
  // MIDI/demo load right after one leaves the OLD song's buffer attached,
  // and the mountain seekbar would start playing it on top of the new one.
  // A raw-audio load re-attaches its own buffer via playBuffer() afterward.
  if (!keepAudio) audioEngine?.clearBuffer();
  // The log-on-powers-of-two cadence is meant to keep a PERSISTENT failure
  // legible without flooding the console. Carried across songs, it does the
  // opposite: a brand new regression in song 2 inherits song 1's count and
  // can stay silent until occurrence 1024. Each song gets a clean slate.
  drawErrors.reset();
  synth?.stopAll?.();
  // Tear down optional WebGL overlay so a mid-song drop doesn't stack layers.
  if (renderer && typeof renderer.dispose === 'function') {
    try { renderer.dispose(); } catch { /* ignore */ }
  }
  renderer = null;
  completePanelEl.classList.add('hidden');
  completeNewSeedRowEl?.classList.add('hidden');
  debugOverlayEl.classList.add('hidden');
  auditionPanelEl?.classList.add('hidden');
  closeWorldChooser();
  stopWorldPreview();
}

function updatePauseButtonUI() {
  if (!pauseBtnEl) return;
  pauseBtnEl.innerHTML = paused ? '&#9654;' : '&#9208;'; // play triangle vs. pause bars
  pauseBtnEl.title = paused ? 'Resume' : 'Pause';
  pauseBtnEl.setAttribute('aria-pressed', paused ? 'true' : 'false');
}

/** Suspends/resumes the AudioContext itself -- since every clock in the
 *  sim (jump timing, note dispatch, ChoreoClock) reads straight off
 *  ctx.currentTime, freezing the context freezes the whole performance
 *  in place with nothing extra to track, and resuming picks up exactly
 *  where it left off. */
function togglePause() {
  if (!running || !sim || !audioEngine) return;
  paused = !paused;
  playbackCadence.reset(); presentedFps.reset();
  if (paused) audioEngine.ctx.suspend();
  else { audioEngine.ctx.resume(); lastRafMs = null; }
  updatePauseButtonUI();
}

/** Leave the native top layer on every teardown path, not just hide its pixels. */
function closeWorldChooser() {
  if (worldSelectEl?.open) worldSelectEl.close();
  worldSelectEl?.classList.add('hidden');
}

/** Back to the title/drop screen so a different song can be chosen. */
function backToTitle() {
  // Any in-flight analysis belongs to the discarded song. Its progress or
  // failure must not redraw this title screen later.
  audioSelections.cancel();
  loadAudioFiles._abortController?.abort();
  loadShow?.stop();
  auditionPanelEl?.classList.add('hidden');
  lyricsRowEl?.classList.add('hidden');
  cancelUrlLoad();
  loadGen++;
  stopTimeline();
  completePanelEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  closeWorldChooser();
  stopWorldPreview();
  pendingWorldStart = null;
  progressEl.classList.add('hidden');
  loaderEl.classList.remove('hidden');
  startTitleBackdrop();
  dropzoneEl.focus({ preventScroll: true });
}

function stopWorldPreview() {
  if (!previewSession) return;
  previewSession.cancel();
  previewSession = null;
}

function applyWorldStill(worldId, dataUrl) {
  const card = worldSelectGridEl?.querySelector(`[data-base-world-id="${worldId}"]`);
  if (!card || !dataUrl) return;
  const still = card.querySelector('.worldCardStill');
  const preview = card.querySelector('.worldCardPreview');
  if (!still || !preview) return;
  still.src = dataUrl;
  still.classList.remove('hidden');
  preview.classList.add('is-rendered');
}

function setPreviewingCard(worldId) {
  worldSelectGridEl?.querySelectorAll('.worldCard').forEach((card) => {
    const on = card.dataset.baseWorldId === worldId;
    card.classList.toggle('is-previewing', on);
    const live = card.querySelector('.worldCardLive');
    if (live && !on) live.classList.add('hidden');
    const btn = card.querySelector('.worldCardPreviewBtn');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function showPreviewFrame(worldId, source) {
  const card = worldSelectGridEl?.querySelector(`[data-base-world-id="${worldId}"]`);
  const live = card?.querySelector('.worldCardLive');
  if (!live || !source) return;
  const ctx = live.getContext('2d');
  if (!ctx) return;
  if (live.width !== source.width) live.width = source.width;
  if (live.height !== source.height) live.height = source.height;
  ctx.drawImage(source, 0, 0);
  live.classList.remove('hidden');
}

function syncPassageButtons() {
  const which = previewSession?.passage || 'peak';
  worldPassageQuietEl?.setAttribute('aria-pressed', which === 'quiet' ? 'true' : 'false');
  worldPassagePeakEl?.setAttribute('aria-pressed', which === 'peak' ? 'true' : 'false');
}

function previewAudioHandlers() {
  let src = null;
  const stop = () => {
    if (!src) return;
    try { src.stop(); } catch { /* already stopped */ }
    try { src.disconnect(); } catch { /* ignore */ }
    src = null;
  };
  const play = (offsetSec, durationSec) => {
    stop();
    const buffer = pendingWorldStart?.extra?.playBuffer;
    const ctx = audioEngine?.ctx;
    if (!buffer || !ctx) return;
    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    node.buffer = buffer;
    node.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.72;
    const start = Math.max(0, offsetSec || 0);
    const dur = Math.max(0.2, durationSec || 8);
    node.start(0, start, dur);
    src = node;
    node.onended = () => { if (src === node) src = null; };
  };
  return { play, stop };
}

/** One card for the select grid. CSS swatch is the fallback until a real
 *  still from this song's world instance is ready. */
function worldCardEl({
  worldId, playWorldId, name, tagline, kind, description, previewLabel,
}) {
  const card = document.createElement('article');
  card.className = 'worldCard';
  card.dataset.worldId = playWorldId;
  card.dataset.baseWorldId = worldId;
  card.tabIndex = 0;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${name}. ${tagline}. Preview or play in this world.`);

  const preview = document.createElement('div');
  preview.className = `worldCardPreview ${kind}`;
  const still = document.createElement('img');
  still.className = 'worldCardStill hidden';
  still.alt = '';
  const live = document.createElement('canvas');
  live.className = 'worldCardLive hidden';
  preview.appendChild(still);
  preview.appendChild(live);
  card.appendChild(preview);
  if (previewLabel) {
    const note = document.createElement('p');
    note.className = 'worldCardWhy worldCardPreviewNote'; note.textContent = previewLabel;
    card.appendChild(note); still.alt = previewLabel;
  }

  const top = document.createElement('div');
  top.className = 'worldCardTop';
  const nameEl = document.createElement('span');
  nameEl.className = 'worldCardName';
  nameEl.textContent = name;
  top.appendChild(nameEl);
  card.appendChild(top);

  const tag = document.createElement('p');
  tag.className = 'worldCardTag';
  tag.textContent = tagline;
  card.appendChild(tag);

  if (description) {
    const why = document.createElement('p');
    why.className = 'worldCardWhy';
    why.textContent = description;
    card.appendChild(why);
  }

  const actions = document.createElement('div');
  actions.className = 'worldCardActions';
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'worldCardPreviewBtn';
  previewBtn.textContent = 'Preview';
  previewBtn.setAttribute('aria-label', `Preview ${name}`);
  previewBtn.setAttribute('aria-pressed', 'false');
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'worldCardPlayBtn';
  playBtn.textContent = 'Play';
  playBtn.setAttribute('aria-label', `Play in ${name}`);
  actions.appendChild(previewBtn);
  actions.appendChild(playBtn);
  card.appendChild(actions);

  return card;
}

/** Fill the select grid with one equal-choice card per registered world. */
function renderWorldGrid(customWorld, features = null, extras = {}) {
  if (!worldSelectGridEl) return;
  worldSelectGridEl.textContent = '';
  for (const choice of buildWorldChoices(listWorlds(), customWorld, features, extras)) {
    worldSelectGridEl.appendChild(worldCardEl(choice));
  }
}

// Title-screen world choice (TitleWorldChoice.js): one option per
// registered world after the two fixed ones, and the remembered pick.
if (titleWorldEl && !ALL_WORLDS) {
  titleWorldEl.closest('.titleWorldRow')?.classList.add('hidden');
}
if (titleWorldEl && ALL_WORLDS) {
  for (const world of listWorlds()) {
    const opt = document.createElement('option');
    opt.value = world.id;
    opt.textContent = world.name;
    titleWorldEl.appendChild(opt);
  }
  const remembered = resolveTitleWorldChoice(readTitleWorld(), listWorlds().map((w) => w.id));
  titleWorldEl.value = remembered.id ?? remembered.mode;
  titleWorldEl.addEventListener('change', () => writeTitleWorld(titleWorldEl.value));
}

function offerWorldsThenStart(data, extra = {}) {
  try {
    clearCustomWorld();
    // A song's look comes from its identity when it has one: the opening's
    // profile and seed, kept for every later play (OpeningAnalysis.js).
    const identity = data.songIdentity || null;
    const identityProfile = identity?.songProfile?.version === PROFILE_VERSION ? identity.songProfile : null;
    const profile = identityProfile || (data.songProfile?.version === PROFILE_VERSION ? data.songProfile : buildSongProfile({
      energyCurves: data.energyCurves,
      durationMs: data.durationMs,
      bpm: data.bpm,
      beatPeriodMs: data.beatPeriodMs,
      confidence: data.confidence,
      freeTime: data.freeTime,
      analysis: data.analysis,
      structure: data.structure,
      timeline: data.timeline,
      barGrid: data.barGrid,
    }));
    const features = profile.watch;
    const autoSeed = Number.isFinite(identity?.seed)
      ? identity.seed >>> 0
      : resolveSongSeed({ timeline: data.timeline, durationMs: data.durationMs }, null);
    const seed = autoSeed;
    if (!identity) data.songIdentity = { seed: autoSeed, songProfile: profile, customBiome: data.customBiome || null };
    pendingWorldStart = { data, extra, features, seed, profile };
    // The song's real mountain range (RangeLibrary): matched and loaded in
    // the background while the picker is up. One small module, normally
    // ready long before a card is clicked. Kept on the song's data so it
    // survives the rebuilds a song goes through (seek, replay, export).
    const pendingForRange = pendingWorldStart;
    pendingForRange.terrainReady = prepareSongTerrain(profile, seed).then((terrain) => {
      pendingForRange.data.terrain = terrain;
      return terrain;
    });
    lastFitDiagnostic = recordFitDiagnostic(features, profile);
    if (!ALL_WORLDS) {
      // One world: start in it. The home biome's ranges have to be there
      // first -- there is no picker to cover the load -- and an export waits
      // for every biome, so its frames never depend on load timing.
      const mine = pendingWorldStart;
      const exporting = !!(extra.exportMode || readBulkExportFromUrl());
      const ready = mine.terrainReady.then((t) => (exporting && t?.whenAll ? t.whenAll.then(() => t) : t));
      const wait = exporting ? ready : Promise.race([ready, new Promise((r) => setTimeout(r, BIOME_WAIT_MS))]);
      wait.then(() => {
        if (pendingWorldStart !== mine) return;
        playSelectedWorld(ONE_WORLD_ID);
      });
      return;
    }
    // A world already chosen on the title screen: start in it, no picker.
    const titleChoice = resolveTitleWorldChoice(titleWorldEl?.value ?? readTitleWorld(),
      listWorlds().map((w) => w.id));
    // Skipping the picker leaves no time for the range to load in the
    // background, so wait for it -- briefly; it never rejects, and a slow
    // load still falls back to the bundled Tetons rather than holding the
    // song. A newer load starting in the meantime wins.
    if (titleChoice.mode !== ASK_WORLD) {
      const mine = pendingWorldStart;
      const go = () => {
        if (pendingWorldStart !== mine) return;
        if (titleChoice.mode === TITLE_AUTO) chooseRecommendedWorld();
        else playSelectedWorld(titleChoice.id);
      };
      Promise.race([mine.terrainReady, new Promise((r) => setTimeout(r, RANGE_WAIT_MS))]).then(go);
      return;
    }
    const hasLabels = Array.isArray(data.structure?.labels) && data.structure.labels.length > 1;
    renderWorldGrid(null, features, { hasLabels });
    worldSelectEl?.classList.remove('hidden');
    if (worldSelectEl && !worldSelectEl.open) worldSelectEl.showModal();
    startChooserPreviews();
  } catch (err) {
    // The grid is a convenience; analysis failing must still start a song.
    console.error('[world chooser]', err);
    pendingWorldStart = { data, extra };
    lastFitDiagnostic = null;
    confirmWorld(data.worldId || lastWorldId || DEFAULT_WORLD_ID);
  }
}

function startChooserPreviews() {
  stopWorldPreview();
  const pending = pendingWorldStart;
  if (!pending) return;
  const audio = previewAudioHandlers();
  previewSession = new PreviewSession({
    data: { ...pending.data, profile: pending.profile },
    features: pending.features,
    seed: pending.seed,
    reducedFlash,
    reducedMotion,
    playAudio: audio.play,
    stopAudio: audio.stop,
    onStill: ({ worldId, dataUrl }) => applyWorldStill(worldId, dataUrl),
    onPreviewStart: ({ worldId }) => setPreviewingCard(worldId),
    onPreviewFrame: ({ worldId, canvas }) => showPreviewFrame(worldId, canvas),
    onPreviewEnd: () => setPreviewingCard(null),
  });
  syncPassageButtons();
  loadPreviewRenderer().then(() => {
    if (previewSession && pendingWorldStart === pending) previewSession.enqueueAll();
  }).catch((err) => console.warn('[world preview] renderer failed', err));
}

function playSelectedWorld(baseWorldId) {
  baseWorldId = resolveWorldId(baseWorldId);
  const baseWorld = listWorlds().find((world) => world.id === baseWorldId);
  if (!baseWorld) return;

  // Preview audio/timing must not leak into the performance.
  if (previewSession) previewSession.stopPreview();

  try {
    const pending = pendingWorldStart;
    if (!pending?.features && !pending?.profile) throw new Error('Missing song profile for world variant');
    const { world } = buildWorldVariant(baseWorldId, pending.features, {
      ...pending.data,
      profile: pending.profile,
    });
    const current = getCustomWorld();
    if (current?.instanceId !== world.instanceId) setCustomWorld(world);
    confirmWorld(world.id);
  } catch (err) {
    // A tailored palette or terrain is additive. If it cannot be made, the
    // player still gets the world they selected instead of a dead-end picker.
    console.warn('[world variant] failed; starting stock world:', err);
    clearCustomWorld();
    confirmWorld(baseWorldId);
  }
}

function previewSelectedWorld(baseWorldId) {
  if (!previewSession) return;
  loadPreviewRenderer().then(() => {
    if (previewSession) previewSession.preview(baseWorldId);
  }).catch((err) => {
    console.warn('[world preview]', err);
  });
}

function recordFitDiagnostic(features, profile) {
  if (!features) return null;
  const ranked = scoreWorlds(features, undefined, { profile });
  const confidence = Number.isFinite(profile?.confidence?.overall)
    ? profile.confidence.overall
    : null;
  return {
    ranked,
    confidence,
    lines: formatFitDiagnostic(ranked, { confidence }),
  };
}

function chooseRecommendedWorld() {
  const pending = pendingWorldStart;
  if (!pending?.features) return;
  const diagnostic = lastFitDiagnostic?.ranked?.length
    ? lastFitDiagnostic
    : recordFitDiagnostic(pending.features, pending.profile);
  lastFitDiagnostic = diagnostic;
  const pick = pickRecommended(diagnostic?.ranked || []);
  if (pick?.id) playSelectedWorld(pick.id);
}

worldSelectGridEl?.addEventListener('click', (e) => {
  const previewBtn = e.target?.closest?.('.worldCardPreviewBtn');
  if (previewBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = previewBtn.closest('.worldCard');
    if (card?.dataset?.baseWorldId) previewSelectedWorld(card.dataset.baseWorldId);
    return;
  }
  const card = e.target?.closest?.('.worldCard');
  const baseWorldId = card?.dataset?.baseWorldId;
  if (!baseWorldId) return;
  playSelectedWorld(baseWorldId);
});

worldSelectGridEl?.addEventListener('keydown', (e) => {
  // Buttons keep their native Enter/Space activation; card shortcuts are
  // only for focus on the card itself. Do not steal Preview's Enter key.
  if (!e.target?.classList?.contains('worldCard')) return;
  const cards = [...(worldSelectGridEl?.querySelectorAll('.worldCard') || [])];
  const current = document.activeElement?.closest?.('.worldCard');
  const index = Math.max(0, cards.indexOf(current));
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    cards[moveChoiceIndex(index, 1, cards.length)]?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    cards[moveChoiceIndex(index, -1, cards.length)]?.focus();
  } else if (e.key === 'Enter') {
    if (current?.dataset?.baseWorldId) {
      e.preventDefault();
      playSelectedWorld(current.dataset.baseWorldId);
    }
  } else if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
    if (current?.dataset?.baseWorldId && e.target?.classList?.contains('worldCard')) {
      e.preventDefault();
      previewSelectedWorld(current.dataset.baseWorldId);
    }
  }
});

worldPassageQuietEl?.addEventListener('click', () => {
  previewSession?.setPassage('quiet');
  syncPassageButtons();
});
worldPassagePeakEl?.addEventListener('click', () => {
  previewSession?.setPassage('peak');
  syncPassageButtons();
});
worldChooseForMeEl?.addEventListener('click', () => chooseRecommendedWorld());


/** Step the armed export clock to `timeMs` and draw that instant.
 *  stepExportClock takes whole fixed steps, so the frame is drawn -- and
 *  reported -- at the instant actually simulated, up to one step short of
 *  the one asked for; the remainder carries into the next frame.
 *  `beforeDraw` (evidence fixtures only) runs after the clock has stepped
 *  and before the one draw, so a fixture configures the frame it captures
 *  instead of painting a second time over the natural one. */
function renderExportFrame(timeMs, { beforeDraw = null } = {}) {
  if (!bulkExportArmed || !sim || !renderer) throw new Error('Bulk export is not armed.');
  const target = Number(timeMs);
  if (!Number.isFinite(target)) throw new Error('Export frame time is not a number.');
  if (audioEngine?.master) audioEngine.master.gain.value = 0;
  if (audioEngine?.ctx?.state === 'running') audioEngine.ctx.suspend();
  try {
    const advanced = stepExportClock({
      simTime,
      targetMs: target,
      stepMs: STEP_MS,
      step: (dt, at) => sim.step(dt, at),
    });
    simTime = advanced.simTime;
    if (typeof beforeDraw === 'function') beforeDraw();
    const drawsBefore = renderer.drawCount ?? 0;
    const result = renderer.draw(sim, 0);
    if (!result?.presented || !renderer.getCaptureSource()) throw new Error(`Export presentation failed: ${result?.reason || 'no completed frame'}.`);
    return {
      width: canvas.width, height: canvas.height, timeMs: simTime,
      draws: (renderer.drawCount ?? 0) - drawsBefore,
      presented: true, generation: result.generation, frameId: result.frameId,
    };
  } catch (err) {
    abortBulkExport();
    throw failBulkExport(`Export presentation failed: ${err?.message || err}`);
  }
}

function abortBulkExport() {
  bulkExportArmed = false;
  bulkExportSize = null;
  bulkPresentation = null;
  abortRecording('Export presentation failed; the recording was discarded.');
  stopTimeline({ preservePause: true });
  rangePresentation?.dispose();
}

/** Rebuild the current song at an exact frame size and arm the export clock.
 *  The seed and the decoded buffer carry over, so each resolution is the
 *  same performance. */
function beginBulkExport({ width, height, presentation: override } = {}) {
  const size = evenExportSize({ w: width, h: height });
  if (!size) throw new Error(`Export size must be even and at least 2×2 (got ${width}×${height}).`);
  if (!lastTimelineData) throw new Error('Load a song before exporting.');
  // An export is the whole song: never render one from its opening alone.
  if (lastTimelineData.opening) throw new Error('Still analysing the whole song. Try the export again in a few seconds.');
  if (lastTimelineData.terrain && !lastTimelineData.terrain.allLoaded) throw new Error('Still loading the song\'s biomes. Try the export again in a few seconds.');
  const extra = {
    playBuffer: lastAudioBuffer || undefined,
    exportMode: true,
    exportSize: size,
    exportPresentation: override ? resolvePresentation(resolveDisplayPrefs({ saved: override })) : { ...effectivePresentation() },
    exportQualityLevel: perfGovernor?.level ?? perfStartLevel,
    startAtMs: 0,
    fitDiagnostic: lastFitDiagnostic,
  };
  if (lastSongSeed != null) extra.songSeed = lastSongSeed;
  startTimeline(lastTimelineData, extra);
  if (!bulkExportArmed || !sim || canvas.width !== size.w || canvas.height !== size.h) {
    throw new Error(`Export armed at ${canvas.width}×${canvas.height}, wanted ${size.w}×${size.h}.`);
  }
  return {
    durationMs: conductor?.durationMs || 0,
    width: canvas.width,
    height: canvas.height,
    seed: sim.songSeed,
    worldId: sim.worldId,
  };
}

// How long starting a world waits for a lyrics lookup still in flight. The
// picker usually covers it; a slow network must not hold the song longer.
const LYRICS_START_WAIT_MS = 2000;

function confirmWorld(id) {
  const pending = pendingWorldStart;
  pendingWorldStart = null;
  if (!pending) return;
  const lyricsReady = pending.extra?.lyricsReady;
  if (lyricsReady && !lyricsReady.settled) {
    const gen = loadGen;
    Promise.race([lyricsReady, new Promise((r) => setTimeout(r, LYRICS_START_WAIT_MS))]).then(() => {
      // A newer song chosen while waiting wins.
      if (gen !== loadGen) return;
      startConfirmedWorld(pending, id);
    });
    return;
  }
  startConfirmedWorld(pending, id);
}

function startConfirmedWorld(pending, id) {
  id = resolveWorldId(id);
  stopWorldPreview();
  lastWorldId = id;
  pending.data.worldId = id;
  closeWorldChooser();
  // World select can sit for a while; a suspended context would start a
  // silent, frozen first frame that reads as "upload did nothing."
  // Bulk export keeps the context suspended: the file's audio is the
  // source track, muxed later, and a live play would fight the stepped clock.
  const extra = { ...(pending.extra || {}) };
  if (pending.seed != null && extra.songSeed === undefined) extra.songSeed = pending.seed;
  const exporting = !!(extra.exportMode || readBulkExportFromUrl());
  if (!exporting) audioEngine?.resume?.();
  // A recording already has every voice. The timeline synth (oscillator
  // "keyboard" tones + hat/kick clicks) must not sit on top of it.
  if (extra.playBuffer) muteTimelineSynth = true;
  startTimeline(pending.data, extra);
  if (running) canvas.focus({ preventScroll: true });
  if (extra.playBuffer) {
    lastAudioBuffer = extra.playBuffer;
    if (!exporting) audioEngine.playBuffer(extra.playBuffer, 0);
  }
}

/** Name the real ranges behind The Range (RangeCaption.js): one caption per
 *  biome the song travels through, or one for the song's single range. */
function applyRangeCaptions(timelineData, exportMode) {
  const terrain = timelineData.terrain || null;
  const kind = getWorld(sim.worldId)?.kind;
  const lengthOf = (p) => (p?.spacingM > 0 && p.angles?.length > 1 ? p.spacingM * (p.angles.length - 1) : 0);
  const captionFor = (range, ridges, profiles, biome) => {
    const farM = lengthOf(profiles?.L2) || NaN;
    // Miles sampled covers every real ridge on screen; the speed is the back
    // ridge's, the one the travel is measured on.
    const sampledM = ['L2', 'L3', 'L4'].reduce((sum, k) => sum + lengthOf(profiles?.[k]), 0) || NaN;
    return rangeCaptionFor(range, kind, {
      lengthKm: sampledM / 1000,
      speedMps: groundSpeedMps({
        curves: sim.biomes?.energyCurves,
        durationMs: conductor?.durationMs,
        lengthM: farM,
        stripWidth: TERRAIN_STRIP_WIDTH,
        response: sim.biomes?.world?.response,
        viewWidth: sim.biomes?.w || STAGE_W,
      }),
    }, ridges, biome);
  };
  sim.rangeCaption = null;
  sim.rangeCaptions = null;
  const shown = [];
  const sections = sim.biomes?.sections || [];
  if (kind === 'alpine' && terrain?.byBiome && sim.biomes?.world?.realBiomes && sections.length) {
    // One caption per biome, the first time the song arrives in it --
    // timed to land as the travel into it finishes.
    const captions = [];
    const seen = new Set();
    sections.forEach((sec, i) => {
      const name = sec.profile;
      if (!name || seen.has(name)) return;
      seen.add(name);
      const own = terrain.byBiome.get(name);
      const entry = own || terrain.byBiome.get(terrain.home);
      if (!entry) return;
      const info = realBiomeByName(name);
      // The horizon's and the massif's skylines are the song's, not a
      // biome's: named once, first.
      const ridges = i === 0
        ? { ...entry.ranges, horizon: terrain.horizon?.range, massif: terrain.massif?.range }
        : entry.ranges;
      // Range v2 draws this biome from a curated view: name that place.
      const scene = rangePresentation?.captionViewFor?.(name);
      const caption = scene
        ? sceneCaptionFor(scene, i === 0 && !rangePresentation?.tourMode ? { horizon: terrain.horizon?.range, massif: terrain.massif?.range } : {},
          info ? { title: info.title, ecoregion: scene.place } : null)
        : captionFor(entry.ranges.far, ridges, entry.profiles, info && own ? {
          title: info.title,
          ecoregion: ecoregionOfRange(entry.ranges.far?.id),
        } : null);
      if (!caption) return;
      const atMs = i === 0 ? 0 : Math.max(0, sec.startMs + travelMs(sec) - CAPTION_DELAY_MS);
      captions.push({ atMs, caption });
      if (!scene) shown.push(entry.ranges.near, entry.ranges.mid, entry.ranges.far);
    });
    sim.rangeCaptions = captions.length ? captions : null;
  } else {
    const profiles = sim.biomes?.terrainProfiles || {};
    sim.rangeCaption = captionFor(terrain?.range || null, terrain?.ranges || {}, profiles, null);
    if (sim.rangeCaption) shown.push(terrain?.ranges?.near, terrain?.ranges?.mid, terrain?.range);
  }
  if (!exportMode) {
    for (const r of shown) if (r?.id) noteRangeShown(r.id);
  }
  syncCaptionDetails();
}
function syncCaptionDetails() {
  const caption = sim?.biomes?.world?.kind === 'alpine' ? captionAt(sim.rangeCaptions || sim.rangeCaption, sim.timeMs)?.caption : null;
  setCaptionDetails(rangeCaptionDetailsEl, caption || null);
}

function startTimeline(timelineData, extra = {}) {
  const {
    songSeed: seedOverride = undefined, playBuffer, live = false,
    startAtMs = 0, startAtWallMs = 0, preservePause = false, captureMode: captureModeFlag = false,
    exportMode: exportModeFlag = false, exportSize = null, keepAudio = false,
  } = extra;
  lastStartExtra = { ...extra, chapterState: null, keepAudio: false, startAtMs: 0, startAtWallMs: 0, keepUserCamera: false };
  const fromUrl = exportModeFlag ? null : readBulkExportFromUrl();
  const exportMode = !!(exportModeFlag || fromUrl);
  const exportQualityLevel = extra.exportQualityLevel ?? perfGovernor?.level ?? perfStartLevel;
  if (exportMode) {
    bulkPresentation = extra.exportPresentation || { ...presentation };
    const requested = exportSize || fromUrl || bulkExportSize;
    const size = evenExportSize(requested);
    if (!size) {
      throw failBulkExport(`Bulk export needs an even frame size of at least 2×2 (got ${requested?.w}×${requested?.h}).`);
    }
    if (typeof window !== 'undefined') window.__SMW_EXPORT_ERROR = null;
    bulkExportSize = size;
    bulkExportArmed = true;
  } else {
    bulkExportSize = null;
    bulkExportArmed = false;
    bulkPresentation = null;
  }
  // Bulk export is a full capture on a stepped clock: the same zero lead and
  // frame-0 prime as captureMode, so it rides that path (and CaptureClock's
  // zero-latency choreography) rather than keeping a parallel special case.
  const captureMode = captureModeFlag || exportMode;
  // An export rebuild must not resume the context on the way through
  // stopTimeline: that resume is asynchronous and would land after the
  // suspend below, leaving the song playing under a stepped clock.
  stopTimeline({ preservePause: preservePause || exportMode, keepAudio });
  fitCanvas();
  // Any path that is about to play a decoded recording (confirmWorld,
  // replay) mutes the timeline synth. Live listening mutes it for the same
  // reason from the other direction: the song is already in the room. MIDI
  // and the procedural demo pass neither and keep it.
  if (playBuffer || live) muteTimelineSynth = true;
  applySynthMutePolicy();
  // Guard a degenerate declared duration (<=0): without it, FractureEngine's
  // idle -> about-to-freeze transition never fires and the song never
  // completes -- the engine would just run forever.
  timelineData.durationMs = resolveDurationMs(timelineData.timeline, timelineData.durationMs);
  timelineData.worldId = resolveWorldId(timelineData.worldId || lastWorldId || DEFAULT_WORLD_ID);
  timelineData.ridgeResponse ??= getWorld(timelineData.worldId || lastWorldId || DEFAULT_WORLD_ID)?.response;
  ensureRidgeMusicSession(timelineData);
  lastTimelineData = timelineData;
  // Keep lastAudioBuffer across replays (same song, new/same seed). Loaders
  // that switch song type clear it themselves — wiping it here made
  // "New seed" / "Replay seed" start a silent level after any audio drop.
  conductor.load(timelineData);
  // Starting part-way in (a recognised song already playing in the room):
  // move the dispatch cursors with the clock, or the first frame fires every
  // note between zero and here at once -- the whole first half of the song
  // arriving in one step.
  if (startAtMs > 0) conductor.seekTo(startAtMs);
  // A fresh governor per song starts at the selected quality. Pixel detail
  // and scale stay independent of the Auto/Economy choice.
  perfGovernor = new PerfGovernor({
    startLevel: exportMode ? exportQualityLevel : perfStartLevel,
    economy: effectivePresentation().quality === 'economy',
  });
  // An offline frame's period is its draw time, which the ladder would read
  // as pressure and shed the picture the file exists to keep.
  if (exportMode) perfGovernor.freezeQuality(effectivePresentation().quality === 'economy' ? PERF_MAX_LEVEL : exportQualityLevel);
  fitCanvas(); // sync the new governor's canvasWidth/scale to the live buffer
  // World construction (parallax strips, landmarks) is CPU-heavy; surface a
  // progress line so a multi-second bake never looks like a dead freeze.
  showProgress('Building world…');
  // Seed: explicit replay override, otherwise the song-derived default.
  const pinned = seedOverride !== undefined ? seedOverride : null;
  try {
    if (rangePresentation?.tourMode && timelineData.terrain && getWorld(timelineData.worldId)?.kind === 'alpine') {
      timelineData.terrain._rangeTourOriginalBiomes ||= [...timelineData.terrain.biomes];
      timelineData.terrain.biomes = ['CONIFER'];
    }
    sim = new Simulation(conductor, paramBus, {
      bpm: timelineData.bpm || 120,
      rangeListening,
      rangeNarrative: timelineData.rangeNarrative || null,
      energyCurves: timelineData.energyCurves || null,
      ridgeMusicSession: timelineData.ridgeMusicSession,
      // An opening-only analysis must not schedule the finale off the
      // opening's last note (SongFinale.analyzeSongFinale).
      analyzedThroughMs: timelineData.opening ? timelineData.opening.analyzedMs : null,
      // Logical stage always 1280×720 — canvas buffer may be 4K.
      canvasWidth: STAGE_W,
      canvasHeight: STAGE_H,
      customBiome: timelineData.customBiome || null,
      // ChoreoClock: live output-latency getter so beat-anchored envelopes
      // peak when the EAR gets the beat (Bluetooth can lag 200ms+), except
      // while exporting, where audio and video share the source clock.
      outputLatencyMs: () => choreographyOutputLatencyMs(),
      // ChoreoClock leg 3: how far ahead frame() steps the world so a frame
      // depicts the moment it reaches the screen, not the moment it was
      // built. Handed in so scoring can subtract it back out.
      visualLeadMs: captureMode ? 0 : VISUAL_LEAD_MS,
      lyricSections: timelineData.lyricSections || null,
      syncedLyrics: timelineData.syncedLyrics || null,
      lyricSession: timelineData.lyricSession || null,
      // SSM structure read (StructureAnalyzer), audio path only. Null on
      // MIDI/demo/free-time, where BiomeManager keeps its own band-energy
      // novelty schedule.
      structure: timelineData.structure || null,
      // The raw-audio Krumhansl timeline is the authoritative live key read;
      // passing it through keeps VibeDirector/KeyDirector aligned with the
      // analysis fingerprint used to build the world's palette.
      tonalityTimeline: timelineData.tonalityTimeline || null,
      // The one piece of state that outlives the song: what previous
      // sessions learned about how this player hears a beat.
      groove,
      songSeed: pinned,
      // The demo song's own authored cue sheet (ConductorTrack.js); always
      // null for any uploaded/dropped file.
      conductorCues: timelineData.conductor || null,
      worldId: timelineData.worldId || lastWorldId || DEFAULT_WORLD_ID,
      // The song's matched real range, if it loaded; Simulation falls back to
      // the bundled Tetons, and uses real terrain only in alpine-kind worlds.
      terrainProfiles: timelineData.terrain?.profiles || null,
      songTerrain: timelineData.terrain || null,
      residency: sharedResidency(),
      chapterState: extra.chapterState || (timelineData.chapterState?.seed === pinned ? timelineData.chapterState : null),
    });
  } catch (err) {
    console.error('[world build failed]', err);
    progressEl.classList.add('hidden');
    loaderEl.classList.remove('hidden');
    showErrorBanner('Could not build the world: ' + (err?.message || err));
    return;
  }
  sim.audioOverview = timelineData.audioOverview || null;
  // The listener's zoom (scroll wheel, pinch) is live-only: exports and
  // captures draw the authored camera. A new song starts unzoomed; a seek
  // or a mid-song rebuild keeps the zoom where it is.
  sim.userCameraEnabled = !captureMode;
  // Seeks (to 0 too) and the mid-song full-analysis rebuild say so with
  // keepUserCamera; a new song or a replay starts unzoomed.
  if (!extra.keepUserCamera) rangeUserCamera.reset();
  sim.analysisOpening = timelineData.opening || null;
  // This snapshot belongs to the song, beyond Simulation teardown/rebuild.
  if (!timelineData.opening) timelineData.rangeNarrative = sim.rangeNarrative;
  if (sim.biomes.chapterPlan) timelineData.chapterState = {
    seed: sim.songSeed, previous: sim.biomes.chapterPlan, committedThroughMs: timelineData.durationMs,
  };
  lastSongSeed = sim.songSeed;
  sim.perf = perfGovernor;
  // A song start is the expensive moment (strip bakes, cold paths); don't let
  // that hitch vote on the shed level -- see PerfGovernor.WARMUP_MS.
  perfGovernor.beginWarmup(performance.now());
  sim.setReducedFlash(reducedFlash);
  sim.setReducedMotion(reducedMotion);
  sim.setVisualStyle(visualStyle);
  // Prime one sim step so BiomeManager/update dials (haze, calm, etc.) are
  // initialized before the first paint — a zero-dt first rAF used to draw
  // with undefined multipliers and throw on rgba(...,NaN).
  try {
    if (!(startAtMs > 0)) {
      if (captureMode) { sim.step(0, 0); simTime = 0; }
      else { sim.step(STEP_MS, STEP_MS); simTime = STEP_MS; }
    }
  } catch (err) {
    console.warn('[sim prime]', err);
  }
  // Exposed for DebugOverlay only -- resolved song identity has no other
  // consumer in the sim itself (SectionFusion already folded the lyric
  // structure into BiomeManager.sections by this point).
  sim.lyricIdentity = timelineData.lyricIdentity || null;
  sim.fitDiagnostic = extra.fitDiagnostic || lastFitDiagnostic || null;
  // Live listening runs its arc against a nominal length, because the song
  // has not finished happening. Flagged so the transport draws the total as
  // the estimate it is rather than as a measurement.
  sim.estimatedDuration = !!timelineData.estimatedDuration;
  // Canvas is always the scene compositor; 'webgl' adds a non-destructive
  // overlay. Created here per song, after the world is known.
  renderer = createPresentingRenderer({ canvas, mode: rendererMode, presentation: effectivePresentation(), residency: sharedResidency() });
  if (rangePresentation) {
    rangePresentation.setSong({ terrain: timelineData.terrain || null, mgr: sim.biomes, generation: loadGen, exportMode });
    renderer.rangePresentation = rangePresentation;
  }
  // An exported frame is the picture, not the player: no seekbar strip.
  if (exportMode) renderer.hudInFrame = false;
  // enabled stays false (opt-in via V); provider/key/model/endpoint persist
  // across songs since they're a machine-level setting, not a per-song one.
  visionLoop = new VisionLoop(canvas, paramBus, sim, { enabled: false, perfGovernor, ...readVisionConfig() });
  debugOverlay = new DebugOverlay(debugOverlayEl, sim, paramBus, visionLoop, perfGovernor, drawErrors);
  debugOverlay.presentationDiagnostics = () => renderer?.diagnostics;
  debugOverlay.onVisionConfigChange = persistVisionConfig;
  renderTracks(timelineData.tracks, timelineData.pairs);
  if (filmstripEl) { filmstripEl.innerHTML = ''; filmstripEl.classList.add('hidden'); }

  acc = 0;
  lastRafMs = null;
  playbackCadence.reset(); presentedFps.reset(); fpsEma = null;
  // Fresh song, fresh button: the demo/play buttons must lose focus so a
  // stray keypress never re-"clicks" them.
  document.activeElement?.blur?.();
  audioEngine.restoreLevel?.(0.85);
  // A recognised song is already playing in the room, some way in. The clock
  // every system reads (AudioEngine.nowMs) is just an offset from the context
  // time, so starting it AT that position is all it takes for the whole show
  // -- notes, sections, the arc -- to arrive already in step with the music.
  //
  // But the position was measured BEFORE everything above ran, and building a
  // world takes seconds (strip bakes, cold paths). Starting at the raw
  // measurement would put the show that far behind the music -- measured at
  // about two seconds, which the periodic re-sync then had to correct as a
  // visible jump rather than an ease. So the wall-clock time spent getting
  // here is added back: `startAtWallMs` is when `startAtMs` was true.
  // Kept audio is still playing (or paused) where it was: the show joins it
  // at the clock's own position, which the build above moved on from.
  const startedAt = keepAudio
    ? audioEngine.nowMs
    : (startAtWallMs > 0 ? startAtMs + (performance.now() - startAtWallMs) : startAtMs);
  if (keepAudio) conductor.seekTo(startedAt);
  else audioEngine.start(startedAt);
  if (captureMode) captureClock.beginFullCapture(startedAt);
  else captureClock.resetLive(startedAt);
  const presentationLeadMs = captureClock.leadMs;
  // A live re-analysis rejoins here, after the build: the land's swells
  // start from boundaries after this point only (RangeFrame.landMoment01).
  // On the heard clock, as the first rebuilt frame samples it (Simulation.step).
  if (keepAudio) sim.biomes?.commitLandRejoin?.(visualNow(startedAt + presentationLeadMs, choreographyOutputLatencyMs()));
  if (startedAt > 0) sim.startAt(startedAt + presentationLeadMs);
  // Both seeded in led time (see frame()), or the first frame would see the
  // whole lead as a delta and spend it on fixed steps nobody asked for.
  simTime = startedAt + presentationLeadMs;
  // After start(), not before: the clock's origin has only just been set, and
  // reading it earlier leaves the first frame with a delta of the entire
  // start offset -- which the 250ms clamp then turns into a quarter second of
  // sim time nobody asked for.
  lastNowMs = audioEngine.nowMs + presentationLeadMs;
  if (exportMode) {
    // The source file is muxed in later. Silence the graph and freeze the
    // audio clock; renderExportFrame advances simTime on its own.
    if (audioEngine.master) audioEngine.master.gain.value = 0;
    paused = true;
    try { audioEngine.ctx.suspend(); } catch { /* already suspended */ }
    lastNowMs = simTime;
  }
  // Bake the biome on screen before the first paint. The next section's
  // set is pumped a layer at a time from Simulation, ahead of its boundary.
  // The presentation is attached first (Renderer.draw would do it on the
  // first frame), so strips for biomes Range v2 covers are adopted as
  // evictable fallback from the start.
  if (rangePresentation?.enabled && sim.biomes) sim.biomes.rangePresentation = rangePresentation;
  try { if (!rangePresentation?.tourMode) sim.biomes.preparePlaybackStrips(); }
  catch (err) { console.warn('[strip prepare]', err); }
  running = true;
  syncKeepAwake();
  stopTitleBackdrop();

  progressEl.classList.add('hidden');
  loaderEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  rangeNavigationEl?.classList.remove('hidden');
  if (rangeSeekEl) { rangeSeekEl.max = String((conductor.durationMs || 0) / 1000); rangeSeekEl.value = String(startedAt / 1000); }
  wakeHud();
  // Name the real range behind The Range. The renderer draws it on the
  // canvas, so recordings and bulk exports carry it. Chrome must never stop
  // a song: a throw here once aborted starting the world.
  try {
    applyRangeCaptions(timelineData, exportMode);
    // A scenic view that turns out unavailable falls back to legacy
    // scenery; its caption must stop naming the scenic location.
    if (rangePresentation) {
      const owner = sim;
      rangePresentation.onAvailabilityChange = () => {
        if (sim !== owner) return;
        try { applyRangeCaptions(timelineData, exportMode); } catch (err) { console.warn('[range caption]', err); }
      };
      // A view refused GPU room: legacy strips baked for biomes the scene
      // covers are fallback-only and cannot be evicted by the ledger.
      rangePresentation.onBudgetRefusal = (viewId, options) => {
        if (sim !== owner) return;
        sim.biomes?.dropCoveredStrips?.(options);
      };
    }
    // Biomes after the first load in the background; name them once they
    // have, unless the song has been rebuilt since.
    const terrain = timelineData.terrain;
    if (terrain?.whenAll && !terrain.allLoaded) {
      const mine = sim;
      terrain.whenAll.then(() => {
        if (sim !== mine) return;
        try { applyRangeCaptions(timelineData, exportMode); } catch (err) { console.warn('[range caption]', err); }
      });
    }
  } catch (err) {
    console.warn('[range caption]', err);
  }
  if (exportMode) {
    // No rAF loop: the exporter asks for each frame. Frame 0 is drawn now so
    // the first capture is the opening, not an unpainted canvas.
    try {
      const result = renderer.draw(sim, 0);
      if (!result?.presented) throw new Error(result?.reason || 'no completed frame');
    } catch (err) {
      abortBulkExport();
      throw failBulkExport(`Export presentation failed on the first frame: ${err?.message || err}`);
    }
  } else {
    rafHandle = requestAnimationFrame(frame);
  }

  // Exposed for the debug overlay and for smoke-testing internals.
  // `rafHandle` is a live getter (not a snapshot) so smoke tests can
  // precisely confirm stopTimeline() cancels the CURRENT pending frame
  // (rather than inferring it from run rates, which headless Chromium's
  // rAF throttling and AudioContext clock drift make unreliable to assert on).
  window.__SMW = {
    conductor, paramBus, sim, audioEngine, visionLoop, debugOverlay, synth, fontLibrary, sf2Engine, fontRecommender,
    ensureSoundfonts,
    renderer, rendererMode, rendererBackend: renderer?.backend || 'canvas',
    customBiome: timelineData.customBiome || null,
    analysis: timelineData.analysis || null,
    stems: timelineData.stems || null,
    muteTimelineSynth,
    get sourceTrack() { return lastTimelineData?.sourceTrack || null; },
    get trackIdentity() { return lastTimelineData?.lyricIdentity || null; },
    get audioBuffer() { return lastAudioBuffer; },
    songSeed: sim.songSeed,
    worldId: sim.worldId,
    // Which real range the song was matched to (null: bundled Tetons or a
    // non-alpine world), and the ranges on all three ridges.
    terrainRange: timelineData.terrain?.range || null,
    terrainRidges: timelineData.terrain?.ranges || null,
    tracks: timelineData.tracks || [], pairs: timelineData.pairs || [],
    get rafHandle() { return rafHandle; },
    // The shed level decides which passes are running at all (rim light,
    // contact shadows, phenomena, the heavy overlay passes), so "why did
    // that effect disappear a few seconds in" is unanswerable from outside
    // without it. Live getters, not a snapshot: the governor mutates.
    // The real seek, not a clock nudge. Setting audioEngine's origin alone
    // leaves `simTime` where it was, so the sim keeps stepping from the old
    // position and everything downstream of it (the song-progress arc, the
    // celestial approach, the section schedule) stays at the start -- which
    // silently made every seek-based screenshot a picture of second one.
    seek: (ms) => seekSong(ms),
    // tools/bulk-export.mjs drives these: arm at an exact size, then ask for
    // each output frame by time. See docs/video-export.md, "Bulk export".
    get exportReady() { return bulkExportArmed; },
    get durationMs() { return conductor?.durationMs || 0; },
    get exportSize() { return { width: canvas.width, height: canvas.height }; },
    get presentationDiagnostics() { return renderer?.diagnostics || titlePresentation?.diagnostics; },
    get frameRates() { return { presented: presentedFps.fps, callback: fpsEma }; },
    // Device probes: what bounds delivered frames (the FPS cap) and whether
    // the song is paused, so callback cadence is not read as delivery.
    get fpsCap() { return 1000 / fpsCapMs; },
    get paused() { return paused; },
    get displayPrefs() { return { ...displayPrefs }; },
    beginBulkExport: (size) => beginBulkExport(size),
    renderExportFrame: (timeMs, options) => renderExportFrame(timeMs, options),
    get perfLevel() { return perfGovernor?.level ?? null; },
    // The load generation this simulation belongs to; evidence records it
    // so a late response from an older load can be told apart.
    get generation() { return loadGen; },
    get ridgeStateKey() { return lastTimelineData?.ridgeMusicSession?.stateKey ?? null; },
    // Range v2: which renderer the Range uses and why, and a promise that
    // settles once the song's scenic views are prepared or have failed
    // (evidence/export wait on it; playback never does).
    get rangeRenderer() { return rangePresentation?.mode || rangeMode.mode; },
    get rangeState() { return rangeStateSnapshot(); },
    get rangeTourStatus() { return currentTourControlState(); },
    rangeReady: (opts) => (rangePresentation ? rangePresentation.whenReady(opts) : Promise.resolve({ mode: 'legacy' })),
    // Export: after a frame, wait for the scenic views it lacked; true means
    // the caller should redraw the same heard time (deterministic).
    rangeSettle: (opts) => (rangePresentation ? rangePresentation.settle(opts) : Promise.resolve(false)),
    get perf() { return perfGovernor || null; },
    // Car mode (KeepAwake.js): live state for debugging on a head unit, plus
    // the one hook a smoke test needs -- backdating the last-input clock, so
    // the wake-tap path can be exercised without idling for a real 20s.
    carMode: {
      keepAwake,
      get lastInputMs() { return lastInputMs; },
      get fullscreenDropped() { return fullscreenDropped; },
      get displaySlept() { return displaySlept; },
      backdateInput: (idleMs) => { lastInputMs = performance.now() - idleMs; },
      simulateDisplaySleep: (idleMs) => {
        lastInputMs = performance.now() - idleMs;
        displaySlept = true;
      },
    },
  };
}

/**
 * A MIDI and audio file dropped TOGETHER: the recording is what you hear,
 * the score is what you see -- an exact description of the visuals for a
 * song the engine would otherwise have to guess at from raw spectra.
 *
 * The two are assumed to share a t=0 origin, which is what exporting them
 * from one project gives you. Nothing here tries to detect or correct an
 * offset: a silently "corrected" sync that guessed wrong would be far worse
 * to author against than one that is always literal.
 *
 * Analysis is skipped entirely (that's the raw-audio path's job) -- the MIDI
 * already states every onset, so energy curves are synthesized from it just
 * as they are for a MIDI-only load. That also makes this path near-instant
 * where a raw-audio drop of the same song takes its separation/pitch pass.
 */
function showProgress(text) {
  progressEl.textContent = text;
  progressEl.classList.remove('hidden');
}

async function loadAudioFile(file) {
  return loadAudioFiles([file]);
}

/** Sums N decoded stems into one stereo mix buffer -- the mix is both the
 *  analysis subject and what actually plays. Stems shorter than the longest
 *  simply end early (silence-padded by construction). */
function sumToMixBuffer(buffers, signal = null) {
  const rate = buffers[0].sampleRate;
  const length = Math.max(...buffers.map((b) => b.length));
  const mix = audioEngine.ctx.createBuffer(2, length, rate);
  // Peak is tracked during the LAST stem's accumulation (sum order doesn't
  // change the result, so the longest stem goes last -- it spans the whole
  // mix, making every out[i] final under it), sparing a separate full scan.
  const ordered = [...buffers].sort((a, b) => a.length - b.length);
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const out = mix.getChannelData(c);
    for (let bi = 0; bi < ordered.length; bi++) {
      throwIfAborted(signal);
      const src = ordered[bi].getChannelData(Math.min(c, ordered[bi].numberOfChannels - 1));
      const last = bi === ordered.length - 1;
      for (let i = 0; i < src.length; i++) {
        out[i] += src[i];
        if (last) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
        if ((i & 0x7fff) === 0) throwIfAborted(signal);
      }
    }
  }
  // Normalize only if the sum actually clips -- quiet stems stay quiet.
  if (peak > 1) {
    const g = 0.98 / peak;
    for (let c = 0; c < 2; c++) {
      const ch = mix.getChannelData(c);
      for (let i = 0; i < ch.length; i++) {
        ch[i] *= g;
        if ((i & 0x7fff) === 0) throwIfAborted(signal);
      }
    }
  }
  return mix;
}

const LYRICS_AUTO_SKIP_MS = 15000;

/** Downmixes a decoded AudioBuffer to one mono Float32Array (plain average
 *  of its channels) -- StemAlign.vocalActivity only wants a single channel
 *  and doesn't know or care about the browser AudioBuffer type. */
function monoChannel(buffer) {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels === 1) return ch0;
  const out = new Float32Array(ch0.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/** LyricsClient's `{synced, plain, instrumental}` result -> LyricStructure's
 *  labeled/emotion-scored blocks -> the lyricSections shape SectionFusion
 *  consumes. Returns null for anything unusable (no match, instrumental
 *  track, or a match with no actual text) -- BiomeManager's fuseSections
 *  already treats a null/absent lyricSections as a strict no-op.
 *
 *  When the lyrics came back plain (no per-line timestamps) AND the drop
 *  included a stem whose filename reads as a true vocal track, this also
 *  tries the StemAlign fallback: syllable-onset detection in that stem,
 *  matched against each block's cumulative syllable count. It's always the
 *  weaker signal (confidence pinned to 0.3) -- kind/valence/intensity still
 *  come from the plain-text label pass; only the timing is borrowed from
 *  the stem. A silent/onset-free stem or any failure in this path simply
 *  falls back to the untimed plain-text labels, exactly as if no stem had
 *  been dropped at all. */
function buildLyricSections(lyricResult, durationMs, vocalStem) {
  if (!lyricResult || lyricResult.instrumental) return null;
  const synced = !!(lyricResult.synced && lyricResult.synced.length);
  const lines = synced ? lyricResult.synced : (lyricResult.plain || []);
  if (lines.length === 0) return null;
  const blocks = toBlocks(lines, { synced });
  if (blocks.length === 0) return null;

  if (!synced && vocalStem) {
    try {
      const mono = monoChannel(vocalStem.buffer);
      const onsets = syllableOnsets(vocalActivity(mono, vocalStem.buffer.sampleRate));
      if (onsets.length > 0) {
        const labeled = labelBlocks(blocks, { durationMs: null }); // plain-text kind/emotion, no timing
        const timed = alignBlocks(blocks, onsets); // stem-derived startMs/endMs only
        return labeled.map((sec, i) => ({
          ...sec,
          startMs: timed[i]?.startMs ?? undefined,
          endMs: timed[i]?.endMs ?? undefined,
          confidence: 0.3,
        }));
      }
    } catch (err) {
      console.warn('[lyrics] stem-aligned syllable fallback failed, using untimed plain labels', err);
    }
  }

  const sections = labelBlocks(blocks, { durationMs });
  return sections.length ? sections : null;
}

/** Shows the identity/lyrics row on the (already-visible) audition panel
 *  and resolves once the player has a verdict: a silent auto-match off the
 *  resolved identity, a manual Find, an explicit Skip, or a 15s auto-skip
 *  so an unattended run never hangs waiting on a human. Always resolves
 *  (never rejects); the resolved value is LyricsClient's raw result or
 *  null ("proceed exactly as before, no lyric data at all"). */
function promptForLyrics(identity, durationSec) {
  return new Promise((resolve) => {
    if (!lyricsRowEl) { resolve(null); return; }
    let settled = false;
    let skipTimer = null;
    const cleanup = () => {
      if (skipTimer) clearTimeout(skipTimer);
      lyricsFindBtnEl?.removeEventListener('click', onFind);
      lyricsSkipBtnEl?.removeEventListener('click', onSkip);
      lyricsNoneBtnEl?.removeEventListener('click', onNever);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      lyricsRowEl.classList.add('hidden');
      resolve(result);
    };
    const armSkipTimer = () => {
      if (skipTimer) clearTimeout(skipTimer);
      skipTimer = setTimeout(() => finish(null), LYRICS_AUTO_SKIP_MS);
    };
    const lookup = (attempt) => fetchLyricsCached(
      { artist: attempt.artist, title: attempt.title, album: attempt.album, durationSec: attempt.durationSec },
      typeof fetch !== 'undefined' ? fetch : null,
    );
    const textOf = hasUsableLyrics;
    const runFind = async (artist, title) => {
      if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
      lyricsFieldsEl?.classList.add('hidden');
      // Timed lyric grounding: walk the identity ladder (LyricGrounding.js)
      // rather than issuing one query and giving up. The tags exactly as
      // they came are always rung one and win if they resolve; each rung
      // after that loosens the identity a little -- modifiers stripped, the
      // album dropped, the artist reduced to the primary act, and so on --
      // because a provider indexes the canonical release and a rip's tags
      // describe a particular file.
      const { result, attempt } = await groundLyrics(
        { artist, title, album: identity.album, durationSec },
        lookup,
        {
          cancelled: () => settled,
          onAttempt: (a, i, total) => {
            if (!lyricsStatusEl) return;
            lyricsStatusEl.textContent = i === 0
              ? 'Searching for lyrics…'
              : `Searching for lyrics… (${i + 1}/${total}: ${a.why})`;
          },
        },
      );
      if (settled) return;
      if (attempt) { artist = attempt.artist ?? artist; title = attempt.title ?? title; }
      const hasText = textOf(result);
      if (hasText) {
        if (lyricsStatusEl) lyricsStatusEl.textContent = `✓ ${result.synced ? 'synced' : 'plain'} lyrics found — ${artist || '?'} — ${title || '?'}`;
        setTimeout(() => finish(result), 700);
      } else {
        if (lyricsStatusEl) lyricsStatusEl.textContent = result?.instrumental ? 'Marked instrumental — no lyrics.' : 'No lyrics found.';
        if (lyricsArtistInputEl) lyricsArtistInputEl.value = artist || '';
        if (lyricsTitleInputEl) lyricsTitleInputEl.value = title || '';
        lyricsFieldsEl?.classList.remove('hidden');
        armSkipTimer();
      }
    };
    const onFind = () => runFind(lyricsArtistInputEl?.value.trim(), lyricsTitleInputEl?.value.trim());
    const onSkip = () => finish(null);
    // Turn timed lyric grounding OFF: skip this song and remember the
    // choice, so future songs skip the lookup entirely (loadAudioFiles reads
    // lyricsDisabled).
    const onNever = () => {
      lyricsDisabled = true;
      setLyricsDisabled(true);
      syncLyricGroundingBtn();
      finish(null);
    };
    lyricsFindBtnEl?.addEventListener('click', onFind);
    lyricsSkipBtnEl?.addEventListener('click', onSkip);
    lyricsNoneBtnEl?.addEventListener('click', onNever);

    lyricsRowEl.classList.remove('hidden');
    lyricsFieldsEl?.classList.add('hidden');
    if (lyricsArtistInputEl) lyricsArtistInputEl.value = identity.artist || '';
    if (lyricsTitleInputEl) lyricsTitleInputEl.value = identity.title || '';

    if (identity.title) {
      runFind(identity.artist, identity.title);
    } else {
      if (lyricsStatusEl) lyricsStatusEl.textContent = 'Enter the song info to find lyrics (optional).';
      lyricsFieldsEl?.classList.remove('hidden');
      armSkipTimer();
    }
  });
}

async function resolveLyricsForAudio(identity, durationSec, vocalStem = null, { prompt = false, signal = null } = {}) {
  try {
    let lyricResult = null;
    if (prompt) {
      lyricResult = await promptForLyrics(identity, durationSec);
    } else if (identity.title && !lyricsDisabled) {
      lyricResult = await fetchLyricsCached(
        { artist: identity.artist, title: identity.title, album: identity.album, durationSec },
        typeof fetch !== 'undefined' ? fetch : null,
        signal,
      );
    }
    if (signal?.aborted) return { identity, lyricSections: null, syncedLyrics: null };
    const lyricSections = buildLyricSections(lyricResult, Math.round((durationSec || 0) * 1000), vocalStem);
    const syncedLyrics = lyricResult?.synced?.length ? lyricResult.synced : null;
    return { identity, lyricSections, syncedLyrics };
  } catch (err) {
    console.warn('[lyrics] lyrics resolution failed, continuing without it', err);
    return { identity, lyricSections: null, syncedLyrics: null };
  }
}

/** One audio file plays as itself; SEVERAL dropped together are treated as
 *  stems of one song -- summed into a mix for analysis/playback, with each
 *  file's NAME casting its notes to a character (see Casting.js). */
function beginAudioSelection(source) {
  const ticket = audioSelections.begin(source);
  loadGen++;
  // Keep an already playing song's whole-song analysis alive while a remote
  // choice downloads. The handoff to loadAudioFiles stops and aborts it.
  if (!(running && lastTimelineData === loadAudioFiles._preparedData)) loadAudioFiles._abortController?.abort();
  cancelUrlLoad();
  return ticket;
}

async function loadAudioFiles(files, { selection = null, sourceMetadata = null, localTrack = null, onPrepared = null } = {}) {
  selection ||= beginAudioSelection('local');
  if (!audioSelections.isCurrent(selection)) return;
  let selectedFiles;
  try {
    selectedFiles = validateAudioFiles(files, AUDIO_LOAD_LIMITS);
  } catch (err) {
    showErrorBanner(err?.message || 'The selected audio cannot be loaded.');
    return false;
  }
  // Abort the previous decode/analysis before claiming the new generation.
  // Web Audio cannot interrupt a native decode already in progress, but every
  // boundary below observes this signal so stale work cannot commit or start
  // another expensive phase after a replacement selection.
  loadAudioFiles._abortController?.abort();
  const abortController = new AbortController();
  loadAudioFiles._abortController = abortController;
  const { signal } = abortController;
  let preparedData = null;
  const cancelSelection = () => {
    if (!(running && preparedData && lastTimelineData === preparedData)) abortController.abort();
  };
  const canUpdatePrepared = () => !signal.aborted && (audioSelections.isCurrent(selection)
    || (running && preparedData && lastTimelineData === preparedData));
  selection.signal.addEventListener('abort', cancelSelection, { once: true });
  if (selection.signal.aborted) abortController.abort();
  // Claim the load before the first await. Otherwise an older picker/drop
  // stalled in bootAudio() can wake up later and overwrite the newer choice.
  const myGen = loadGen;
  const isStale = () => signal.aborted || myGen !== loadGen || !audioSelections.isCurrent(selection);
  stopTimeline();
  stopTitleBackdrop();
  loadShow?.stop();
  pendingWorldStart = null;
  hudEl.classList.add('hidden');
  // Freeze learned settings for both cache identity and the analysis itself.
  const analysisGroove = new GrooveFingerprint(groove.toJSON());
  showProgress('Reading file…');
  closeWorldChooser();
  try {
    await bootAudio();
  } catch (err) {
    if (isStale()) return;
    showErrorBanner('Could not start audio: ' + (err?.message || err));
    progressEl.classList.add('hidden');
    loaderEl.classList.remove('hidden');
    return false;
  }
  // A second load started while this one is still analysing (another drop,
  // a demo click, a MIDI drop) bumps loadGen -- that's the load the player
  // actually wants now, so this one must bail before it commits rather than
  // clobbering it. Analysis here is the longest of any load path (band
  // separation + onset/tempo/pitch + an awaited lyrics prompt), so it's the
  // one most likely to still be in flight when a second drop lands.
  if (isStale()) return;
  const decoded = [];
  let encodedBytes = 0;
  let decodedBytes = 0;
  for (const file of selectedFiles) {
    try {
      const bytes = await file.arrayBuffer();
      if (isStale()) return;
      encodedBytes = accumulateEncodedAudioBytes(
        encodedBytes, bytes?.byteLength, file.name || 'audio file', AUDIO_LOAD_LIMITS,
      );
      const buffer = await audioEngine.decodeFile(bytes, { signal });
      validateDecodedAudioBuffer(buffer, AUDIO_LOAD_LIMITS);
      decodedBytes = accumulateDecodedAudioBytes(decodedBytes, buffer, AUDIO_LOAD_LIMITS);
      decoded.push({ name: file.name || 'stem', buffer });
    } catch (err) {
      if (isStale() || err?.name === 'AbortError') return;
      showErrorBanner(`Could not decode audio file "${file.name}": ` + err.message);
      progressEl.classList.add('hidden');
      loaderEl.classList.remove('hidden');
      return false;
    }
    if (isStale()) return;
  }
  const isStemDrop = decoded.length > 1;
  let audioBuffer;
  try {
    if (isStemDrop) {
      const mixLength = Math.max(...decoded.map(({ buffer }) => buffer.length));
      const mixBytes = mixLength * 2 * Float32Array.BYTES_PER_ELEMENT;
      validateDecodedByteLength(mixBytes, AUDIO_LOAD_LIMITS);
      accumulateDecodedByteLength(decodedBytes, mixBytes, AUDIO_LOAD_LIMITS);
    }
    audioBuffer = isStemDrop ? sumToMixBuffer(decoded.map((d) => d.buffer), signal) : decoded[0].buffer;
    validateDecodedAudioBuffer(audioBuffer, AUDIO_LOAD_LIMITS);
    if (isStemDrop) accumulateDecodedAudioBytes(decodedBytes, audioBuffer, AUDIO_LOAD_LIMITS);
  } catch (err) {
    if (isStale() || err?.name === 'AbortError') return;
    showErrorBanner('Could not prepare the selected audio: ' + (err?.message || err));
    progressEl.classList.add('hidden');
    loaderEl.classList.remove('hidden');
    return false;
  }

  // A play, and the one fact a folder scan can never know: how long the
  // track actually is. Decoding is the only place that learns it, so this
  // is where it goes back to the library. Fire-and-forget -- a storage
  // failure must not delay the song by a frame.
  if (localTrack && selection.source === 'library' && !isStale()) {
    musicLibrary.notePlayed(localTrack, audioBuffer.duration).catch(() => {});
  }

  // A dropped audio file has real work ahead of it (band separation, onset/
  // tempo detection, pitch tracing) with no timeline yet to drive the usual
  // percussion loading show -- so it runs visual-only (star glyph +
  // orbiters + bar, no beat) while staged progress narrates what's
  // happening, instead of leaving the player looking at a bare text line.
  loaderEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  if (auditionHeadingEl) auditionHeadingEl.textContent = 'PULLING THE RECORDING APART';
  auditionPanelEl?.classList.remove('hidden');
  const loadShowSession = loadShow?.start(null);
  loadShow?.setStage(isStemDrop ? `Mixing ${decoded.length} stems…` : 'Separating into 7 frequency bands…', 0);
  // Everything below can throw (analysis, lyric lookups, world build). The
  // MIDI path next door catches and recovers; this one didn't -- a failure
  // here left the loader hidden, the HUD hidden, and the audition panel
  // stuck on screen forever with no alert and no way back but a reload.
  try {
    // Identity + lyrics resolution runs concurrently with separation/analysis
    // on the same audition panel (a distinct row within it, so the two never
    // fight over the same text) -- the panel stays up until BOTH have
    // settled, so the identity row can't flash and vanish before the player
    // gets a chance to Find/Skip.
    // StemAlign fallback gate (Task E of the lyrics plan): only relevant when
    // several stems were dropped together and one of their filenames reads as
    // an actual vocal track -- buildLyricSections only touches it if the
    // lyrics that come back have no per-line timestamps of their own.
    const vocalStem = isStemDrop ? decoded.find((d) => isVocalStemName(d.name)) : null;
    // Identity always resolves; the "No lyrics" preference skips lyric work.
    const identityReady = resolveAudioIdentity(selectedFiles[0], audioBuffer.duration, { signal, sourceMetadata });
    const lyricsPromise = identityReady.then(identity => resolveLyricsForAudio(identity, audioBuffer.duration, vocalStem, { prompt: false, signal }));
    // Reuse only the same decoded fingerprint, stem assignments, and learned
    // rhythm settings. Different encodings may have different fingerprints.
    //
    // The analysis starts FIRST and the fingerprint is taken while it runs:
    // the analysis's first long stretch is native band rendering on other
    // threads (and pitch in a worker), which leaves this thread free. When
    // the fingerprint finds the song in the cache, the analysis is cancelled
    // instead. Fingerprint-then-analyse had the two queue one behind the
    // other, ~0.5s of a 3.5-minute song's load.
    const analysisAbort = new AbortController();
    const cancelAnalysis = () => analysisAbort.abort();
    signal.addEventListener('abort', cancelAnalysis, { once: true });
    let fingerprint = null;
    let cacheKey = null;
    let data = null;
    // A long song starts on its opening and is analysed whole while it plays
    // (OpeningAnalysis.js). The first pass is then just the opening.
    const openingFirst = useOpeningAnalysis({
      durationSec: audioBuffer.duration, stemDrop: isStemDrop, exporting: !!readBulkExportFromUrl(),
      rangeListening,
    });
    const analysis = audioToTimeline(openingFirst ? sliceAudioBuffer(audioBuffer, OPENING_SECONDS) : audioBuffer, {
      userStems: isStemDrop ? decoded : null,
      // Everything previous sessions learned about how this player splits a
      // kick from a hat, applied to a song they've never played.
      groove: analysisGroove,
      signal: analysisAbort.signal,
      onProgress: ({ phase, progress }) => {
        if (isStale() || analysisAbort.signal.aborted) return;
        if (phase === 'separate') loadShow?.setStage(`Separating into 7 frequency bands… ${Math.round(progress * 100)}%`, progress);
        else if (phase === 'analyze') loadShow?.setStage('Detecting onsets, tempo, and downbeat…', 0.7);
        else if (phase === 'pitch') loadShow?.setStage('Tracing melody, bass, and harmony…', 0.9);
      },
    });
    // Settled either way; a cancelled analysis is not an error.
    analysis.catch(() => {});
    // Fingerprint the song and look it up in the analysis cache. A hit is the
    // whole-song analysis, ready-made.
    const lookUp = async () => {
      try {
        fingerprint = await fingerprintBufferOffThread(audioBuffer, { signal });
        if (!canUpdatePrepared()) throw audioAbortError();
        cacheKey = analysisCacheKey(fingerprint, { stems: isStemDrop ? decoded : [], groove: analysisGroove });
        const cached = cacheKey ? await getBundle(cacheKey) : null;
        if (!canUpdatePrepared()) throw audioAbortError();
        // An unreadable bundle (older layout, truncated, hand-edited) is not
        // an error worth surfacing: unpackBundle returns null and we analyse
        // from scratch, which is slow but always correct.
        const restored = cached ? unpackBundle(cached) : null;
        if (restored) console.info('[analysis] restored from cache:', fingerprint.key);
        return restored;
      } catch (err) {
        if (err?.name === 'AbortError' || !canUpdatePrepared()) throw audioAbortError();
        // Fingerprinting must never be able to stop a song from playing.
        console.warn('[analysis] fingerprint/cache lookup failed', err);
        return null;
      }
    };
    let fullAnalysis = null;
    try {
      if (!openingFirst) {
        const restored = await lookUp();
        if (restored) {
          data = restored;
          cancelAnalysis();
        } else {
          data = await analysis;
        }
      } else {
        data = asOpening(await analysis, audioBuffer.duration * 1000);
        // The whole song, in the background, once the picker has had a moment
        // to paint. The cache lookup runs behind the picker too: the opening
        // is analysed the same way every time, so the song looks the same
        // cached or not, and a hit just finishes the whole-song pass early.
        // The analysis takes turns with the page rather than holding it
        // (cooperative), and lands on the same data object the picker and
        // the running song hold (adoptFullAnalysis).
        fullAnalysis = new Promise((resolve) => setTimeout(resolve, 150)).then(async () => {
          if (analysisAbort.signal.aborted) throw audioAbortError();
          const whole = audioToTimeline(audioBuffer, {
            groove: analysisGroove, signal: analysisAbort.signal, cooperative: true,
          });
          whole.catch(() => {});
          const restored = await lookUp();
          if (restored) {
            cancelAnalysis();
            return restored;
          }
          return whole;
        });
      }
    } finally {
      if (!fullAnalysis) signal.removeEventListener('abort', cancelAnalysis);
      loadShow?.stop(loadShowSession);
    }
    if (isStale()) return;
    data.sourceTrack = normalizeSourceMetadata(sourceMetadata);
    data.lyricIdentity = await identityReady;
    if (isStale()) return;
    data.sourceFileName = selectedFiles[0].name || 'song';
    data.lyricSession = { generation: myGen, admissions: [] };
    data.lyricSections = null;
    data.syncedLyrics = null;
    data.audioOverview = buildAudioOverview(audioBuffer);
    const opened = data;
    preparedData = data;
    const wholeSong = fullAnalysis
      ? fullAnalysis.then((full) => {
        if (!canUpdatePrepared()) return null;
        upgradeRidgeMusicSession(opened, full,
          running && sim && lastTimelineData === opened && !bulkExportArmed ? sim.heardTimeMs : null,
          `load-${myGen}:final`);
        adoptAudioSessionAnalysis(opened, full);
        if (fullAnalysisPending === wholeSong) fullAnalysisPending = null;
        adoptFullAnalysisLive(opened);
        return opened;
      }).catch((err) => {
        if (fullAnalysisPending === wholeSong) fullAnalysisPending = null;
        if (!canUpdatePrepared()) return null;
        // The opening stands: the song plays on what it has.
        if (err?.name !== 'AbortError') {
          if (opened.opening) opened.opening.failed = true;
          console.warn('[analysis] whole-song pass failed; keeping the opening', err);
        }
        return null;
      }).finally(() => signal.removeEventListener('abort', cancelAnalysis))
      : null;
    fullAnalysisPending = wholeSong;
    // Lyrics no longer hold up the world picker: the lookup is network work
    // with no fixed length, and the picker is where the player spends the
    // next few seconds anyway. It lands on the song's data when it resolves;
    // starting a world waits for it only briefly (confirmWorld).
    //
    // Remember this analysis for next time. Stored after identity resolves so
    // the bundle carries the artist/title it was matched to. Not awaited: the
    // show must not wait on a disk write, and a failed one costs only a
    // re-analysis later. Lyrics are deliberately NOT in the bundle -- they
    // are fetched per play and the preference can change between plays.
    const lyricsReady = lyricsPromise.then((result) => {
      if (!adoptAudioSessionLyrics(data, result, {
        canUpdatePrepared, generation: myGen, lyricsDisabled, sim, activeData: lastTimelineData,
      })) return null;
      const lyricIdentity = result.identity;
      // Cached once the whole song is in (the key may only be known then,
      // too): an opening would be restored next time as if it were the song.
      Promise.resolve(wholeSong).then(() => {
        if (!canUpdatePrepared() || !cacheKey || data.fromBundle || data.opening) return null;
        return putBundle(cacheKey, packBundle(data, {
          fingerprint, name: selectedFiles[0].name || '', identity: lyricIdentity,
        }));
      }).catch((err) => console.warn('[analysis] could not cache bundle', err));
      return null;
    }).catch((err) => console.warn('[lyrics] lookup failed; continuing without', err))
      .finally(() => { lyricsReady.settled = true; });
    if (auditionHeadingEl) auditionHeadingEl.textContent = 'PULLING THE RECORDING APART';
    auditionPanelEl?.classList.add('hidden');
    lyricsRowEl?.classList.add('hidden');

    if (data.freeTime) {
      // A handled mode switch, not a warning -- free-time/kick-reactive
      // jumps are a normal, fully-supported fallback for rubato tracks.
      console.info(`Low tempo confidence (${data.confidence.toFixed(2)}) — switching to free-time, kick-reactive jumps.`);
    }
    if (data.stems && DEV_MODE) {
      console.info('[casting] stems:', data.stems.map((s) => `${s.name} -> ${s.lane || '(world)'}`).join(', '));
    }
    // Audio files get the same per-song visual fingerprint MIDI files do: a
    // unique custom biome from the timeline plus the adapter's chroma/
    // brightness/dynamics/width analysis (see BiomeImporter).
    // Part of the song's identity: restored as it was first made, so a song
    // started on its opening looks the same on every later play.
    data.customBiome = data.songIdentity?.customBiome || generateCustomBiomeFromMidi(data, selectedFiles[0].name || 'Audio');
    rememberCustomBiome(paramBus, data.customBiome);
    // Raw audio already has every voice baked into the decoded buffer —
    // stacking the synth's pseudo-onset voicing on top is the unwanted
    // synthetic hi-hat/click layer, so the timeline synth stays silent here.
    muteTimelineSynth = true;
    lastSongName = sessionSongName(data, selectedFiles[0].name);
    lastAudioBuffer = audioBuffer;
    fontRecommender?.clear(); // the recording is its own sound source
    loadAudioFiles._preparedData = data;
    onPrepared?.();
    offerWorldsThenStart(data, { playBuffer: audioBuffer, lyricsReady });
    return true;
  } catch (err) {
    if (isStale() || err?.name === 'AbortError') return;
    console.error('[audio load failed]', err);
    auditionPanelEl?.classList.add('hidden');
    lyricsRowEl?.classList.add('hidden');
    hudEl.classList.add('hidden');
    loaderEl.classList.remove('hidden');
    showErrorBanner('Could not load audio file: ' + (err?.message || err));
    return false;
  }
}

function handleFile(file) {
  if (!file) return;
  handleFiles([file]);
}

/** One file plays as itself. Several files dropped together are stems of one
 *  song (their filenames cast the characters). The built-in sample is a
 *  second door into the same chooser. */
function handleFiles(files, { selection = null, sourceMetadata = null, localTrack = null, onPrepared = null } = {}) {
  selection ||= beginAudioSelection('local');
  if (!audioSelections.isCurrent(selection)) return;
  // Whatever this is, it is the source the player chose most recently, so
  // an in-flight URL fetch must not be allowed to land afterwards and take
  // the playback back. The URL path releases its own operation before
  // calling in here, so this never cancels the load that invoked it.
  cancelUrlLoad();
  let list;
  try {
    list = validateAudioFiles(files, AUDIO_LOAD_LIMITS);
  } catch (err) {
    showErrorBanner(err?.message || 'The selected audio cannot be loaded.');
    return;
  }
  if (!list.length) return;
  closeWorldChooser();
  stopWorldPreview();
  pendingWorldStart = null;
  showProgress('Reading file…');
  return loadAudioFiles(list, { selection, sourceMetadata, localTrack, onPrepared });
}

fileInputEl?.addEventListener('change', (e) => {
  if (e.target.files.length) handleFiles(e.target.files);
  // Same-file re-upload doesn't fire `change` unless we clear the value.
  e.target.value = '';
});

// --- Browsers with no file chooser ---------------------------------------
//
// An `<input type="file">` only opens a chooser if the browser implements
// one. An Android WebView delegates that to its host app via
// `WebChromeClient.onShowFileChooser()`, and an app that never overrides it
// gets no chooser at all -- the click then leaves the hidden input focused
// and Android raises the soft keyboard, which is how this reaches a player:
// "the upload button just opens the keyboard". Fermata's browser is one
// such app. Nothing this page serves can add a chooser there, so instead
// the dead click is detected once, suppressed from then on, and the URL
// loader below is offered in its place. See src/ui/FileChooserProbe.js.
const fileChooser = new FileChooserSupport();

/** Every route to the picker goes through here, so a browser with no
 *  chooser reveals the alternative instead of raising a keyboard. */
function openFilePicker(input = fileInputEl) {
  return fileChooser.open(input, () => revealUrlLoad(
    `This browser has no file chooser, so "Browse files" cannot open one.${
      fileChooser.looksLikeWebView
        ? ' That is a limit of the app you are browsing in, not of this page.'
        : ''
    } Load a song by address instead.`,
  ));
}

/** How many song rows are built at once; the rest arrive on request. */
const URL_LISTING_BATCH_ROWS = 500;
let urlLoadAbort = null;
let urlLoadListenersBound = false;

/**
 * Shows the URL panel, with `why` explaining an unasked-for appearance.
 *
 * `focus` is deliberately NOT the default. Focusing a text field raises the
 * soft keyboard -- the very thing the player just complained about -- so a
 * panel that appears because the chooser turned out to be missing stays
 * unfocused, and only a panel the player opened on purpose takes focus.
 */
function revealUrlLoad(why = '', { focus = false } = {}) {
  if (!urlLoadEl) return;
  urlLoadEl.classList.remove('hidden');
  if (urlLoadWhyEl) urlLoadWhyEl.textContent = why;
  bindUrlLoad();
  // Scrolling it into view matters on a head unit, where the panel can open
  // below the fold and look as if nothing happened.
  try { urlLoadEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* older WebView */ }
  if (focus) urlLoadInputEl?.focus();
}

function setUrlLoadStatus(text, isError = false) {
  if (!urlLoadStatusEl) return;
  urlLoadStatusEl.textContent = text || '';
  urlLoadStatusEl.classList.toggle('isError', Boolean(isError) && Boolean(text));
}

function setUrlLoadBusy(busy) {
  if (urlLoadBtnEl) urlLoadBtnEl.disabled = busy;
}

function clearUrlLoadListing() {
  if (urlLoadListEl) {
    urlLoadListEl.replaceChildren();
    urlLoadListEl.classList.add('hidden');
  }
  if (urlLoadCrumbEl) {
    urlLoadCrumbEl.textContent = '';
    urlLoadCrumbEl.classList.add('hidden');
  }
}

/** Renders one folder's worth of entries. Everything is built with
 *  createElement/textContent -- the listing comes off a server the player
 *  named, so its names are text to display, never markup to parse. */
function renderUrlListing({ entries = [], folders = [], url = '' }) {
  if (!urlLoadListEl) return;
  urlLoadListEl.replaceChildren();

  if (urlLoadCrumbEl) {
    urlLoadCrumbEl.replaceChildren();
    // Browsing does not touch history, so the browser's Back leaves the
    // page rather than returning to the previous folder. Without an
    // in-page way up, one wrong tap on a car screen means retyping the
    // address by hand.
    const parent = parentListingUrl(url);
    if (parent) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'urlLoadUp';
      up.textContent = '\u2191 Up a folder';
      up.addEventListener('pointerdown', unlockAudio, { passive: true });
      up.addEventListener('click', () => openUrlTarget(parent));
      urlLoadCrumbEl.append(up);
    }
    const path = document.createElement('span');
    path.className = 'urlLoadCrumbPath';
    path.textContent = decodeUrlPathForDisplay(url);
    urlLoadCrumbEl.append(path);
    urlLoadCrumbEl.classList.remove('hidden');
  }

  /** One tappable row. Built with createElement/textContent throughout --
   *  the names come off a server the player named, so they are text to
   *  display, never markup to parse. */
  const appendEntry = (row) => {
    const li = document.createElement('li');
    li.className = 'urlLoadItem';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'urlLoadEntry';
    btn.dataset.kind = row.kind;
    const icon = document.createElement('span');
    icon.className = 'urlLoadEntryIcon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = row.kind === 'folder' ? '\u25b8' : '\u266a';
    const name = document.createElement('span');
    name.className = 'urlLoadEntryName';
    name.textContent = row.name;
    btn.append(icon, name);
    // A folder navigates; a song loads. The AudioContext is unlocked on the
    // pointer-down that starts either, because the fetch that follows is not
    // itself a user activation and bootAudio() would be refused after it.
    btn.addEventListener('pointerdown', unlockAudio, { passive: true });
    btn.addEventListener('click', () => {
      // Also here, not only on pointerdown: Enter/Space on a focused button
      // fires click alone, and that click is the only gesture available.
      unlockAudio();
      if (row.kind === 'folder') openUrlTarget(row.url);
      else loadUrlAudio(row.url, row.name);
    });
    li.append(btn);
    urlLoadListEl.append(li);
  };

  // Folders first -- they are navigation, and the natural order to scan --
  // then songs, all of it through ONE batched list.
  //
  // Batching is not a limit: building thousands of buttons at once is
  // seconds of frozen UI on a head unit, so rows arrive a batch at a time
  // with a "Show more" button after them. Nothing is ever dropped, which
  // matters for both kinds and for different reasons: a hidden song in a
  // FLAT folder has no subfolder to reach it through, and a hidden folder
  // has nothing at all. An artist root with thousands of subfolders costs
  // exactly as much to render as a flat album with thousands of tracks, so
  // both are paced the same way.
  const rows = [
    ...folders.map((folder) => ({ ...folder, kind: 'folder' })),
    ...entries.map((entry) => ({ ...entry, kind: 'file' })),
  ];

  let shownRows = 0;
  const showMoreRow = document.createElement('li');
  showMoreRow.className = 'urlLoadItem urlLoadMoreRow';
  const showMoreBtn = document.createElement('button');
  showMoreBtn.type = 'button';
  showMoreBtn.className = 'urlLoadMore';
  showMoreRow.append(showMoreBtn);

  const showNextBatch = () => {
    showMoreRow.remove();
    const next = rows.slice(shownRows, shownRows + URL_LISTING_BATCH_ROWS);
    for (const row of next) appendEntry(row);
    shownRows += next.length;
    const remaining = rows.length - shownRows;
    if (remaining > 0) {
      showMoreBtn.textContent = `Show ${Math.min(remaining, URL_LISTING_BATCH_ROWS)} more`
        + ` (${remaining} left)`;
      urlLoadListEl.append(showMoreRow);
    }
  };
  showMoreBtn.addEventListener('click', showNextBatch);
  showNextBatch();

  urlLoadListEl.classList.toggle('hidden', entries.length === 0 && folders.length === 0);
}

/** The folder above `url`, or null at the server root. Derived from the
 *  path rather than from a link in the listing, because an HTML index's own
 *  parent link is filtered out as a non-descendant and the JSON listing has
 *  no parent entry at all. */
function parentListingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length) return null; // already at the root
  segments.pop();
  parsed.pathname = segments.length ? `/${segments.join('/')}/` : '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/** A URL is unreadable on a car screen with its escapes intact. */
function decodeUrlPathForDisplay(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname) || '/';
  } catch {
    return String(url || '');
  }
}

/** Abandons any URL fetch still in flight. Called whenever a DIFFERENT
 *  source claims playback: otherwise a download started earlier lands
 *  later, calls handleFiles(), claims a newer load generation and replaces
 *  the file the player just dropped or picked. */
function cancelUrlLoad() {
  if (!urlLoadAbort) return;
  urlLoadAbort.abort();
  urlLoadAbort = null;
  setUrlLoadBusy(false);
}

/** Starts a fresh URL operation, superseding any still in flight. */
function beginUrlLoadOperation() {
  const selection = beginAudioSelection('url');
  urlLoadAbort?.abort();
  urlLoadAbort = new AbortController();
  setUrlLoadBusy(true);
  const controller = urlLoadAbort;
  selection.signal.addEventListener('abort', () => controller.abort(), { once: true });
  return { signal: controller.signal, selection };
}

function endUrlLoadOperation(signal) {
  if (urlLoadAbort?.signal === signal) {
    urlLoadAbort = null;
    setUrlLoadBusy(false);
  }
}

/** Opens whatever the address turns out to be: a song, or a folder to browse. */
async function openUrlTarget(raw) {
  const { signal, selection } = beginUrlLoadOperation();
  setUrlLoadStatus('Opening\u2026');
  try {
    const result = await openAudioUrl(raw, { pageUrl: location.href, signal });
    if (signal.aborted || !audioSelections.isCurrent(selection)) return;
    if (result.kind === 'listing') {
      renderUrlListing(result);
      const count = result.entries.length;
      setUrlLoadStatus(count
        ? `${count} song${count === 1 ? '' : 's'} here. Tap one to play it.`
        : 'No songs in this folder \u2014 open a subfolder.');
      if (urlLoadInputEl) urlLoadInputEl.value = result.url;
      return;
    }
    clearUrlLoadListing();
    setUrlLoadStatus('');
    endUrlLoadOperation(signal); // release before handing off, see cancelUrlLoad
    handleFiles([result.file], { selection });
  } catch (err) {
    if (signal.aborted) return;
    setUrlLoadStatus(
      err instanceof UrlAudioError ? err.message : `Could not open that URL: ${err?.message || err}`,
      true,
    );
  } finally {
    endUrlLoadOperation(signal);
  }
}

/** Loads one song picked out of a listing.
 *
 *  The URL is re-validated even though it came from a listing we just
 *  fetched: a listing is free to contain absolute links, and an HTML index
 *  usually does. A server started with MUSIC_HOST set advertises its LAN
 *  address, so a folder on loopback can list songs on http://192.168.x.x --
 *  which the browser blocks as mixed content. Without this check the browse
 *  succeeds and every song click then fails as an unreachable-server/CORS
 *  error, which points at entirely the wrong thing. */
async function loadUrlAudio(url, name = '') {
  // Supersede first, validate second. Returning before beginUrlLoadOperation()
  // left an earlier download running: the rejection message appeared, then
  // the old request finished, cleared it, and started playing a song the
  // player had already moved on from. openUrlTarget() has always claimed
  // the operation up front for the same reason.
  const { signal, selection } = beginUrlLoadOperation();
  const verdict = classifyUrl(url, location.href);
  if (!verdict.ok) {
    setUrlLoadStatus(verdict.message, true);
    endUrlLoadOperation(signal);
    return;
  }
  setUrlLoadStatus(`Fetching ${name || decodeUrlPathForDisplay(url)}\u2026`);
  try {
    const file = await fetchAudioAsFile(verdict.url, { signal, name });
    if (signal.aborted) return;
    setUrlLoadStatus('');
    endUrlLoadOperation(signal); // release before handing off, see cancelUrlLoad
    handleFiles([file], { selection });
  } catch (err) {
    if (signal.aborted) return;
    setUrlLoadStatus(
      err instanceof UrlAudioError ? err.message : `Could not load that song: ${err?.message || err}`,
      true,
    );
  } finally {
    endUrlLoadOperation(signal);
  }
}

function bindUrlLoad() {
  if (urlLoadListenersBound || !urlLoadFormEl) return;
  urlLoadListenersBound = true;
  urlLoadFormEl.addEventListener('submit', (e) => {
    e.preventDefault();
    // Enter, or the mobile keyboard's Go key, fires no pointerdown -- so
    // without this the fetch starts with no unlock and the AudioContext can
    // refuse to resume by the time the bytes arrive, even though tapping
    // Open works. The unlock must happen synchronously inside the gesture.
    unlockAudio();
    openUrlTarget(urlLoadInputEl?.value || '');
  });
  urlLoadFormEl.addEventListener('pointerdown', unlockAudio, { passive: true });
}

// The visible button, which is what a player actually taps. It used to be
// a <label> wrapping #fileInput, and a label natively activates its nested
// input -- so the click reached the input directly, bypassed this function,
// and kept producing the dead click and the phantom keyboard on every tap
// without ever recording a verdict. It is a real <button> now.
browseBtnEl?.addEventListener('click', () => {
  // Enter/Space on a focused button fires click with no pointerdown, so the
  // pointerdown listener below covers touch and mouse only. Without this the
  // chooser opens un-unlocked and the later `change` handler -- which is not
  // a user activation -- can fail with "Audio is blocked."
  unlockAudio();
  openFilePicker();
});
browseBtnEl?.addEventListener('pointerdown', unlockAudio, { passive: true });

urlLoadOpenBtnEl?.addEventListener('click', () => revealUrlLoad('', { focus: true }));

// A browser already known to have no chooser shows the alternative up
// front, rather than making the player tap a dead button to find out again.
if (fileChooser.isAbsent) {
  revealUrlLoad('This browser has no file chooser, so files cannot be browsed'
    + ' from this page. Load a song by address instead.');
}
worldSelectBackEl?.addEventListener('click', () => backToTitle());
worldSelectEl?.addEventListener('keydown', (e) => {
  // Native modality makes the background inert; explicitly wrap the two
  // endpoints so Tab does not leave the page for the browser toolbar.
  if (e.key !== 'Tab') return;
  if (e.shiftKey && document.activeElement === worldPassageQuietEl) {
    e.preventDefault();
    worldSelectBackEl?.focus();
  } else if (!e.shiftKey && document.activeElement === worldSelectBackEl) {
    e.preventDefault();
    worldPassageQuietEl?.focus();
  }
});
worldSelectEl?.addEventListener('cancel', (e) => {
  e.preventDefault();
  backToTitle(); // also stops preview audio and discards the pending song
});

/** Authored sample (Proof) so a visitor can see the worlds without a file. */
async function startDemoSample() {
  const selection = beginAudioSelection('sample');
  cancelUrlLoad(); // the sample is a choice too, and outranks an older fetch
  try {
    await bootAudio();
  } catch (err) {
    showErrorBanner(err?.message || 'Audio is blocked. Click the page, then try again.');
    return;
  }
  if (!audioSelections.isCurrent(selection)) return;
  muteTimelineSynth = false;
  lastAudioBuffer = null;
  lastSongName = 'Proof';
  fontRecommender?.clear();
  const song = buildDemoSong();
  const energyCurves = synthesizeEnergyCurves(song.timeline, song.durationMs);
  const barMs = (60000 / song.bpm) * 4;
  const boundariesMs = song.sections.map((s) => s.bar0 * barMs);
  boundariesMs.push(song.durationMs);
  offerWorldsThenStart({
    title: song.title,
    bpm: song.bpm,
    durationMs: song.durationMs,
    timeline: song.timeline,
    barGrid: song.barGrid,
    energyCurves,
    conductor: song.conductor,
    structure: {
      labels: song.sections.map((s) => s.id),
      boundariesMs,
      confidence: 1,
    },
  });
}
demoBtnEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  startDemoSample();
});

// Unlock the AudioContext on the gesture that opens the picker, not on
// the later `change` event -- browsers often don't treat file-picker
// confirmation as a user activation, so bootAudio() on change used to
// throw "Audio is blocked" and the drop looked like it did nothing.
function unlockAudio() { bootAudio().catch(() => {}); }
dropzoneEl?.addEventListener('pointerdown', unlockAudio, { passive: true });
worldSelectEl?.addEventListener('pointerdown', unlockAudio, { passive: true });

// Dropzone-local visual feedback only (pre-game loader screen) — the actual
// file handling lives in the window-level listeners below so a drop lands
// the same way whether it's on the dropzone, mid-song, or anywhere else on
// the page.
['dragenter', 'dragover'].forEach((ev) => dropzoneEl.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzoneEl.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => dropzoneEl.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzoneEl.classList.remove('drag');
}));
dropzoneEl.addEventListener('click', () => openFilePicker());
// #dropzone is role="button" tabindex="0", but browsers don't synthesize a
// click from Enter/Space on a plain div the way they do for a real
// <button> -- without this the game's primary call-to-action isn't
// keyboard-operable at all, and the keypress instead fell through to
// beatTap() (the F/J calibration handler) once the loader is showing.
dropzoneEl.addEventListener('keydown', (e) => {
  if (e.target !== dropzoneEl) return; // nested sample/upload controls own their keys
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  e.preventDefault(); // Space must not also scroll the page
  openFilePicker();
});

// --- Global drag-and-drop: works at ANY time, not just from the initial
// loader screen. Dropping a different .mid/audio file mid-song tears down
// the current one (stopTimeline, via startTimeline/
// loadAudioFile) and auto-plays the new one immediately. dragDepth tracks
// nested dragenter/dragleave pairs (they fire on every element the pointer
// crosses) so the overlay doesn't flicker off while still dragging over a
// child element.
let dragDepth = 0;
function isLoaderVisible() { return !loaderEl.classList.contains('hidden'); }
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  // The loader's own dropzone already gives drag feedback pre-game; the
  // overlay is only for "you can drop a new file right now" mid-song.
  if (dragOverlayEl && !isLoaderVisible()) dragOverlayEl.classList.add('visible');
});
window.addEventListener('dragover', (e) => e.preventDefault()); // required to allow drop
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0 && dragOverlayEl) dragOverlayEl.classList.remove('visible');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  if (dragOverlayEl) dragOverlayEl.classList.remove('visible');
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});

// --- Display settings ---
// Reuse the same real controls during playback; closing restores their title home.
const displayDialog = document.getElementById('displaySettingsDialog');
const titleSettings = document.getElementById('titleSettings');
const settingsHome = titleSettings?.parentElement;
document.getElementById('displaySettingsBtn')?.addEventListener('click', () => {
  document.getElementById('displaySettingsBody').append(titleSettings);
  titleSettings.open = true;
  displayDialog.showModal();
});
document.getElementById('displaySettingsClose')?.addEventListener('click', () => displayDialog.close());
displayDialog?.addEventListener('close', () => settingsHome.append(titleSettings));
document.getElementById('copyGraphicsReport')?.addEventListener('click', async () => {
  const output = document.getElementById('graphicsReport');
  const status = document.getElementById('graphicsReportStatus');
  const text = JSON.stringify(graphicsReport({
    range: rangePresentation?.snapshot(), profile: displayPrefs,
    presentation: renderer?.diagnostics || titlePresentation?.diagnostics, canvas,
    gl: rangePresentation?.scene?.renderer?.getContext(),
  }), null, 2);
  output.hidden = false; output.value = text;
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied. Paste this report when reporting a graphics problem.';
  } catch {
    output.focus(); output.select();
    status.textContent = 'Select and copy the report below.';
  }
});

// --- Track visibility wiring ---
if (trackBadgeBtnEl) trackBadgeBtnEl.addEventListener('click', () => toggleTrackList());

function frame(tRaf) {
  if (!running) return;
  if (paused) { rafHandle = requestAnimationFrame(frame); return; }
  if (lastRafMs !== null) {
    const rafDeltaMs = tRaf - lastRafMs;
    noteFrameGap(rafDeltaMs);
    const prevLevel = perfGovernor.level;
    // A hidden page's frame timing says nothing about how expensive the
    // scene is. Chrome stops rAF outright for a hidden tab, but an embedded
    // WebView may instead throttle it to about 1Hz -- and a run of 1000ms
    // "frames" is exactly the shape the severity escalation is built to
    // believe, so it would shed rung after rung while nothing was being
    // drawn at all, and hand the player back a degraded show on return.
    if (!document.hidden) perfGovernor.sample(rafDeltaMs, tRaf, { capFps: 1000 / fpsCapMs });
    if (perfGovernor.level !== prevLevel) fitCanvas();
    fpsEma = emaFps(fpsEma, rafDeltaMs);
    if (fpsHudVisible && fpsHudEl) {
      fpsHudEl.textContent = `${Math.round(presentedFps.fps)} presented fps  ·  ${Math.round(fpsEma)} callback fps  ·  perf ${perfGovernor.level}/${PERF_MAX_LEVEL}`;
    }
  }
  lastRafMs = tRaf;
  hudIdleTick(tRaf);
  keepAwake.tick(tRaf);
  const nowMs = audioEngine.nowMs;
  // ChoreoClock leg 3: the world is stepped for when this frame will be SEEN,
  // one compositor-plus-scanout hop after it is built, so `simTime` and
  // `lastNowMs` both live in led time. A constant lead shifts the sequence
  // without changing any delta, so the fixed-step accumulator is unaffected.
  const renderNowMs = captureClock.renderNow(nowMs);
  if (sim) sim.visualLeadMs = captureClock.leadMs;

  try {
    const advanced = advanceFixedStepClock({
      nowMs: renderNowMs,
      lastNowMs,
      simTime,
      accumulatorMs: acc,
      stepMs: STEP_MS,
      step: (dtMs, atMs) => sim.step(dtMs, atMs),
    });
    lastNowMs = advanced.lastNowMs;
    simTime = advanced.simTime;
    acc = advanced.accumulatorMs;
  } catch (err) {
    // frame() has no wrapper of its own -- an uncaught throw here would abort
    // BEFORE reaching the requestAnimationFrame() call at the bottom, which
    // freezes the entire game loop forever on the last good paint. The prime
    // step at song start already learned this the hard way (see its own
    // try/catch above); this is the same failure mode on every later frame.
    // Start the next frame from the current audio position; a failed step
    // must not turn into permanent clock drift.
    lastNowMs = renderNowMs;
    simTime = renderNowMs;
    acc = 0;
    if (drawErrors.record(err, tRaf)) {
      console.error(`[sim.step] (occurrence ${drawErrors.worst.count})`, err);
    }
  }

  // FPS cap: skip the draw when we're ahead of the target frame period.
  // The sim still steps at full rate so audio sync stays tight; only the
  // GPU-bound draw is throttled.
  if (!playbackCadence.shouldDraw(tRaf, 1000 / fpsCapMs)) {
    presentedFps.sample(tRaf, false);
    rafHandle = requestAnimationFrame(frame);
    return;
  }

  if (pendingCapturePresetId && captureClock.captureReady) {
    const presetId = pendingCapturePresetId;
    pendingCapturePresetId = null;
    beginRecorder(presetId);
  }

  const alpha = acc / STEP_MS;
  let presented = false;
  try {
    const result = renderer.draw(sim, alpha);
    presented = !!result?.presented;
    syncCaptionDetails();
    if (!presented) throw new Error(`Presentation failed: ${result?.reason || 'no completed frame'}`);
  } catch (err) {
    // One bad frame must not kill the whole run (canvas NaN colors used to
    // throw here and leave the world frozen on the last good paint). But it
    // must not be invisible either: this catch hid two effects that threw on
    // every invocation for months, silently dropping the rest of each
    // affected frame with them. Counted always, surfaced in the debug
    // readout, and logged on a log2 cadence so a per-frame throw reports its
    // scale instead of burying the console.
    if (drawErrors.record(err, tRaf)) {
      console.error(`[draw] (occurrence ${drawErrors.worst.count})`, err);
    }
  }
  // One Spectrum, the chrome half: sync the HUD CSS custom properties to
  // the live spectral palette. Cache-gated on the quantized shift so the
  // DOM is only touched when the song's key/form actually moves -- never
  // per-frame style thrash.
  if (sim.biomes && typeof sim.biomes.currentHaloColor === 'function') {
    const tonic = sim.biomes.tonic ?? '?';
    const shiftDeg = sim.biomes._spectralShift ? sim.biomes._spectralShift() : 0;
    const blendTo = sim.biomes.currentBlend ? sim.biomes.currentBlend.to : '';
    const sig = `${tonic}|${Math.round(shiftDeg / 3)}|${blendTo}`;
    if (sig !== lastSpecSig) {
      lastSpecSig = sig;
      const halo = sim.biomes.currentHaloColor();
      const tokens = { baseHue: sim.keyDirector ? ((sim.keyDirector.tonic % 12) + 12) % 12 * 30 : 0, halo };
      const vars = cssVarMap(tokens);
      const root = document.documentElement;
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
      // The ambient glow rides a coarser gate. Its signature can only move
      // when this one has, so deriving it here costs nothing and keeps both
      // reading the same palette.
      const glowSig = `${tonic}|${Math.round(shiftDeg / GLOW_SHIFT_STEP_DEG)}|${blendTo}`;
      if (glowSig !== lastGlowSig) {
        lastGlowSig = glowSig;
        root.style.setProperty('--glow-gold', vars['--spec-gold']);
        root.style.setProperty('--glow-cool', vars['--spec-cool']);
        root.style.setProperty('--glow-warm', vars['--spec-warm']);
      }
    }
  }

  // Last impact notes → freeze/shatter: fade music out so the glass break
  // lands in silence (not over a long empty pad after the real ending).
  if (sim.fracture?.justEnteredFinale && !sim.fracture.audioSilenced) {
    sim.fracture.audioSilenced = true;
    audioEngine?.fadeToSilence?.(0.32);
    synth?.stopAll?.();
  }

  // Authored cuts: the drop and the apotheosis duck the mix for a beat,
  // the sound half of the same snap the camera/color already get (CutDirector).
  if (sim.cut?.dropJustCut) audioEngine?.duck?.();
  if (sim.cut?.apotheosisJustCut) audioEngine?.duck?.(0.6, 0.04, 0.3);
  // Disaster cuts get the same sound-half treatment as the authored ones
  // above -- a quake strike and a tsunami wall's arrival both duck the mix.
  if (sim.disasters?.justStruck && sim.disasters.struckKind === 'quake') audioEngine?.duck?.(0.7, 0.08, 0.4);
  if (sim.biomes?.tsunamiJustArrived) audioEngine?.duck?.(0.5, 0.05, 0.35);

  // Tap recalibration: drive the count while an (opt-in, 'C'-key-triggered)
  // pass is running. Never blocks the frame, pauses audio, or swallows input.
  if (recalibration.active) {
    // The exact clock the beat-anchored layer is drawn on -- Renderer and
    // every performer evaluate `sim.timeMs - visualLagMs`, and the ring has
    // to pulse in the same frame as the character move for the same kick or
    // the pass measures the gap between them instead of the display. The
    // display lead is already inside simTime and must NOT be taken off
    // again here: doing so put the ring a lead (52ms) behind the visuals it
    // stands in for, and every eye pass banked that as display latency.
    const visualBeatMs = simTime - (sim.visualLagMs || 0);
    const alive = recalibration.update(simTime, {
      beatPeriodMs: sim.beatAnchor.periodMs,
      confidence: sim.beatAnchor.confidence,
      reducedFlash,
      // Matched against the same collapsed onsets the tap is measured
      // against. Pulsing on the raw list would flash twice for a flammed
      // kick while the match resolved to the first of the pair, so a player
      // timing the second flash would have the ornament's gap filed as
      // display latency.
      beatPulse01: recalibration.phase === PHASE_EYE
        ? beatPulse01(
          syncCalibrator.collapsedOnsets(sim.kickTimes, sim.beatAnchor.periodMs),
          visualBeatMs,
        )
        : 0,
    });
    if (!alive) endRecalibration();
  }

  // Debounced profile write: a burst of tapping is one save, not thirty.
  if (grooveSaveDue && tRaf >= grooveSaveAtMs) {
    grooveSaveDue = false;
    grooveSaveAtMs = tRaf + GROOVE_SAVE_DEBOUNCE_MS;
    setStoredGroove(groove);
  }

  // One composite per rendered frame, after the stage is final --
  // visionLoop samples the same canvas here, which is what says so.
  const capture = presented ? renderer?.getCaptureSource() : null;
  presentedFps.sample(tRaf, !!capture);
  if (capture) songRecorder?.captureFrame(capture);
  else if (songRecorder?.recording || pendingCapturePresetId) abortRecording('Presentation failed; the recording was discarded.');
  updateRecordReadout(tRaf);
  if (presented) visionLoop.maybeSample(tRaf, simTime);
  debugOverlay.render();

  // Fallback completion: FractureEngine finishes after musical last impact +
  // shatter, not after silence-padded duration. Guard still uses declared
  // duration so a stuck freeze never hangs forever.
  const durationMs = conductor.durationMs || 0;
  const musicalEnd = sim.fracture?.finale?.musicalEndMs ?? durationMs;
  if (durationMs > 0 && nowMs > Math.max(durationMs, musicalEnd) + 2500 && !sim.fracture.isDone) {
    onSongComplete();
    return;
  }
  if (sim.fracture.isDone) {
    onSongComplete();
    return;
  }

  rafHandle = requestAnimationFrame(frame);
}

function formatClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Build end-of-run stats: measurable song/run facts, no grade or score. */
function buildRunStats(sim) {
  return [
    { label: 'Duration', value: formatDuration(sim.conductor?.durationMs || 0) },
    { label: 'Tempo', value: sim.bpm ? `${Math.round(sim.bpm)} BPM` : '—' },
    { label: 'Sections', value: String(sim.biomes?.sections?.length || 0) },
    { label: 'Stage', value: `${canvas.width}×${canvas.height}`, wide: true },
  ];
}

function renderResultsGrid(stats) {
  if (!resultsGridEl) return;
  resultsGridEl.innerHTML = stats.map((s) => `
    <div class="statCell${s.wide ? ' statWide' : ''}">
      <span class="statLabel">${s.label}</span>
      <span class="statValue">${s.value}</span>
    </div>`).join('');
}

// Pointer is tracked so star-children can notice the user; never moves camera.
// Map client coords through the CSS rect into logical 1280×720 stage space.
//
// #stage is `object-fit: contain` (style.css): its bounding box fills its
// container, but the actual rendered 16:9 image is letterboxed/pillarboxed
// INSIDE that box whenever the container's own aspect ratio isn't exactly
// 16:9 -- which is the common case, not the exception (a 2000x900 window
// pillarboxes ~200px of dead space on each side). getBoundingClientRect()
// reports the full box, bars included, so dividing straight through it (as
// this used to) silently assumed the box's aspect was always 16:9. Every
// off-center tap was off by however wide the bars are -- measured at over
// 60px of strip-space error on a moderately widescreen window, worse on
// wider ones -- which is exactly the reported "seek lands ~100px from where
// I tapped." Clicks landing in the bars themselves (dead space, no stage
// content there at all) now correctly report no hit instead of being
// silently mapped onto the nearest stage edge.
function clientToStage(e) {
  const rect = canvas.getBoundingClientRect();
  return clientToStageCoords(e.clientX, e.clientY, rect, STAGE_W, STAGE_H);
}

/** The title screen's living backdrop: a slow, seeded starfield + nebula +
 *  a seeded star field and nebula, drawn to the stage
 *  canvas while no song is running. Runs on its own rAF loop so the very
 *  first frame a visitor sees is already a Midio world, not a flat
 *  gradient. Cheap (a few gradient fills + mesh strokes) and stops the
 *  instant a song starts. */
function titleFrame(tRaf) {
  if (running) return;
  if (!titleCadence.shouldDraw(tRaf, 1000 / fpsCapMs)) { titleRafHandle = requestAnimationFrame(titleFrame); return; }
  // Rebuilt whenever the backing store changes size, not just once: the
  // backdrop bakes its star and nebula positions against the dimensions it
  // was constructed with, so one built for a 1920x1080 buffer draws almost
  // entirely off-frame after a switch to 320x180 -- and the control that
  // makes that switch lives on this very screen.
  titlePresentation ??= new PixelPresentation({ canvas, presentation: effectivePresentation(), residency: sharedResidency() });
  titlePresentation.setFrameContext({ worldKind: null });
  const source = titlePresentation.beginFrame();
  if (!source) { titleRafHandle = requestAnimationFrame(titleFrame); return; }
  if (!titleBackdrop || titleBackdrop.width !== source.width || titleBackdrop.height !== source.height) {
    titleBackdrop = new TitleBackdrop({ seed: 1, width: source.width, height: source.height });
  }
  const ctx = source.getContext('2d');
  ctx.clearRect(0, 0, source.width, source.height);
  titleBackdrop.draw(ctx, tRaf / 1000, { pixelPolicy: pixelRenderPolicy({ ...effectivePresentation(), reducedMotion, reducedFlash }), reducedFlash });
  titlePresentation.finishFrame();
  // 8-bit intensive quantizes the title screen too. The song path runs this
  // from Renderer.draw(); doing it here as well means choosing the mode
  // visibly does something on the screen you choose it from, instead of
  // looking inert until a song starts.
  titleRafHandle = requestAnimationFrame(titleFrame);
}

function startTitleBackdrop() {
  titleCadence.reset();
  if (titleRafHandle == null) titleRafHandle = requestAnimationFrame(titleFrame);
}

function stopTitleBackdrop() {
  if (titleRafHandle != null) {
    cancelAnimationFrame(titleRafHandle);
    titleRafHandle = null;
  }
}

// The legacy stage has no player zoom. Range views do: the scroll wheel and
// a two-finger pinch fly the camera toward the pointer (RangeZoomInput.js).
// The pointer is also tracked so the star-children can notice where the
// user is. Client coords are mapped through the canvas rect into the
// 1280x720 stage space the sim draws in.
const rangeZoomInput = attachRangeZoomInput(canvas, {
  camera: rangeUserCamera,
  enabled: () => !!(running && sim?.userCameraEnabled && !rangePresentation?.tourMode),
  toStage: (e) => clientToStage(e),
  stageW: STAGE_W, stageH: STAGE_H,
});
canvas.addEventListener('pointermove', (e) => {
  if (!running || !sim || !sim.setPointer) return;
  const p = clientToStage(e);
  if (!p) return;
  sim.setPointer(p.x, p.y);
});

/**
 * The whole-song analysis has landed on a song that started on its opening
 * (OpeningAnalysis.js). Still on the picker, or waiting on lyrics: nothing to
 * do -- the song will start on the whole analysis. Already playing: rebuild
 * the show on it at the moment the music has reached, with the music, the
 * pause state and any recording left running (a seek without the seek).
 */
function adoptFullAnalysisLive(data) {
  if (!running || !sim || !audioEngine || lastTimelineData !== data) return;
  if (bulkExportArmed) return;
  const wasPaused = paused;
  startTimeline(data, {
    ...lastStartExtra,
    songSeed: sim.songSeed,
    startAtMs: Math.max(1, audioEngine.nowMs),
    keepAudio: true,
    keepUserCamera: true,
    preservePause: wasPaused,
    fitDiagnostic: sim.fitDiagnostic,
    chapterState: { previous: sim.biomes.chapterPlan, committedThroughMs: sim.heardTimeMs ?? audioEngine.nowMs, landSections: sim.biomes.sections,
      landscapeHistory: { previous: sim.biomes.landscapeScore, committedThroughMs: sim.heardTimeMs ?? audioEngine.nowMs } },
  });
  if (!running || !sim) return;
  if (wasPaused) { paused = true; updatePauseButtonUI(); }
  renderer.draw(sim, 1);
}

/** Seek is a fresh playback scene at the destination. Use the same complete
 * teardown/construction lifecycle as replay so no effect pool, timestamp,
 * subscription or renderer history can survive from the discarded future. */
function seekSong(ms) {
  if (!running || !sim || !audioEngine || !lastTimelineData || !Number.isFinite(ms)) return;
  const dur = Math.max(1, sim.conductor?.durationMs || audioEngine.nowMs + 1);
  const t = Math.max(0, Math.min(ms, dur - 1));
  const wasPaused = paused;
  const seed = sim.songSeed;
  const buffer = lastAudioBuffer;
  const selectedSection = renderer?.composer?.selectedSection;
  const hudInFrame = !!renderer?.hudInFrame;
  const showSectionLabels = !!sim.showSectionLabels;
  startTimeline(lastTimelineData, { songSeed: seed, startAtMs: t, keepUserCamera: true,
    playBuffer: buffer || undefined, preservePause: wasPaused, fitDiagnostic: sim.fitDiagnostic });
  if (!running || !sim) return;
  renderer.hudInFrame = hudInFrame;
  sim.showSectionLabels = showSectionLabels;
  if (buffer) audioEngine.playBuffer(buffer, t / 1000);
  if (wasPaused) {
    paused = true;
    audioEngine.ctx.suspend();
    updatePauseButtonUI();
  }
  renderer.draw(sim, 1);
  const composer = renderer.composer;
  if (composer && selectedSection != null) composer.selectedSection = selectedSection;
}

/** The player's own sense of "where's the beat" (BeatAnchor.js): stamped on
 *  the clock the EAR is on (visualNow), same discipline as every other
 *  beat-anchored cue in the sim. */
function beatTap(role = null, atMs = null) {
  if (!running || !sim || paused || !audioEngine) return;
  // A deferred touch tap (see the canvas handler) keeps its own moment.
  const tapMs = atMs ?? visualNow(audioEngine.nowMs, effectiveOutputLatencyMs());
  const eyePhase = recalibration.active && recalibration.phase === PHASE_EYE;
  // An eye-phase tap is aimed at a ring on the screen, not at the groove.
  // Feeding it to the anchor would teach BeatAnchor the display delay:
  // six consistent taps drag anchorMs toward it, and that anchor goes on
  // steering jumps and the ensemble long after the pass ends -- and, on a
  // roled tap, into the persisted groove fingerprint. It measures the
  // screen and nothing else.
  if (!eyePhase) sim.onBeatTap(tapMs, role);
  // During a Sync pass the same tap also sets the Bluetooth delay. Only
  // during one: taps are the beat anchor's the rest of the time, and having
  // an ordinary tap silently move an audio setting would be a surprise
  // nobody asked for.
  //
  // In the ear phase, only the low hand. Taps are measured against the
  // chart's KICKS, so a tap the player has explicitly marked as the high
  // part (J, or a right-click) is aimed at something else -- measuring it
  // here would file a backbeat's distance from the nearest kick as a
  // Bluetooth delay. It still reaches the beat anchor above, which wants
  // both hands.
  //
  // The eye phase has no such distinction: there is one ring, and both
  // hands are aimed at it. Filtering there would leave a player using the
  // documented right-hand input stuck at zero eye taps until the pass ran
  // out, with the trim then built from ear samples alone.
  if (recalibration.active && (eyePhase || role !== ROLE_HIGH)) applySyncTap(tapMs);
  // Persist on a roled tap only. Unroled catch-all taps move the anchor but
  // teach the templates nothing, and writing storage on every stray keypress
  // would be a lot of churn for no new information. An eye-phase tap never
  // reached the anchor at all, so it has nothing to persist either.
  if (role && !eyePhase) grooveSaveDue = true;
}

/** Open the eight-measure tap-recalibration count. Never pauses the song --
 *  taps keep flowing through the canvas handler into BeatAnchor as usual.
 *  Opt-in only (the 'C' key) -- there is no automatic prompt. */
function startRecalibration() {
  if (!running || !sim || paused || recalibration.active) return;
  recalibration.start(simTime, sim.beatAnchor.periodMs, sim.beatAnchor.confidence);
  // Start from the trim already in force rather than from zero: it is a
  // correction the player has already made, and the pass refines it.
  syncCalibrator.reset(btLatencyTrimMs);
  recalibration.setPhase(PHASE_EAR);
  recalibration.syncNote = 'Tap the kick when you hear it — the screen comes next.';
  sim.recalibrating = true;
  sim.syncMonitor.onCalibrated();
}

/**
 * One tap of a Sync pass: measure it against the chart's kicks and move the
 * Bluetooth delay to match, live.
 *
 * The taps are canon. If someone tapping along with what they hear lands
 * consistently after the song's kicks, the sound is reaching them late by
 * that much, and no amount of reasoning about typical Bluetooth round-trips
 * or the human tendency to anticipate a beat outranks what they just did.
 */
function applySyncTap(tapMs) {
  // A positive trim only works up to visualNow's own clamp; past it the
  // number rises and the picture does not, which for a loop that measures
  // its own residual is a runaway rather than a plateau.
  const result = syncCalibrator.tap(tapMs, sim.kickTimes, sim.beatAnchor.periodMs, {
    maxPositiveTrimMs: positiveTrimCeilingMs(audioEngine.outputLatencyMs),
  });
  // A tap with no kick near it measured nothing; the last good reading
  // stands rather than being diluted by a tap aimed at a rest.
  if (!result) return;
  recalibration.syncNote = syncStatusText(result);

  // Enough taps by ear: switch to measuring the screen. The player is not
  // asked to press anything -- the pass moves itself on, because stopping
  // to find a button is exactly the interruption this is meant to avoid.
  if (result.phase === PHASE_EAR && result.phaseComplete) {
    syncCalibrator.beginPhase(PHASE_EYE);
    // Re-base the pass deadline. The eight measures are a budget for ONE
    // half; a sparse chart can spend six of them on the ear taps alone, and
    // the eye half would then close after two -- persisting a trim built on
    // a two-sample median while the UI was still asking for six.
    recalibration.setPhase(PHASE_EYE, simTime);
  }

  if (!result.changed) return;
  btLatencyTrimMs = setBtLatencyTrimMs(result.trimMs);
  applyBtLatencyToAudioEngine();
  updateBtLatencyBtnUI();
  // The chip is the thing that just changed; show it rather than making
  // the player hunt for confirmation that the tapping did anything.
  wakeHud();
}

function endRecalibration() {
  if (!recalibration.active) return;
  const text = recalibration.resultText(sim ? sim.beatAnchor.confidence : 0);
  recalibration.stop();
  if (sim) sim.recalibrating = false;
  console.info('[recalibrate]', text, syncResultText(syncCalibrator));
}

// HUD auto-fade: both button clusters fade out after a few
// seconds with no interaction, and comes back awake on the next one. While
// asleep, a tap on the canvas is spent entirely on waking the HUD back up --
// it never also acts as a gameplay tap or a seek/section click, exactly the
// same "tap to unlock" beat a phone screen uses. Buttons themselves can't be
// hit while faded at all (CSS pointer-events:none on .hud-faded), so only
// the canvas path needs an explicit gate.
const HUD_FADE_MS = 3000;
let hudAwake = true;
let hudSleepAtMs = 0;
function wakeHud() {
  hudSleepAtMs = performance.now() + HUD_FADE_MS;
  if (hudAwake) return;
  hudAwake = true;
  hudRightEl?.classList.remove('hud-faded');
  hudLeftEl?.classList.remove('hud-faded');
}
function hudIdleTick(nowRafMs) {
  // A recording holds the HUD open. The stop control is in there, and a
  // faded HUD sits under the canvas -- so letting it fade would mean the
  // only way to end a recording is to tap the stage first, and that tap is
  // deliberately absorbed by the wake-up handler (see car-mode.md). The
  // player would press twice and wonder why the first did nothing. The
  // live elapsed/size readout wants to stay on screen anyway.
  if (songRecorder?.recording) { hudSleepAtMs = nowRafMs + HUD_FADE_MS; return; }
  // A Sync pass holds it open too: the Sync button is how the pass ends,
  // and hunting for a control that has faded under the canvas is the
  // interruption the whole overlay is built to avoid.
  if (recalibration.active) { hudSleepAtMs = nowRafMs + HUD_FADE_MS; return; }
  // An open editor is being used, whatever the idle timer thinks. Fading
  // the Bluetooth chip out from under a half-typed value is the exact
  // complaint that kept this cluster pinned open in the first place; the
  // answer is to hold it while the popover is up, not to never fade it.
  if (btLatencyPopoverEl && !btLatencyPopoverEl.classList.contains('hidden')) {
    hudSleepAtMs = nowRafMs + HUD_FADE_MS;
    return;
  }
  // Full names and credits need time to read; keyboard focus must keep
  // the summary reachable even before the reader opens it.
  if (rangeCaptionDetailsEl && !rangeCaptionDetailsEl.hidden
    && (rangeCaptionDetailsEl.open || rangeCaptionDetailsEl.contains(document.activeElement))) {
    wakeHud();
    hudSleepAtMs = nowRafMs + HUD_FADE_MS;
    return;
  }
  if (hudAwake && nowRafMs >= hudSleepAtMs) {
    hudAwake = false;
    hudRightEl?.classList.add('hud-faded');
    hudLeftEl?.classList.add('hud-faded');
  }
}
hudRightEl?.addEventListener('pointerdown', wakeHud);
hudLeftEl?.addEventListener('pointerdown', wakeHud);
hudRightEl?.addEventListener('focusin', wakeHud);
hudLeftEl?.addEventListener('focusin', wakeHud);
rangeCaptionDetailsEl?.addEventListener('toggle', wakeHud);

// Mountain seekbar: click to seek; click a section to open its debug detail.
// Anywhere else on the canvas -- not a button, not the seekbar -- resyncs
// the player's beat anchor instead.
// Right-click is the high hand, so the browser's own menu has to stay out of
// the way -- otherwise every high tap on the canvas pops it open.
canvas.addEventListener('contextmenu', (e) => { if (running && sim) e.preventDefault(); });

// Over a Range view a touch may be the first finger of a pinch, so its
// tap waits this long for a second finger before it counts (the beat tap
// keeps the moment the finger landed).
const PINCH_TAP_WAIT_MS = 140;
let pendingTouchTap = null;
function cancelPendingTouchTap() {
  if (pendingTouchTap) { clearTimeout(pendingTouchTap.timer); pendingTouchTap = null; }
}
/** A new finger after the last one lifted is its own tap: the waiting one
 *  counts now rather than being dropped. */
function flushPendingTouchTap() {
  const t = pendingTouchTap;
  if (!t) return;
  cancelPendingTouchTap();
  t.fire();
}

canvas.addEventListener('pointerdown', (e) => {
  if (!running || !sim) return;
  // Every canvas tap prevents default -- previously only the seekbar-hit
  // branch below did, so a plain tap-to-beat-tap (the common case, and the
  // only input touch has at all) left double-tap-to-zoom and the ~300ms
  // synthetic-click delay in play on mobile.
  e.preventDefault();
  // A second finger makes it a pinch: neither finger is a tap.
  if (rangeZoomInput.pinching(e)) { cancelPendingTouchTap(); return; }
  if (e.pointerType === 'touch' && rangeZoomInput.live()) {
    flushPendingTouchTap();
    const p = clientToStage(e), button = e.button;
    const atMs = audioEngine ? visualNow(audioEngine.nowMs, effectiveOutputLatencyMs()) : null;
    const fire = () => canvasTap(p, button, atMs);
    pendingTouchTap = { fire, timer: setTimeout(() => { pendingTouchTap = null; fire(); }, PINCH_TAP_WAIT_MS) };
    return;
  }
  canvasTap(clientToStage(e), e.button);
});

function canvasTap(p, button, atMs = null) {
  if (!running || !sim) return;
  if (!hudAwake) { wakeHud(); return; }
  wakeHud();
  if (!p) return;
  const hit = hitTestComposerStrip(renderer, p.x, p.y, { width: STAGE_W, height: STAGE_H });
  const composer = renderer?.composer;
  // Mouse buttons mirror the keys: left pairs with F (low), right with J
  // (high). Anything else (middle, back/forward) stays an unroled tap rather
  // than being silently filed as one of the two hands.
  if (!hit) { beatTap(button === 2 ? ROLE_HIGH : button === 0 ? ROLE_LOW : null, atMs); return; }
  if (hit.type === 'detail') return; // keep overlay open
  if (hit.type === 'strip') {
    // Toggle section detail when re-clicking the same section; always seek.
    if (hit.sectionIndex >= 0) {
      if (composer.selectedSection === hit.sectionIndex) {
        composer.selectedSection = -1;
      } else {
        composer.selectedSection = hit.sectionIndex;
      }
    }
    seekSong(hit.tMs);
  }
}

// The keys a player unfamiliar with the autoplay premise reaches for
// expecting direct control -- see the keydown handler below.
const INERT_KEYS = new Set([
  ' ', 'Spacebar', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'w', 'W', 'a', 'A', 's', 'S', 'd', 'D',
]);

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // A modal chooser owns keyboard input. R stays available for accessibility;
  // all other keys retain native dialog/button behavior, including Escape.
  if (document.getElementById('plexLibraryPanel')?.open) return;
  if (worldSelectEl?.open) {
    if (e.key === 'r' || e.key === 'R') toggleReducedFlash();
    return;
  }
  // Native controls must receive their Enter/Space default actions before
  // the gameplay handler's inert-key guard can suppress them.
  if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')
    && e.target?.closest?.('button, input, select, textarea, a')) return;
  if (running) wakeHud();
  if (e.key === 'Escape') {
    if (filmstripModalEl && !filmstripModalEl.classList.contains('hidden')) closeFilmstripModal();
    // Close section detail overlay on the seekbar.
    const composer = renderer?.composer;
    if (composer && composer.selectedSection >= 0) {
      composer.selectedSection = -1;
    }
    return;
  }
  // F3 — toggle how the engine labeled song sections on the mountain seekbar.
  // Selection / detail overlay is independent (click a section; Esc to close).
  if (e.key === 'F3') {
    e.preventDefault();
    if (!sim) return;
    sim.showSectionLabels = !sim.showSectionLabels;
    if (renderer) renderer.hudInFrame = !!sim.showSectionLabels;
    if (paramBus) paramBus.showSectionLabels = sim.showSectionLabels;
    return;
  }
  // F4 — hold scanned ridges still so the geographic profile can be checked.
  if (e.key === 'F4') {
    e.preventDefault();
    if (!sim?.biomes) return;
    sim.biomes.terrainPreview = !sim.biomes.terrainPreview;
    return;
  }
  // Tap recalibration. Must return before the catch-all beat-tap branch at
  // the bottom, or opening the overlay would also register a stray tap and
  // start the anchor's session on a timestamp the player didn't mean.
  if (e.key === 'c' || e.key === 'C') {
    if (recalibration.active) endRecalibration(); else startRecalibration();
    return;
  }
  // The two calibration hands. Always live -- there is no mode to enter and
  // nothing to open first; the overlay (C) is guidance, not a gate. Both feed
  // the beat anchor exactly as any tap always has, and additionally tell the
  // groove fingerprint WHICH drum the player was answering, which is the part
  // an anonymous timestamp could never carry.
  if (e.key === 'f' || e.key === 'F') { beatTap(ROLE_LOW); return; }
  if (e.key === 'j' || e.key === 'J') { beatTap(ROLE_HIGH); return; }
  if (e.key === 'r' || e.key === 'R') { toggleReducedFlash(); return; }

  if (e.key === 'p' || e.key === 'P') {
    fpsHudVisible = !fpsHudVisible;
    fpsHudEl?.classList.toggle('hidden', !fpsHudVisible);
    return;
  }
  // `T` toggles the always-present, player-facing track badge (index.html's
  // #trackBadge) -- visible, self-explanatory, fully reversible, so it
  // stays ungated like P/F3. `` ` `` (the full telemetry overlay) and V
  // (silently toggles the Ollama vision loop -- changes engine behavior
  // with zero visible indication) are the two that read as "the controls
  // are broken" if hit by accident, so those are dev-gated.
  if (e.key === 't' || e.key === 'T') { toggleTrackList(); return; }
  if (DEV_MODE && debugOverlay) {
    if (e.key === '`') { debugOverlay.toggle(); return; }
    if (e.key === 'v' || e.key === 'V') { debugOverlay.toggleVision(); return; }
  }
  // Reserved regardless of whether the debug overlay happens to be up yet.
  if (e.key === '`' || e.key === 'v' || e.key === 'V' || e.key === 't' || e.key === 'T') return;

  // Midio plays himself -- these are the keys a first-time player reaches
  // for expecting to control him directly (no jump key exists). Letting
  // them fall through to the catch-all beat-tap below used to mean mashing
  // Space/arrows/WASD didn't just do nothing, it actively nudged the beat
  // anchor and degraded sync -- the exact behavior that reads as "the
  // controls are broken." Inert here, and preventDefault so Space/arrows
  // don't also scroll the page.
  if (INERT_KEYS.has(e.key)) { e.preventDefault(); return; }

  // Almost any other key resyncs the player's beat anchor (BeatAnchor.js) --
  // ignore held-key auto-repeat, modifier chords, and typing into a field.
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  beatTap();
});

/** The Reel (Movement VI): live-toggle + persist the reduced-flash
 *  accessibility setting, cascading into the running sim if there is one. */
function toggleReducedFlash() {
  reducedFlash = !reducedFlash;
  setReducedFlash(reducedFlash);
  sim?.setReducedFlash(reducedFlash);
  syncFlashButton();
  if (worldSelectEl?.open && previewSession) {
    // Rebuild stills and stop any live animation/audio using the old setting.
    const worldId = previewSession.activePreviewId;
    const passage = previewSession.passage;
    startChooserPreviews();
    previewSession?.setPassage(passage);
    syncPassageButtons();
    if (worldId) previewSelectedWorld(worldId);
  }
}

/** Reflects the current trim in the chip. Takes effect on the very next
 *  frame either way -- effectiveOutputLatencyMs() reads the live
 *  `btLatencyTrimMs` variable, so nothing needs to be re-armed on the
 *  running sim the way reducedFlash cascades into one; the choreography
 *  clock just starts reading a different number. A negative trim shows its
 *  own sign (Number.toString already includes the "-"); only the positive
 *  case gets an explicit "+", since a bare number there would otherwise
 *  read as ambiguous about which way the correction goes. */
function updateBtLatencyBtnUI() {
  if (!btLatencyBtnEl) return;
  btLatencyBtnEl.setAttribute('aria-pressed', btLatencyTrimMs !== 0 ? 'true' : 'false');
  btLatencyBtnEl.textContent = btLatencyTrimMs > 0 ? `BT +${btLatencyTrimMs}ms`
    : btLatencyTrimMs < 0 ? `BT ${btLatencyTrimMs}ms`
      : 'BT: off';
}

function closeBtLatencyPopover() {
  btLatencyPopoverEl?.classList.add('hidden');
  btLatencyBtnEl?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onBtLatencyOutsideClick, true);
}
/** Closes on a tap/click outside the control -- the button itself is
 *  excluded so its own click handler (which toggles) fires normally
 *  instead of racing a close-then-reopen. */
function onBtLatencyOutsideClick(e) {
  if (btLatencyPopoverEl?.contains(e.target) || btLatencyBtnEl?.contains(e.target)) return;
  closeBtLatencyPopover();
}
function openBtLatencyPopover() {
  if (!btLatencyPopoverEl || !btLatencyInputEl) return;
  btLatencyInputEl.value = String(btLatencyTrimMs !== 0 ? btLatencyTrimMs : BT_LATENCY_TRIM_MS);
  btLatencyPopoverEl.classList.remove('hidden');
  btLatencyBtnEl?.setAttribute('aria-expanded', 'true');
  btLatencyInputEl.focus();
  btLatencyInputEl.select();
  // Capture phase: outside-click has to see the event before anything
  // inside the popover (like Apply's own click) could stop it, or a tap on
  // Set/Off would close-then-reopen instead of applying.
  document.addEventListener('pointerdown', onBtLatencyOutsideClick, true);
}

/** Reads, clamps (setBtLatencyTrimMs does the clamping and persists), and
 *  applies the typed value -- takes effect next frame, same as the toggle
 *  this replaced. A negative value's half of the correction (the audio
 *  delay) is separately pushed straight to the running AudioEngine, since
 *  that side isn't read live from `btLatencyTrimMs` the way visuals are. */
function applyBtLatencyTrim() {
  if (!btLatencyInputEl) return;
  btLatencyTrimMs = setBtLatencyTrimMs(btLatencyInputEl.value);
  applyBtLatencyToAudioEngine();
  updateBtLatencyBtnUI();
  adoptManualTrim();
  closeBtLatencyPopover();
}
function turnOffBtLatencyTrim() {
  btLatencyTrimMs = setBtLatencyTrimMs(0);
  applyBtLatencyToAudioEngine();
  updateBtLatencyBtnUI();
  adoptManualTrim();
  closeBtLatencyPopover();
}

/**
 * A trim typed in by hand replaces whatever the calibrator was converging
 * on.
 *
 * The chip stays reachable during a Sync pass, and a tap taken afterwards
 * is stamped through the NEW trim while the calibrator would still be
 * adding its old one -- so the next tap would overwrite the manual value
 * with one displaced by the difference. Resetting rather than patching the
 * number is the honest move: taps collected under the old trim are no
 * longer evidence about this one.
 */
function adoptManualTrim() {
  syncCalibrator.reset(btLatencyTrimMs);
  if (recalibration.active) {
    // reset() puts the calibrator back on the ear phase, so the overlay has
    // to go back with it. Left on the eye phase it would still be telling
    // the player to tap the flashing ring while every one of those taps was
    // stored as an ear sample -- measuring the screen, filing it as the
    // sound, and overwriting the value the player just typed by hand.
    recalibration.setPhase(PHASE_EAR, simTime);
    recalibration.syncNote = `Bluetooth delay: ${Math.abs(btLatencyTrimMs)}ms, set by hand — tap to refine it.`;
  }
}

btLatencyBtnEl?.addEventListener('click', () => {
  if (btLatencyPopoverEl?.classList.contains('hidden')) openBtLatencyPopover();
  else closeBtLatencyPopover();
});
btLatencyApplyBtnEl?.addEventListener('click', () => applyBtLatencyTrim());
btLatencyOffBtnEl?.addEventListener('click', () => turnOffBtLatencyTrim());
btLatencyInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyBtLatencyTrim(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeBtLatencyPopover(); }
  // Stop the event reaching window's own keydown handler entirely: several
  // of its branches (F/L/etc. single-letter shortcuts) fire before that
  // handler's own typing guard runs, so without this, typing a digit like
  // "5" here would be harmless, but a stray letter key would trigger
  // whatever shortcut it's bound to while this popover is open.
  e.stopPropagation();
});
updateBtLatencyBtnUI();

function onSongComplete() {
  running = false;
  hudEl.classList.add('hidden');
  // Silence audio under the complete panel (otherwise the buffer/SF2 keeps going).
  audioEngine?.pause();
  synth?.stopAll?.();

  lastSongSeed = sim.songSeed;
  if (completeSongNameEl) {
    const name = sessionSongName(lastTimelineData, lastSongName).replace(/\.[a-z0-9]+$/i, '');
    completeSongNameEl.textContent = name;
  }
  if (completeSeedEl) completeSeedEl.textContent = formatSeed(sim.songSeed);
  renderResultsGrid(buildRunStats(sim));
  renderFilmstrip(sim.highlightReel?.frames || []);
  completePanelEl.classList.remove('hidden');
  syncExportUI();
  // A full-song export ends where the song does. Awaiting it here would
  // hold up the panel, so it saves itself and writes its own line.
  if (songRecorder?.recording) finishRecording();
}

/** Restart the last-loaded song. Pass songSeed to pin the world; omit for
 *  the song-derived default. Explicit completion-screen seeds still override it. */
function replaySong({ songSeed } = {}) {
  if (!lastTimelineData) { window.location.reload(); return; }
  // A full-song recording is the whole song: wait for its analysis rather
  // than record the part past the opening with nothing driving it.
  if (pendingExportPresetId && lastTimelineData.opening && fullAnalysisPending) {
    const waitingOn = lastTimelineData;
    showProgress('Finishing the analysis…');
    fullAnalysisPending.finally(() => {
      progressEl.classList.add('hidden');
      if (lastTimelineData === waitingOn) replaySong({ songSeed });
    });
    return;
  }
  // Capture buffer before rebuild — startTimeline stops the AudioContext source
  // via stopTimeline, but must not lose the decoded song for the restart.
  const buffer = lastAudioBuffer;
  if (buffer) muteTimelineSynth = true;
  startTimeline(lastTimelineData, {
    songSeed: songSeed !== undefined ? songSeed : null,
    playBuffer: buffer || undefined,
    captureMode: !!pendingExportPresetId,
  });
  // A full-song export replays the song with the recorder armed, so the
  // file covers it start to finish rather than from wherever someone
  // managed to press a button.
  if (pendingExportPresetId) {
    const presetId = pendingExportPresetId;
    pendingExportPresetId = null;
    startRecording(presetId);
  }
  // Start the recorder's master-bus tap before the replacement source. That
  // keeps the first audio onset inside a full-song file instead of letting
  // playback begin a few milliseconds before MediaRecorder exists.
  if (buffer) {
    lastAudioBuffer = buffer;
    audioEngine.playBuffer(buffer, 0);
  }
  // Completion seed readout stays in sync with the run that just started.
  if (sim?.songSeed != null) {
    lastSongSeed = sim.songSeed;
    if (completeSeedEl) completeSeedEl.textContent = formatSeed(sim.songSeed);
  }
}

/** The Reel: the COMPLETE panel's highlight filmstrip -- proof of what the
 *  song just did. Click a frame to enlarge it; the modal offers a
 *  per-frame download link. */
function renderFilmstrip(frames) {
  if (!filmstripEl) return;
  if (!frames.length) {
    filmstripEl.innerHTML = '';
    filmstripEl.classList.add('hidden');
    return;
  }
  filmstripEl.classList.remove('hidden');
  filmstripEl.innerHTML = frames.map((f, i) =>
    `<button type="button" class="filmstripFrame" data-index="${i}" title="${escapeHtml(f.label)}">`
    + `<img src="${f.dataUrl}" alt="${escapeHtml(f.label)}" /></button>`,
  ).join('');
}

function openFilmstripModal(frame) {
  if (!filmstripModalEl) return;
  filmstripModalTitleEl.textContent = frame.label;
  filmstripModalImgEl.src = frame.dataUrl;
  filmstripModalImgEl.alt = frame.label;
  const slug = frame.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  filmstripModalDownloadEl.href = frame.dataUrl;
  filmstripModalDownloadEl.download = `super-midio-world-${slug}-${Math.round(frame.atMs)}ms.jpg`;
  filmstripModalEl.classList.remove('hidden');
}

function closeFilmstripModal() {
  filmstripModalEl?.classList.add('hidden');
}

if (filmstripEl) {
  filmstripEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.filmstripFrame');
    if (!btn) return;
    const frame = sim?.highlightReel?.frames?.[Number(btn.dataset.index)];
    if (frame) openFilmstripModal(frame);
  });
}
if (filmstripModalCloseEl) filmstripModalCloseEl.addEventListener('click', closeFilmstripModal);
if (filmstripModalEl) {
  filmstripModalEl.addEventListener('click', (e) => { if (e.target === filmstripModalEl) closeFilmstripModal(); });
}

playAgainBtnEl?.addEventListener('click', () => backToTitle());

// Replay seed: exactly the run that just played, nothing else in the mix.
replaySameSeedBtnEl?.addEventListener('click', () => {
  replaySong({ songSeed: lastSongSeed });
});

// New seed: prompt for one inline on the card, then replay with it.
replayNewSeedBtnEl?.addEventListener('click', () => {
  if (!completeNewSeedRowEl || !completeNewSeedInputEl) { replaySong({ songSeed: randomizeSeed() }); return; }
  completeNewSeedInputEl.value = formatSeed((Math.random() * 0x100000000) >>> 0);
  completeNewSeedRowEl.classList.remove('hidden');
  completeNewSeedInputEl.focus();
  completeNewSeedInputEl.select();
});

completeNewSeedCancelBtnEl?.addEventListener('click', () => {
  completeNewSeedRowEl?.classList.add('hidden');
});

completeNewSeedStartBtnEl?.addEventListener('click', () => {
  const parsed = parseSeed(completeNewSeedInputEl?.value);
  const s = parsed != null ? parsed : (Math.random() * 0x100000000) >>> 0;
  completeNewSeedRowEl?.classList.add('hidden');
  replaySong({ songSeed: s });
});

completeNewSeedInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); completeNewSeedStartBtnEl?.click(); }
  else if (e.key === 'Escape') { e.preventDefault(); completeNewSeedCancelBtnEl?.click(); }
});

copySeedBtnEl?.addEventListener('click', async () => {
  const text = completeSeedEl?.textContent?.trim() || formatSeed(lastSongSeed || 0);
  try {
    await navigator.clipboard.writeText(text);
    copySeedBtnEl.textContent = 'Copied';
    setTimeout(() => { copySeedBtnEl.textContent = 'Copy'; }, 1200);
  } catch {
    // The seed remains visible in the completion panel for manual copying.
  }
});

// ===================================================================
// MUSIC LIBRARY
//
// A folder chosen once, remembered, and browsable. Nothing is uploaded and
// nothing is copied: the File System Access API hands back a handle to a
// folder the player already has, and that handle is what gets stored.
//
// The library is an addition, not a replacement -- dropping a file on the
// page still works exactly as it did, and every path below degrades to
// "there is no library" rather than to an error, because a browser with no
// IndexedDB and no directory picker must still be able to play a song.
// ===================================================================

const libraryPanelEl = document.getElementById('libraryPanel');
const libraryHomeEl = document.getElementById('libraryHome');
const libraryRecentEl = document.getElementById('libraryRecent');
const libraryHomeNoteEl = document.getElementById('libraryHomeNote');
const libraryOpenBtnEl = document.getElementById('libraryOpenBtn');
const libraryFolderBtnEl = document.getElementById('libraryFolderBtn');
const libraryFolderFallbackEl = document.getElementById('libraryFolderFallback');
const libraryFolderInputEl = document.getElementById('libraryFolderInput');
const libraryFolderHintEl = document.querySelector('.libraryFolderHint');

const musicLibrary = new MusicLibrary();
/** Set when a load came from the library, so the decode can report the
 *  track's real duration back. Cleared as soon as it is consumed. */
let autoTagAbort = null;

const libraryPanel = libraryPanelEl
  ? new LibraryPanel({
    root: libraryPanelEl,
    onPlay: (track) => playLibraryTrack(track),
    onPickFolder: () => chooseMusicFolder(),
    onRescan: () => rescanLibrary(),
    onAutoTag: () => runAutoTag(),
    onForget: () => forgetLibrary(),
    onClose: () => closeLibrary(),
  })
  : null;

/** Only the browsers that can actually honour a control are shown it: one
 *  that can keep a directory handle gets the picker, one that cannot gets
 *  the `webkitdirectory` input and, later, the caveat that goes with it. */
function syncFolderControls() {
  const canPersist = musicLibrary.persistable;
  libraryFolderBtnEl?.classList.toggle('hidden', !canPersist);
  libraryFolderFallbackEl?.classList.toggle('hidden', canPersist);
}

function renderLibraryHome() {
  if (!libraryHomeEl) return;
  const tracks = musicLibrary.tracks;
  const hasLibrary = tracks.length > 0;
  libraryHomeEl.classList.toggle('hidden', !hasLibrary);
  // With a library on screen, dropping a file is the secondary way in, so
  // the dropzone stops being the loudest thing on the page.
  dropzoneEl?.classList.toggle('isSecondary', hasLibrary);
  // Once there IS a folder, the row below stops being an invitation and
  // becomes a way to swap it -- so it says that instead of re-pitching the
  // privacy line to someone who already accepted it.
  const folderLabel = hasLibrary ? 'Change folder' : 'Use a music folder';
  if (libraryFolderBtnEl) libraryFolderBtnEl.textContent = folderLabel;
  if (libraryFolderFallbackEl) libraryFolderFallbackEl.textContent = folderLabel;
  if (libraryFolderHintEl) {
    libraryFolderHintEl.textContent = hasLibrary
      ? `Reading from ${musicLibrary.root?.name || 'your folder'}.`
      : 'Choose it once and it stays. Your files never leave the device — the folder is read straight off your disk.';
  }
  if (!hasLibrary) return;

  if (libraryOpenBtnEl) {
    libraryOpenBtnEl.textContent = `Browse all ${tracks.length.toLocaleString()}`;
  }

  // Never played anything yet? Then "jump back in" is a lie, and the right
  // offer is a handful of the library to start from.
  const recent = recentlyPlayed(tracks, 5);
  const offered = recent.length ? recent : tracks.slice(0, 5);
  const heading = libraryHomeEl.querySelector('.libraryHomeTitle');
  if (heading) heading.textContent = recent.length ? 'Jump back in' : 'From your library';

  libraryRecentEl.textContent = '';
  for (const track of offered) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recentChip';
    chip.title = track.path;
    const title = document.createElement('span');
    title.className = 'recentChipTitle';
    title.textContent = displayTitle(track);
    const artist = document.createElement('span');
    artist.className = 'recentChipArtist';
    artist.textContent = displayArtist(track);
    chip.append(title, artist);
    chip.addEventListener('click', () => playLibraryTrack(track));
    libraryRecentEl.appendChild(chip);
  }

  if (libraryHomeNoteEl) {
    // A library that cannot be read right now has to say so here, not fail
    // silently when something is clicked.
    const needsFolder = !musicLibrary.playable;
    libraryHomeNoteEl.classList.toggle('hidden', !needsFolder);
    libraryHomeNoteEl.textContent = needsFolder
      ? 'Pick the folder again to play from it — this browser can’t reopen it on its own.'
      : '';
  }
}

musicLibrary.subscribe(() => {
  renderLibraryHome();
  if (!libraryPanel) return;
  libraryPanel.setRoot({
    name: musicLibrary.root?.name || '',
    // Playable and durable are different promises: a webkitdirectory File
    // list (or a handle whose IndexedDB write failed) works now but cannot
    // be reopened after reload.
    persistable: !!musicLibrary.root?.persistable,
    trackCount: musicLibrary.tracks.length,
  });
  libraryPanel.setTracks(musicLibrary.tracks);
  libraryPanel.setScanning(musicLibrary.scanning, musicLibrary.scannedCount);
});

function openLibrary() {
  if (!libraryPanelEl) return;
  unlockAudio();
  libraryPanelEl.classList.remove('hidden');
  if (!libraryPanelEl.open) libraryPanelEl.showModal();
  libraryPanel?.focusSearch();
}

/**
 * Hide the library.
 *
 * `cancelScan` separates the two reasons the panel closes. Dismissing it --
 * the close button, Escape -- abandons a scan in flight, because closing it
 * over a large drive should stop reading the drive and not merely stop
 * showing it. Closing it to PLAY something is not that: the whole point of
 * streaming results is that you can start the first song you recognise, and
 * having that silently end the import would leave the rest of the folder
 * unscanned until someone thought to rescan it by hand.
 */
function closeLibrary({ cancelScan = true } = {}) {
  if (libraryPanelEl?.open) libraryPanelEl.close();
  libraryPanelEl?.classList.add('hidden');
  if (cancelScan) musicLibrary.cancel();
  autoTagAbort?.abort?.();
  autoTagAbort = null;
}

/** Turn a stored track back into the drop that the whole load path already
 *  understands, so a library play and a dropped file are the same thing
 *  from here on. */
async function playLibraryTrack(track) {
  if (!track) return;
  unlockAudio();
  const selection = beginAudioSelection('library');
  // A remembered library with no live handle: one click gets it back rather
  // than making the player hunt for the folder button.
  if (!musicLibrary.playable && musicLibrary.root?.handle) {
    if (!await musicLibrary.grantAccess()) {
      showErrorBanner('Allow access to your music folder to play from the library.');
      return;
    }
  }
  if (!audioSelections.isCurrent(selection)) return;
  const file = await musicLibrary.openFile(track);
  if (!audioSelections.isCurrent(selection)) return;
  if (!file) {
    showErrorBanner(musicLibrary.playable
      ? `“${displayTitle(track)}” isn’t where the library remembers it. Rescan the folder to catch up.`
      : 'Pick your music folder again to play from the library.');
    return;
  }
  // The scan keeps running: playing the first track you recognise is the
  // reason the rows stream in at all.
  closeLibrary({ cancelScan: false });
  handleFiles([file], { selection, localTrack: track });
}

async function chooseMusicFolder() {
  if (!musicLibrary.supported) {
    showErrorBanner('This browser has no storage available, so a library can’t be kept here. Dropping a song still works.');
    return;
  }
  if (!musicLibrary.persistable) {
    // The `webkitdirectory` fallback is still an <input type="file">, so a
    // browser with no chooser cannot open it either -- same route, same
    // suppression, same alternative offered.
    openFilePicker(libraryFolderInputEl);
    return;
  }
  try {
    await musicLibrary.pickFolder({
      // The picker has closed and the walk is about to start: open the
      // library NOW. It used to open only once the scan finished, which on
      // a real music folder is minutes of a screen that looks like the
      // button did nothing.
      // The status line is the panel's own: see LibraryPanel.setScanning,
      // which has the folder name and the running total together.
      onRootChosen: () => openLibrary(),
    });
  } catch (err) {
    console.warn('[library] folder scan failed', err);
    showErrorBanner('Could not read that folder: ' + (err?.message || err));
  } finally {
    libraryPanel?.render();
    syncFolderControls();
  }
  // Audio is booted after the picker, never before it: constructing the
  // engine takes time the browser counts against the gesture that opened
  // the picker.
  unlockAudio();
}

async function rescanLibrary() {
  libraryPanel?.setBusy(true, 'Rescanning…');
  try {
    if (!musicLibrary.playable && !await musicLibrary.grantAccess()) {
      showErrorBanner('Allow access to your music folder to rescan it.');
      return;
    }
    await musicLibrary.rescan();
  } finally {
    libraryPanel?.setBusy(false);
    libraryPanel?.render();
  }
}

async function forgetLibrary() {
  await musicLibrary.forget();
  libraryPanel?.render();
  closeLibrary();
}

async function runAutoTag() {
  const pending = untaggedTracks(musicLibrary.tracks).length;
  if (!pending) {
    libraryPanel?.setStatus('Every track already has a title and artist.');
    return;
  }
  autoTagAbort?.abort?.();
  autoTagAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
  libraryPanel?.setBusy(true, `Looking up ${pending.toLocaleString()} tracks…`);
  try {
    const tagged = await musicLibrary.autoTag({
      signal: autoTagAbort?.signal || null,
      // One per second is MusicBrainz's published rate for anonymous
      // clients, so a big folder is minutes of work. Saying how far along
      // it is turns that from a hang into progress.
      onProgress: (done, total, found) => libraryPanel?.setStatus(
        `Looking up tags… ${done.toLocaleString()} of ${total.toLocaleString()} (${found.toLocaleString()} found)`,
      ),
    });
    libraryPanel?.setBusy(false);
    libraryPanel?.setStatus(tagged
      ? `Tagged ${tagged.toLocaleString()} of ${pending.toLocaleString()} tracks.`
      : 'No matches found for those tracks.');
  } catch (err) {
    console.warn('[library] auto-tag failed', err);
    libraryPanel?.setBusy(false);
    libraryPanel?.setStatus('Tag lookup failed — check your connection and try again.');
  } finally {
    autoTagAbort = null;
  }
}

libraryOpenBtnEl?.addEventListener('click', openLibrary);
libraryFolderBtnEl?.addEventListener('click', chooseMusicFolder);
// Was a <label> wrapping #libraryFolderInput; same bypass, same fix.
libraryFolderFallbackEl?.addEventListener('click', chooseMusicFolder);
libraryFolderInputEl?.addEventListener('change', async (e) => {
  // Copy BEFORE clearing: `e.target.files` is a live FileList view of the
  // input, so resetting the value empties the list the scan is about to
  // read. Clearing is still required, or re-picking the same folder never
  // fires `change` again.
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  unlockAudio();
  libraryPanel?.setBusy(true, 'Reading folder…');
  try {
    await musicLibrary.adoptFileList(files, { onRootChosen: () => openLibrary() });
  } finally {
    libraryPanel?.setBusy(false);
    libraryPanel?.render();
  }
});

// A modal <dialog> handles Escape itself. All this has to do is make sure
// the dismissal runs the same teardown a click on the close button does --
// otherwise Escape would leave a scan reading a ten-thousand-track drive.
libraryPanelEl?.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeLibrary();
});

syncFolderControls();
musicLibrary.init().catch((err) => console.warn('[library] could not be loaded', err));

// ===================================================================
// VIDEO EXPORT
//
// Recording the show to a file. The interesting problem is not capture --
// MediaRecorder does that -- it is sync, and why a recording has it when a
// mirrored or projected screen does not: here the picture and the sound are
// two tracks stamped from one clock, so a show choreographed to the beat
// stays on it. On a car head unit fed by a projection dongle they arrive by
// different paths with independent latency, which is what the Bluetooth
// trim in the HUD exists to fight. A file does not need the trim.
//
// The other thing this owns is honesty about the format. See VideoExport.js:
// `MediaRecorder.isTypeSupported('video/mp4')` can answer yes and then hand
// back VP9 in an MP4 wrapper, which a head unit refuses. What the player is
// told comes from the bytes of the finished file, not the extension.
// ===================================================================

const recordBtnEl = document.getElementById('recordBtn');
const recordStatusEl = document.getElementById('recordStatus');
const completeExportEl = document.getElementById('completeExport');
const exportPresetEl = document.getElementById('exportPreset');
const exportBtnEl = document.getElementById('exportBtn');
const exportNoteEl = document.getElementById('exportNote');

const EXPORT_PRESET_KEY = 'midio.export.preset';

let songRecorder = null;
/** Set just before a replay so the recorder starts with the new song. */
let pendingExportPresetId = null;
/** Mid-song capture waits until the live presentation lead has been paid
 * down without rewinding simulation time. */
let pendingCapturePresetId = null;
/** The last object URL handed out, revoked when the next one replaces it. */
let lastExportUrl = null;

function storedExportPresetId() {
  try { return presetById(localStorage.getItem(EXPORT_PRESET_KEY)).id; } catch { return DEFAULT_PRESET_ID; }
}

function rememberExportPresetId(id) {
  try { localStorage.setItem(EXPORT_PRESET_KEY, id); } catch { /* private mode */ }
}

/** The recorder needs the audio graph, so it cannot exist before bootAudio.
 *  Built once and reused: the master-bus tap is connected per recording and
 *  released again when each one ends. */
function ensureRecorder() {
  if (songRecorder || !audioEngine?.ctx) return songRecorder;
  songRecorder = new SongRecorder({
    stage: canvas,
    audioContext: audioEngine.ctx,
    audioSource: audioEngine.master,
    onAutoStop: () => finishRecording(),
  });
  return songRecorder;
}

function beginRecorder(presetId) {
  const recorder = ensureRecorder();
  if (!recorder) { showErrorBanner('Start a song before recording.'); return false; }
  if (!recorder.start({ presetId, deferFirstFrame: true })) {
    showErrorBanner(recorder.error || 'This browser cannot record video.');
    captureClock.release(audioEngine?.nowMs || 0);
    syncRecordUI();
    return false;
  }
  recordReadoutAtMs = 0;
  syncRecordUI();
  return true;
}

function startRecording(presetId = storedExportPresetId()) {
  const recorder = ensureRecorder();
  if (!recorder?.candidate) {
    showErrorBanner('This browser cannot record video.');
    return false;
  }
  if (captureClock.captureReady) return beginRecorder(presetId);
  pendingCapturePresetId = presetId;
  captureClock.arm(audioEngine?.nowMs || 0);
  syncRecordUI();
  return true;
}

/** Stop, save, and say what it turned out to be. Fire-and-forget: nothing
 *  on screen waits for a file to finish writing. */
function finishRecording() {
  const recorder = songRecorder;
  if (pendingCapturePresetId) {
    pendingCapturePresetId = null;
    captureClock.release(audioEngine?.nowMs || 0);
    syncRecordUI();
    return;
  }
  if (!recorder?.recording) return;
  captureClock.release(audioEngine?.nowMs || 0);
  // Finalization may finish after another song has been selected.
  const recordingData = lastTimelineData;
  const recordingName = sessionSongName(recordingData, lastSongName);
  recorder.stop().then((result) => {
    syncRecordUI();
    if (!result) {
      setExportNote('Nothing was captured — the recording was too short to save.', 'isWarning');
      return;
    }
    const fileName = exportFileName({
      songName: recordingName,
      presetId: result.preset?.id,
      ext: result.candidate?.ext || 'mp4',
    });
    downloadBlob(result.blob, fileName);
    setExportNote(
      `Saved ${fileName} — ${describeResult(result)}`,
      result.codec && result.codec !== 'H.264' ? 'isWarning' : 'isResult',
    );
  }).catch((err) => {
    console.error('[export] failed', err);
    showErrorBanner('Could not save the recording: ' + (err?.message || err));
    syncRecordUI();
  });
  syncRecordUI();
}

function abortRecording(message) {
  const active = songRecorder?.recording || pendingCapturePresetId;
  pendingCapturePresetId = null;
  pendingExportPresetId = null;
  songRecorder?.cancel();
  if (!active) return;
  captureClock.release(audioEngine?.nowMs || 0);
  setExportNote(message, 'isWarning');
  syncRecordUI();
}

function downloadBlob(blob, fileName) {
  try {
    if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
    lastExportUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = lastExportUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    console.error('[export] could not offer the download', err);
    showErrorBanner('The video was recorded but could not be saved automatically.');
  }
}

function setExportNote(text, className = '') {
  if (!exportNoteEl) return;
  exportNoteEl.textContent = text;
  exportNoteEl.classList.toggle('isResult', className === 'isResult');
  exportNoteEl.classList.toggle('isWarning', className === 'isWarning');
}

function syncRecordUI() {
  const arming = !!pendingCapturePresetId;
  const active = !!songRecorder?.recording;
  const finalizing = !!songRecorder?.finalizing;
  const busy = active || arming || finalizing;
  recordBtnEl?.setAttribute('aria-pressed', String(active || arming));
  recordBtnEl?.setAttribute('title', active
    ? 'Stop recording and save the video'
    : arming ? 'Cancel recording before capture begins'
    : 'Record the show to a video file from this moment. Press again to stop and save.');
  recordStatusEl?.classList.toggle('hidden', !active && !arming);
  if (arming && recordStatusEl) recordStatusEl.textContent = 'Aligning capture…';
  if (recordBtnEl) recordBtnEl.disabled = finalizing;
  if (exportBtnEl) exportBtnEl.disabled = busy;
}

/** Elapsed time and file size while recording.
 *
 *  Called from the render loop but throttled to twice a second: the readout
 *  is seconds and megabytes, so writing it sixty times a second would be
 *  fifty-nine layout invalidations nobody can read, during the one part of
 *  the app that is already spending every frame it has. */
const RECORD_READOUT_MS = 500;
let recordReadoutAtMs = 0;

function updateRecordReadout(tRaf = 0) {
  if (!recordStatusEl || !songRecorder?.recording) return;
  if (tRaf < recordReadoutAtMs) return;
  recordReadoutAtMs = tRaf + RECORD_READOUT_MS;
  // Size only once there is one. Chromium's MP4 muxer can hold everything
  // until the recording stops rather than emitting per timeslice, and a
  // readout sitting on "0 B" thirty seconds in reads as broken when it is
  // merely early.
  const elapsed = formatElapsed(songRecorder.elapsedMs);
  recordStatusEl.textContent = songRecorder.bytes > 0
    ? `${elapsed} · ${formatBytes(songRecorder.bytes)}`
    : elapsed;
}

/** Fill the preset menu from one source of truth, and say what this browser
 *  will actually produce BEFORE anyone spends a song finding out. */
function syncExportUI() {
  if (!exportPresetEl || !completeExportEl) return;
  if (!exportPresetEl.options.length) {
    for (const preset of RENDER_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = `${preset.label} — ${preset.width}×${preset.height}`;
      option.title = preset.note || '';
      exportPresetEl.appendChild(option);
    }
    exportPresetEl.value = storedExportPresetId();
  }

  const recorder = ensureRecorder();
  const candidate = recorder?.candidate ?? null;
  // A browser that cannot record says so here rather than after a replay.
  if (exportBtnEl) exportBtnEl.disabled = !candidate || !!songRecorder?.recording || !!songRecorder?.finalizing;
  if (recordBtnEl) recordBtnEl.classList.toggle('hidden', !candidate);

  const preset = presetById(exportPresetEl.value);
  const durationMs = conductor?.durationMs || 0;
  const size = estimateBytes({ width: preset.width, height: preset.height, durationMs });
  const parts = [preset.note, reachSummary(candidate)];
  // An upper bound, not a promise: it is computed from the bitrate we ASK
  // for, and an encoder that finds the content easy will undershoot it --
  // measured at roughly half on a sparse test signal. Over-stating is the
  // safe direction; nobody is upset by a smaller file than they were told.
  if (candidate && size > 0) parts.push(`Up to about ${formatBytes(size)} for this song.`);
  if (candidate) parts.push('Recording replays the song in real time.');
  setExportNote(parts.filter(Boolean).join(' '));
}

recordBtnEl?.addEventListener('click', () => {
  if (songRecorder?.recording || pendingCapturePresetId) finishRecording();
  else if (songRecorder?.finalizing) return;
  else startRecording();
});

exportPresetEl?.addEventListener('change', () => {
  rememberExportPresetId(exportPresetEl.value);
  syncExportUI();
});

exportBtnEl?.addEventListener('click', () => {
  if (!lastTimelineData) return;
  const presetId = exportPresetEl?.value || storedExportPresetId();
  rememberExportPresetId(presetId);
  pendingExportPresetId = presetId;
  setExportNote('Recording… the song is replaying in real time. It saves itself when it finishes.');
  // Same seed, so the file is the show that was just watched and not a
  // different roll of the same song.
  replaySong({ songSeed: lastSongSeed });
});

syncRecordUI();

// The title has a presentation owner before there is a song simulation.
if (!window.__SMW) window.__SMW = {
  get presentationDiagnostics() { return titlePresentation?.diagnostics; },
  get displayPrefs() { return { ...displayPrefs }; },
  get rangeRenderer() { return rangePresentation?.mode || rangeMode.mode; },
  get rangeState() { return rangeStateSnapshot(); },
  get rangeTourStatus() { return currentTourControlState(); },
};

// Public Plex endpoint configuration loads independently of local startup.
let plexSource = null;
let plexPanel = null;
let plexSelection = null;
let plexRetry = null;
async function selectPlexTrack(ratingKey) {
  const selection = beginAudioSelection('plex');
  plexSelection = selection;
  plexRetry = null;
  plexPanel.setLoading('Downloading recording…');
  selection.signal.addEventListener('abort', () => {
    if (plexSelection === selection) { plexPanel.setLoading('Load cancelled.', false); plexSelection = null; plexRetry = null; }
  }, { once: true });
  try {
    const result = await plexSource.loadTrack(ratingKey, {
      signal: selection.signal,
      onProgress: ({ receivedBytes, totalBytes }) => {
        if (!audioSelections.isCurrent(selection)) return;
        const amount = totalBytes ? `${Math.round(receivedBytes / totalBytes * 100)}%` : `${(receivedBytes / 1048576).toFixed(1)} MiB`;
        plexPanel.setLoading(`Downloading recording… ${amount}`);
      },
    });
    if (!audioSelections.isCurrent(selection)) return;
    plexPanel.setLoading('Preparing recording…');
    const loaded = await handleFiles([result.file], { selection, sourceMetadata: result.sourceMetadata, onPrepared: () => plexPanel.close() });
    if (loaded === false && audioSelections.isCurrent(selection)) throw new Error('This browser could not decode or prepare the recording. Choose another track, or try again.');
    if (audioSelections.isCurrent(selection)) plexPanel.setLoading('', false);
  } catch (error) {
    if (!audioSelections.isCurrent(selection)) return;
    plexPanel.setLoading(error.message || 'Could not load this recording.', false);
    plexRetry = { selection, ratingKey };
    plexPanel.retry.hidden = false;
    plexPanel.lastAction = () => {
      if (plexRetry?.selection === selection && audioSelections.isCurrent(selection)) selectPlexTrack(ratingKey);
    };
  }
}
async function initializePlex() {
  try {
    const response = await fetch(new URL('./config/plex.json', import.meta.url), { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const config = await response.json();
    if (config.version !== 1 || !config.apiBase || Object.keys(config).some(key => !['version', 'apiBase'].includes(key))) return;
    plexSource = new PlexSource({ apiBase: config.apiBase });
    plexPanel = new PlexLibraryPanel({
      root: document.getElementById('plexLibraryPanel'), source: plexSource,
      onUnlockAudio: unlockAudio, onSelectTrack: selectPlexTrack,
      onCancelLoad: () => {
        if (!plexSelection || !audioSelections.isCurrent(plexSelection)) return;
        audioSelections.cancel(plexSelection);
        if (!running) backToTitle();
      },
    });
    for (const id of ['plexOpenBtn', 'plexMusicBtn', 'plexAuditionBtn']) {
      const button = document.getElementById(id);
      button.classList.remove('hidden');
      button.addEventListener('click', () => plexPanel.open(button));
    }
  } catch { /* Optional service configuration never blocks normal audio. */ }
}
initializePlex();
