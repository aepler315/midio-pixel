// Range v2 presentation boundary (plan §6.2, §7.4). Owns the choice between
// the GPU scene and the legacy painters for each frame, the song's scene
// assignments, the frame snapshot, and the synchronous copy of each GPU
// partition into the authoritative main canvas at its pass boundary. It
// never owns simulation.
//
// Modes: v2 is the default; ?rangeRenderer=legacy opts out (unknown values
// take the default);
// ?rangeView=<id> forces one catalog view for every biome, candidates
// included, and marks the frame forcedCandidate. Any failure -- no WebGL2,
// context loss, 404, bad manifest, decode error, budget denial, stale
// generation -- takes the legacy path for that frame with a recorded
// reason; the cast and music never wait on the GPU.
import { travelSpans } from '../TravelSeam.js';
import { buildRangeFrame, viewportState, scenicProjection } from './RangeFrame.js';
import { scenePoseAt, cameraBasis } from '../terrain/SceneTravel.js';
import { loadTourPackage } from '../terrain/TourPackage.js';
import { prepareTourTimeline } from '../terrain/TourRuntime.js';
import { applyCameraMoves } from './RangeCamera.js';
import { skyTurn, projectRangeCelestials, projectRailCelestials } from './RangeSkyComposition.js';
import { convertLightBetween } from './LightSpace.js';
import { lightDirTo } from '../../render/LightField.js';
import { cyclePhase01, sunScreenFrac } from '../DayNight.js';
import { forcedSceneChoice } from '../terrain/SceneCatalog.js';
import SCENE_CATALOG from '../terrain/sceneCatalogData.js';
import { noteViewShown } from '../terrain/RangeHistory.js';
import { RangeShotTours } from './RangeShotTours.js';
import { headingPitch, lookDir } from '../terrain/ShotPath.js';

export const RANGE_RENDERER_MODES = Object.freeze(['legacy', 'v2']);
export const RANGE_DEFAULT_MODE = 'v2';
const ASSET_BASE = new URL('../../assets/range/v2/', import.meta.url).href;
const RUNTIME_URL = new URL('../../vendor/range/three-range.module.js', import.meta.url).href;
// Downloading the renderer modules can fail on a flaky (mobile) connection.
// Each load tries again after these waits; a retry adds ?retry=N to the
// top module's URL because the browser keeps a failed module URL failed for
// the life of the page. Once every attempt has failed, live playback tries
// the whole load again after RUNTIME_COOLDOWN_MS.
const RUNTIME_RETRY_MS = Object.freeze([2000, 8000]);
const RUNTIME_COOLDOWN_MS = 60000;
const retryUrl = (url, attempt) => (attempt ? `${url}?retry=${attempt}` : url);

/** ?rangeRenderer=v2|legacy and ?rangeView=<id>. Default v2.
 *  ?rangeTour=shots (the default) plays approved views' shot tours,
 *  =off keeps every authored rail, =tetons forces the Teton highway tour;
 *  the choice persists as localStorage 'range-tour'. ?rangeShots=all lets
 *  candidate shot libraries play, for review only. */
export function resolveRangeMode(search = (typeof location !== 'undefined' ? location.search : ''), storage = null) {
  try {
    const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const raw = (q.get('rangeRenderer') || RANGE_DEFAULT_MODE).toLowerCase();
    const forcedViewId = q.get('rangeView') || null;
    const diag = q.get('rangeDiag') === 'markers' ? 'markers' : null;
    let saved = null;
    try { saved = (storage || globalThis.localStorage)?.getItem('range-tour'); } catch { /* Private-mode storage can be unavailable. */ }
    const choice = q.has('rangeTour') ? q.get('rangeTour') : saved;
    const tour = choice === 'tetons' ? 'tetons' : null;
    const shots = !tour && choice !== 'off';
    return { mode: tour ? 'v2' : RANGE_RENDERER_MODES.includes(raw) ? raw : RANGE_DEFAULT_MODE, forcedViewId: tour ? 'teton-range-tour' : forcedViewId, diag, tour,
      shots, shotCandidates: q.get('rangeShots') === 'all' };
  } catch {
    return { mode: RANGE_DEFAULT_MODE, forcedViewId: null, diag: null, tour: null, shots: true, shotCandidates: false };
  }
}

/** Which legacy range layer's travel timing each partition follows. */
const PASS_LAYER = { far: 'L2', mid: 'L4', near: 'L5' };

/** Heard seconds over which a view that finishes preparing after legacy
 *  scenery was already on screen fades in over it, instead of replacing the
 *  painted ranges in one frame. */
export const ARRIVAL_SEC = 1.2;
// A view refused room is tried again after this long (wall clock).
export const BUDGET_RETRY_MS = 1000;
export const ASSET_RETRY_MS = Object.freeze([2000, 8000]);
/** Shared tour-package download retries. Integrity/decode errors stay final. */
export async function retryAssetDownload(load, { signal = null, delaysMs = ASSET_RETRY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error('asset download aborted');
    try { return await load(); }
    catch (error) {
      if (error?.reason !== 'http' || attempt >= delaysMs.length || signal?.aborted) throw error;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('asset download aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delaysMs[attempt]);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

// Feather bands across a view-to-view travel seam (the legacy strips use
// TRAVEL_BANDS = 4; on real terrain four steps read as vertical stripes).
export const V2_TRAVEL_BANDS = 16;

/** Residency key of the travel composition buffer (one stage-sized canvas
 *  the two sides are blended in before the single copy to the stage). */
export const TRAVEL_SCRATCH_KEY = 'range:travel-scratch';

const fade01 = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

function defaultCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export class RangePresentation {
  constructor({ mode = 'legacy', forcedViewId = null, tour = null, shots = true, shotCandidates = false, diag = null, residency = null, budget = 'desktop',
    loadRuntime = (attempt) => import(retryUrl(RUNTIME_URL, attempt)),
    loadScene = (attempt) => import(retryUrl('./RangeScene.js', attempt)),
    retryDelaysMs = RUNTIME_RETRY_MS, cooldownMs = RUNTIME_COOLDOWN_MS, sceneFactory = null, catalog = SCENE_CATALOG, assetBase = ASSET_BASE,
    makeCanvas = defaultCanvas, shotTours = null } = {}) {
    this.mode = mode;
    this.forcedViewId = forcedViewId;
    this.tourMode = tour;
    // Scenic shot tours of the song's approved views; the forced Teton
    // highway tour excludes them.
    this.shots = shotTours || new RangeShotTours({ enabled: shots && !tour, allowCandidates: shotCandidates, assetBase, residency });
    this.cameraTourActive = false;
    this.tour = null;
    this.tourData = null;
    this._tourAbort = null;
    this._tourPreparation = { state: tour ? 'idle' : 'off', generation: 0, reason: null };
    this.diag = diag;
    this.residency = residency;
    this.budget = budget;
    this.catalog = catalog;
    this.assetBase = assetBase;
    this._loadRuntime = loadRuntime;
    this._loadScene = loadScene;
    this._retryDelaysMs = retryDelaysMs;
    this._cooldownMs = cooldownMs;
    this._runtimeRetryAt = null; // ms: a failed download is tried again then
    this._three = null; // the Three.js module, once downloaded
    this.runtimeAttempts = 0;
    this._sceneFactory = sceneFactory;
    this._makeCanvas = makeCanvas;
    this.exportMode = false;
    // Set by the presenting renderer each frame: a Pixel/Palette look.
    this.pixelated = false;
    this.pixelPolicy = null;
    // Travel: the composition buffer and the incoming side's own fade-in
    // (a view that becomes ready after the travel has started).
    this._scratch = null;
    this._scratchBytes = 0;
    this._incomingJoin = null; // { id, tSec } | null
    this.incomingFade = 1;
    this._handoff = null; // { outgoing, incoming } views while a late join fades
    this._waitedFor = null; // incoming view id a travel frame drew without
    this.scene = null;
    this.runtimeState = mode === 'v2' ? 'idle' : 'off'; // idle | loading | ready | failed | off
    this._runtimeEpoch = 0; // see _ensureRuntime
    this.generation = 0;
    this.sceneByBiome = null;
    this.forced = forcedViewId ? forcedSceneChoice(catalog, forcedViewId) : null;
    this.frame = null;
    this.frameInputs = null;
    this.active = false;
    this.reason = mode === 'v2' ? 'not-started' : 'legacy-mode';
    this.failures = new Map(); // viewId -> reason (not retried this generation)
    // A budget refusal is not a failure: the view is retried once room may
    // have been freed (eviction of views no longer on screen), and its
    // biome still counts as covered, so no legacy strips are baked for it.
    this._preparing = new Map();
    this.assetFailures = new Map();
    this._budgetRefusalAt = new Map();
    this.deferred = new Map(); // viewId -> retry-at (ms)
    this._needed = new Set(); // views this frame wanted on screen but lacked
    this._wants = []; // every view this frame wanted (both travel sides)
    this.onBudgetRefusal = null; // (viewId) => void: free fallback scenery
    this.shown = new Set();
    this.frameId = 0;
    // last*: the most recent pass. frame*: every pass of the current frame
    // (scenic partitions and the rock stage, both travel sides), summed.
    this.timings = { lastCopyMs: 0, lastPartitionMs: 0, frameId: 0, frameRenderMs: 0, frameCopyMs: 0 };
    // Arrival fade (ARRIVAL_SEC): 1 = the GPU scene fully replaces legacy.
    this.arrival = 1;
    this._legacyShown = false;
    this._arrivalStartSec = null;
  }

  /** True while the scene is fading in over legacy scenery that is still
   *  drawn underneath it. */
  get arriving() { return this.active && this.arrival < 1; }

  get enabled() { return this.mode === 'v2'; }

  /** 'tetons' forces the highway tour, 'shots' plays shot tours, null keeps
   *  every authored rail. */
  setTourMode(tour, { terrain = null, mgr = null } = {}) {
    this.dispose();
    this.shots.enabled = tour === 'shots';
    tour = tour === 'tetons' ? 'tetons' : null;
    this.tourMode = tour;
    this.forcedViewId = tour ? 'teton-range-tour' : null;
    this.forced = tour ? forcedSceneChoice(this.catalog, this.forcedViewId) : null;
    this.setSong({ terrain, mgr, generation: this.generation + 1 });
  }

  /** A new song (or world): new generation, new assignments. Pending work
   *  of the previous generation is cancelled; its late results never land. */
  setSong({ terrain = null, mgr = null, generation = this.generation + 1, exportMode = false, cameraContinuation = null } = {}) {
    // Replays may reuse the load generation, but every reset supersedes
    // readiness loops that were preparing the previous song's views.
    this._readinessOwner = {};
    this.stage = null;
    this.active = false;
    this.frame = null;
    this.viewId = null;
    this.incomingViewId = null;
    // A new song does not repair a failed renderer. Keep its useful error
    // until the runtime itself retries or is recreated by a mode change.
    if (this.runtimeState !== 'failed') this.reason = this.enabled ? 'not-started' : 'legacy-mode';
    if (this.tourMode || this.residency?.cancelled?.has(generation)) generation = Math.max(generation, this.generation + 1);
    const previous = this.generation;
    if (this._tourCpuKey) this.residency?.release(this._tourCpuKey);
    if (this.tourMode) this.scene?.release('teton-range-tour');
    this.generation = generation;
    this._tourAbort?.abort();
    this._tourPromise = null;
    this.tour = null;
    this.tourData = null;
    this._tourSections = mgr?.sections;
    this._tourPreparation = { state: this.tourMode ? 'idle' : 'off', generation, reason: null };
    this._replanAbort?.abort();
    // Export draws frames on request and waits for readiness: never fades,
    // never counts as the listener having seen a view.
    this.exportMode = !!exportMode;
    this._incomingJoin = null;
    this.incomingFade = 1;
    this._handoff = null;
    this._waitedFor = null;
    this.sceneByBiome = terrain?.sceneByBiome || null;
    this.failures.clear();
    this.deferred.clear();
    this.assetFailures.clear();
    this._preparing.clear();
    this._budgetRefusalAt.clear();
    this._needed.clear();
    this._wants = [];
    this.shown.clear();
    this.arrival = 1;
    this._legacyShown = false;
    this._arrivalStartSec = null;
    // A saved/title preference has no song to plan yet. Other worlds keep
    // the preference, but must not spend memory on a camera they never draw.
    const ownsTour = this.tourMode && mgr?.durationMs > 0 && (!mgr.world?.kind || mgr.world.kind === 'alpine');
    if (ownsTour && !this.forced?.view?.tourManifestUrl) {
      const reason = this.forced?.fallbackReason || 'Teton tour files are not available in this version';
      this._tourPreparation = { ...this._tourPreparation, state: 'failed', reason };
      this.failures.set(this.forcedViewId || 'teton-range-tour', reason);
    }
    if (ownsTour && this.forced?.view?.tourManifestUrl) {
      const view = this.forced.view, controller = new AbortController();
      this._tourAbort = controller;
      this._tourPreparation = { ...this._tourPreparation, state: 'loading' };
      this._tourCpuKey = `range:tour-cpu:${generation}`;
      const reservation = this.residency?.reserve({ key: this._tourCpuKey, bytes: 80 * 1024 ** 2, owner: 'range-tour-cpu', generation });
      const load = this.residency && !reservation ? Promise.reject(new Error('No room to plan the tour')) : retryAssetDownload(() => loadTourPackage(new URL(view.tourManifestUrl, this.assetBase).href,
        { signal: controller.signal, expectManifestSha256: view.tourManifestSha256, terrainViewId: view.id }), { signal: controller.signal })
      ;
      this._tourPromise = load
        .then(async pkg => {
          if (controller.signal.aborted || this.generation !== generation) return;
          this._tourPreparation = { ...this._tourPreparation, state: 'planning' };
          const tour = await prepareTourTimeline(pkg.data, mgr, { signal: controller.signal });
          if (controller.signal.aborted || this.generation !== generation) return;
          if (reservation) {
            if (!this.residency.commit(reservation, { data: pkg.data, tour })) throw new Error('Tour planning memory reservation is no longer available');
            this.residency.shrink(reservation.key, 32 * 1024 ** 2);
          }
          this.tour = tour; this.tourData = pkg.data;
          this._tourPreparation = { ...this._tourPreparation, state: 'ready' };
          this.forced = { ...this.forced, view: { ...view, tour } };
          this.scene?.release(view.id);
        }).catch(error => {
          if (controller.signal.aborted || this.generation !== generation) return;
          if (reservation) this.residency?.releaseReservation(reservation);
          const reason = `tour: ${error.message}`;
          this._tourPreparation = { ...this._tourPreparation, state: 'failed', reason };
          this.failures.set(view.id, reason);
          this._availabilityChanged();
          console.warn('[range tour] preparation failed', error);
        });
    }
    // Shot tours: libraries and per-song plans for the views this song may
    // show. A rebuild of the same song in place carries its committed camera.
    this.cameraTourActive = false;
    this.shots.setSong({ mgr, views: this._songViews(), choiceFor: (biome) => this._choiceFor(biome),
      generation, exportMode: this.exportMode, continuation: cameraContinuation });
    // Views the new song still wants move to its generation before the old
    // one is cancelled; everything else of the old song is released.
    const keep = new Set(this._wantedViewIds());
    if (this.scene) {
      for (const [id, p] of [...this.scene.prepared]) {
        if (keep.has(id) && !p.view?.tour) {
          p.generation = generation;
          this.residency?.retag(p.gpuKey, generation);
          this.residency?.retag(p.cpuKey, generation);
        } else this.scene.release(id);
      }
    }
    if (this.residency && previous && previous !== generation) this.residency.cancelGeneration(previous);
  }

  _choiceFor(biome) {
    if (this.forced) return this.forced;
    return this.sceneByBiome?.get?.(biome) || null;
  }

  /** The view a biome's caption should name, when v2 will draw it. */
  captionViewFor(biome) {
    if (!this.enabled || this.runtimeState === 'failed') return null;
    const v = this._choiceFor(biome)?.view;
    return v && !this.failures.has(v.id) ? v : null;
  }

  /** Whether v2 is expected to draw this biome's scenery, so the legacy
   *  strip set for it is only a fallback and need not be baked ahead. */
  coversBiome(biome) {
    return !!this.captionViewFor(biome);
  }

  _wantedViewIds() {
    if (this.forced?.view) return [this.forced.view.id];
    return [...(this.sceneByBiome?.values?.() || [])].map((c) => c?.view?.id).filter(Boolean);
  }

  /** Load the GPU runtime. Each load belongs to a runtime epoch (distinct
   *  from the song generation); dispose() starts a new one, so a load that
   *  settles after its presentation was disposed or reloaded never
   *  publishes: a late scene is disposed exactly once and a late failure is
   *  ignored. */
  async _ensureRuntime() {
    if (this.runtimeState !== 'idle') return;
    const epoch = ++this._runtimeEpoch;
    const current = () => epoch === this._runtimeEpoch;
    const recovering = this._runtimeRetryAt != null;
    this.runtimeState = 'loading';
    this._runtimeRetryAt = null;
    let downloaded = false;
    let scene;
    try {
      if (this._sceneFactory) scene = await this._sceneFactory();
      else {
        const [THREE, { RangeScene }] = await this._downloadRuntime();
        downloaded = true;
        if (!current()) return;
        scene = new RangeScene({ THREE, residency: this.residency, budget: this.budget, diag: this.diag });
      }
    } catch (err) {
      if (!current()) return;
      this.runtimeState = 'failed';
      this.reason = `runtime-unavailable: ${err?.message || err}`;
      // Only a failed download is worth another try; a renderer that could
      // not start (no WebGL2) would fail the same way again.
      if (!this._sceneFactory && !downloaded) this._runtimeRetryAt = Date.now() + this._cooldownMs;
      this._availabilityChanged();
      console.warn('[range v2] renderer unavailable; legacy Range continues', err);
      return;
    }
    if (!current()) {
      if (scene && scene !== this.scene) {
        try { scene.dispose?.(); } catch (err) { console.warn('[range v2] stale runtime dispose failed', err); }
      }
      return;
    }
    this.scene = scene;
    this.runtimeState = 'ready';
    if (recovering) this._availabilityChanged();
  }

  /** The Three.js bundle and the RangeScene module, each download tried
   *  again after the RUNTIME_RETRY_MS waits before the load gives up. A
   *  module that already arrived is kept, never fetched a second time. */
  async _downloadRuntime() {
    for (let i = 0; ; i++) {
      const attempt = this.runtimeAttempts++;
      try {
        this._three ||= await this._loadRuntime(attempt);
        return [this._three, await this._loadScene(attempt)];
      } catch (err) {
        if (i >= this._retryDelaysMs.length) throw err;
        console.warn(`[range v2] renderer download failed (attempt ${attempt + 1}); retrying`, err);
        await new Promise((r) => setTimeout(r, this._retryDelaysMs[i]));
      }
    }
  }

  _prepare(view, now = Date.now()) {
    if (view.tourManifestUrl && !this.tour) return;
    if (view.tourManifestUrl) view = { ...view, tour: this.tour };
    if (!this.scene || this.scene.contextLost || this.failures.has(view.id) || this.scene.isReady(view.id) || this._preparing.has(view.id)) return;
    // A shot-tour view is prepared for its library's camera footprint, so
    // it waits (briefly) for the library; without one it keeps its rail.
    view = this.shots.prepareView(view);
    if (!view) return;
    const retryAt = this.deferred.get(view.id);
    if (retryAt != null && now < retryAt) return;
    this.deferred.delete(view.id);
    const gen = this.generation, preparation = {};
    this._preparing.set(view.id, preparation);
    this.scene.prepare(view, { generation: gen, baseUrl: this.assetBase, scenicViewport: this.frameInputs?.scenicViewport,
      pixelated: !!this.pixelated,
      pixelHeightPx: this.pixelPolicy?.grid?.height ?? null,
      tourData: this.tourData, tourCpuKey: this._tourCpuKey, isCurrent: (g) => g === this.generation })
      .then(() => { if (gen === this.generation) this.assetFailures.delete(view.id); })
      .catch((err) => {
        if (gen !== this.generation) return; // stale: the new song decides again
        const settledAt = Date.now();
        if (err?.reason === 'context-lost') {
          // Context availability gates preparation. A restored context can
          // retry immediately; it must not inherit the budget cooldown.
          this.deferred.set(view.id, settledAt);
          return;
        }
        if (err?.reason === 'http') {
          const failures = (this.assetFailures.get(view.id) || 0) + 1;
          this.assetFailures.set(view.id, failures);
          if (failures <= ASSET_RETRY_MS.length) {
            this.deferred.set(view.id, settledAt + ASSET_RETRY_MS[failures - 1]);
            return;
          }
        }
        if (err?.reason === 'budget') {
          // No room right now (other views still pending or pinned): try
          // again shortly instead of dropping the biome to legacy for good,
          // and let the owner free fallback scenery the retry can use.
          this.deferred.set(view.id, Date.now() + BUDGET_RETRY_MS);
          this._budgetRefused(view.id, settledAt);
          return;
        }
        const reason = err?.reason ? `${err.reason}: ${err.message}` : String(err?.message || err);
        this.failures.set(view.id, reason);
        console.warn(`[range v2] ${view.id} unavailable; legacy Range for its sections`, err);
        this._availabilityChanged();
      }).finally(() => {
        if (this._preparing.get(view.id) === preparation) this._preparing.delete(view.id);
      });
  }

  _budgetRefused(viewId, now = Date.now()) {
    if (now < (this._budgetRefusalAt.get(viewId) ?? -Infinity) + BUDGET_RETRY_MS) return;
    this._budgetRefusalAt.set(viewId, now);
    try { this.onBudgetRefusal?.(viewId, { preserveVisible: true }); }
    catch (err) { console.warn('[range v2] budget reclaim failed', err); }
  }

  /** A view (or the renderer) became unavailable: whoever named scenic
   *  views in captions rebuilds them, so a legacy fallback is never
   *  credited as the scenic location. */
  _availabilityChanged() {
    try { this.onAvailabilityChange?.(); } catch (err) { console.warn('[range v2] caption refresh failed', err); }
  }

  /** Prepares the song's views one at a time in song order, keeping those
   *  already prepared resident, until one no longer fits the budget: the
   *  opening view is always attempted first, and later views are prepared
   *  as their sections approach (live) or by settle() (export). Resolves
   *  with the snapshot (evidence/export use this; live playback never
   *  waits on it). Preparing every view at once let later biomes' pending
   *  reservations crowd out the view actually on screen. */
  async whenReady({ timeoutMs = 60000, signal = null } = {}) {
    const owner = this._readinessOwner;
    const check = () => {
      if (signal?.aborted || this._readinessOwner !== owner)
        throw Object.assign(new Error('Landscape readiness superseded'), { name: 'AbortError' });
    };
    check();
    if (!this.enabled) return this.snapshot();
    // The saved preference is idle on the title and in other worlds.
    // Export calls readiness for every world; there is no tour job to await.
    if (this.tourMode && this._tourPreparation.state === 'idle') return this.snapshot();
    if (this.runtimeState === 'idle') { await this._ensureRuntime(); check(); }
    else while (this.runtimeState === 'loading') {
      await new Promise((r) => setTimeout(r, 20));
      check();
    }
    if (this.runtimeState !== 'ready' || this.scene.contextLost) return this.snapshot();
    if (this.tourMode) { await this._tourPromise; check(); }
    const unique = this._songViews();
    const deadline = Date.now() + timeoutMs;
    const ready = [];
    for (const v of unique) {
      check();
      if (Date.now() >= deadline || this.scene.contextLost) break;
      this._prepare(v);
      while (Date.now() < deadline && !this.scene.contextLost && !(this.scene.isReady(v.id) && this.shots.settled(v.id)) && !this.failures.has(v.id)
        && (!this.deferred.has(v.id) || this.deferred.get(v.id) <= Date.now())) {
        await new Promise((r) => setTimeout(r, 25));
        check();
        // A preparation can retire just after a context restores. Retry
        // due work once its old job settles; HTTP/budget backoff stays put.
        this._prepare(v);
      }
      if (this.scene.contextLost || this.deferred.has(v.id)) {
        // Unavailable: this and later views prepare on demand, not now.
        break;
      }
      if (this.scene.isReady(v.id)) ready.push(v.id);
      // Keep what is prepared while the next view reserves its room.
      this.scene.pinView?.(ready);
    }
    check();
    this.residency?.pin?.([]);
    return this.snapshot();
  }

  /** The song's views in song order (the biome order), each once. */
  _songViews() {
    const views = this.forced?.view ? [this.forced.view]
      : [...(this.sceneByBiome?.values?.() || [])].map((c) => c?.view).filter(Boolean);
    return [...new Map(views.map((v) => [v.id, v])).values()];
  }

  /**
   * Export: after a frame, wait for the views that frame wanted on screen
   * but lacked (still preparing, or refused room while others were
   * pending), retrying a refusal now that the frame's own views are the
   * only ones pinned. Resolves true when it waited -- the caller then
   * redraws the same heard time, which is deterministic -- false when the
   * frame already had everything it needed.
   */
  async settle({ timeoutMs = 120000, attempts = 3 } = {}) {
    const windows = [...(this.scene?.prepared?.values() || [])].map(p => {
      const cache = p.windowCache;
      // Export settling is an explicit bounded attempt. Playback's admission
      // cooldown must not make a fixed-clock export accept an unsettled mesh.
      if (cache?.retryAt?.has(cache.current)) return cache.request(cache.current, { replace: true, retryNow: true });
      return cache?.pending.get(cache.current);
    }).filter(Boolean);
    const terrainWaited = windows.length > 0;
    if (terrainWaited) {
      let timer;
      try {
        await Promise.race([Promise.allSettled(windows), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Terrain window settling timed out')), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    }
    const lacking = this._needed.size > 0;
    this._needed.clear();
    // The aurora echoes a skyline read back from the frame's own land; one
    // that arrived only after the sky was drawn needs the instant redrawn.
    const sky = !!this.frameInputs?.sim?.biomes?.takeSkylineUnsettled?.();
    // Every view the frame wanted, not only the missing ones: preparing a
    // missing side must not evict the side that was already there (a frame
    // that drew no GPU scene pinned nothing).
    const views = this._wants;
    // A lost context cannot make progress: nothing is ready until it is
    // restored, and waiting would only run out the timeout.
    if (!lacking || !views.length || !this.scene || this.scene.contextLost) return sky || terrainWaited;
    const deadline = Date.now() + timeoutMs;
    const tries = new Map();
    let waited = false;
    while (Date.now() < deadline) {
      this.scene.pinView?.(views.filter((v) => this.scene.isReady(v.id)).map((v) => v.id));
      const open = views.filter((v) => !this.scene.isReady(v.id) && !this.failures.has(v.id));
      // A view still being built is always waited for; only one refused
      // room `attempts` times gives up (the frame draws without it).
      const givenUp = (v) => this.deferred.has(v.id) && (tries.get(v.id) || 0) >= attempts;
      if (!open.length || open.every(givenUp)) break;
      waited = true;
      for (const v of open) {
        if (givenUp(v)) continue;
        if (this.deferred.has(v.id)) {
          tries.set(v.id, (tries.get(v.id) || 0) + 1);
          this.deferred.delete(v.id);
        }
        this._prepare(v);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return waited || sky || terrainWaited;
  }

  /** Renderer: this frame's inputs, before BiomeManager.draw. */
  setFrameInputs({ sim, pose, scenicViewport, groundViewport }) {
    this.frameInputs = { sim, pose, scenicViewport, groundViewport };
  }

  /**
   * BiomeManager (alpine path), once light and air are resolved: decide
   * whether the GPU scene draws the scenic partitions this frame.
   */
  beginScenic() {
    const ok = this._beginScenic();
    // A legacy frame draws no view: release the previous frame's pins so a
    // destination (or a legacy strip fallback) may evict what is no longer
    // on screen.
    if (!ok) {
      this.residency?.pin?.([]);
      this.scene?.releaseSide?.('B');
      this._releaseScratch();
      this._handoff = null;
    }
    this._updateArrival(ok);
    // A departure toward legacy scenery fades the scene out over the blend
    // (pure in the blend's heard-time progress, exports included).
    if (ok) this.arrival = Math.min(this.arrival, this._departure ?? 1);
    return ok;
  }

  /**
   * Legacy -> GPU scene handoff mid-song (a view that finished preparing
   * after the opening, or a section after a legacy one): fade in over
   * ARRIVAL_SEC of heard time. Pure in heard time within one arrival --
   * pause holds it, a seek before its start completes it -- and an export
   * (which waits for readiness) never fades.
   */
  _updateArrival(ok) {
    const sim = this.frameInputs?.sim;
    const tSec = Number(sim?.biomes?.tSec);
    // Landscape waits for the actual renderer instead of showing legacy
    // loading scenery. No heard-time fade may hold the first ready frame
    // transparent while the transport is still waiting at time zero.
    if (this.enabled && sim?.biomes?.world?.kind === 'alpine') {
      this.arrival = 1;
      this._legacyShown = false;
      this._arrivalStartSec = null;
      return;
    }
    if (!ok) {
      this.arrival = 1;
      this._arrivalStartSec = null;
      // Only a frame that drew legacy scenery for an enabled v2 counts.
      if (this.enabled && sim?.biomes) this._legacyShown = true;
      return;
    }
    if (this.exportMode || sim?.exportMode || !Number.isFinite(tSec)) {
      this.arrival = 1;
      this._legacyShown = false;
      this._arrivalStartSec = null;
      return;
    }
    if (this._legacyShown) {
      this._legacyShown = false;
      this._arrivalStartSec = tSec;
    }
    if (this._arrivalStartSec == null) { this.arrival = 1; return; }
    const u = (tSec - this._arrivalStartSec) / ARRIVAL_SEC;
    if (u < 0 || u >= 1) {
      this.arrival = 1;
      this._arrivalStartSec = null;
      return;
    }
    this.arrival = u * u * (3 - 2 * u);
  }

  _beginScenic() {
    this.stage = null;
    this.active = false;
    this.incomingViewId = null;
    this.frame = null;
    if (!this.enabled) { this.reason = 'legacy-mode'; return false; }
    if (this.runtimeState === 'failed' && this._runtimeRetryAt != null && Date.now() >= this._runtimeRetryAt) this.runtimeState = 'idle';
    if (this.runtimeState === 'idle') this._ensureRuntime();
    if (this.runtimeState !== 'ready') { this.reason = this.runtimeState === 'failed' ? this.reason : 'runtime-loading'; return false; }
    const inputs = this.frameInputs;
    if (!inputs?.sim?.biomes) { this.reason = 'no-frame-inputs'; return false; }
    const mgr = inputs.sim.biomes;
    // Replan the uncommitted tail when the song's sections change. The newest
    // request wins: an older worker is aborted, so its late reply never lands.
    this.shots.refine(mgr);
    if (this.tourMode && this.tour && mgr.sections !== this._tourSections) {
      this._tourSections = mgr.sections;
      this._replanAbort?.abort();
      const controller = new AbortController(), generation = this.generation;
      this._replanAbort = controller;
      const previousNotes = new Map();
      for (const note of this.tour.notes || []) previousNotes.set(note, (previousNotes.get(note) || 0) + 1);
      this._tourPreparation = { ...this._tourPreparation, replanning: true, refinement: { state: 'pending', reason: null } };
      this._replanPromise = prepareTourTimeline(this.tourData, mgr, { signal: controller.signal, previous: this.tour, committedThroughMs: (mgr.tSec || 0) * 1000 })
        .then(tour => {
          if (controller.signal.aborted || generation !== this.generation) return;
          // A worker freezes only a short prefix beyond its request time.
          // Playback can pass that prefix while the job is still running.
          // Admit the result against the camera being heard NOW, so a late
          // refinement cannot teleport the listener onto a different route.
          const nowMs = (mgr.tSec || 0) * 1000;
          const before = this.tour.poseAt(nowMs), after = tour.poseAt(nowMs);
          const continuous = ['eyeM', 'targetM'].every(key =>
            before[key].every((value, i) => Math.abs(value - after[key][i]) < .1))
            && Math.abs(before.fovYDeg - after.fovYDeg) < .01;
          if (!continuous) {
            this._tourSections = null; // retry from the current committed pose
            this._tourPreparation = { ...this._tourPreparation, replanning: false,
              refinement: { state: 'held', reason: 'Refinement arrived beyond its committed camera; continuing the current flight.' } };
            return;
          }
          this.tour = tour;
          // The worker can safely retain the previous flight when no
          // continuation exists. Only a newly reported deferral describes
          // this job; historical notes must not mark a later success held.
          let deferredReason = null;
          for (const note of tour.notes || []) {
            const count = previousNotes.get(note) || 0;
            if (count) previousNotes.set(note, count - 1);
            else if (/^Refinement (deferred|held):/.test(note)) deferredReason = note;
          }
          this._tourPreparation = { ...this._tourPreparation, replanning: false,
            refinement: { state: deferredReason ? 'held' : 'applied', reason: deferredReason } };
          this.forced = { ...this.forced, view: { ...this.forced.view, tour } };
          this.scene.replaceTour?.(this.forced.view);
        }).catch(error => {
          if (controller.signal.aborted || generation !== this.generation) return;
          this._tourPreparation = { ...this._tourPreparation, replanning: false, refinement: { state: 'held', reason: error.message } };
          this.tour.notes.push(`Refinement held: ${error.message}`);
        });
    }
    const blend = mgr.currentBlend || {};
    const name = (p) => (typeof p === 'string' ? p : p?.name ?? null);
    const from = this._choiceFor(name(blend.from) ?? mgr.sections?.[0]?.profile?.name);
    const to = this._choiceFor(name(blend.to) ?? name(blend.from));
    const now = Date.now();
    const wanted = [...new Map([from, to].map((c) => c?.view).filter(Boolean).map((v) => [v.id, v])).values()];
    // Reservations below must be able to evict a completed section's view.
    // Otherwise an unready replacement returns before pinView below, leaving
    // the previous frame's pins through every budget retry. Keep both travel
    // sides, including an outgoing side still finishing its late-join fade.
    const hold = this._handoff, join = this._incomingJoin, tNow = Number(mgr.tSec);
    const fading = !!join && join.id === hold?.incoming.id && tNow >= join.tSec && tNow - join.tSec < ARRIVAL_SEC;
    const retained = fading && wanted.some(v => v.id === hold.incoming.id) ? [hold.outgoing.id] : [];
    this.scene.pinView?.([...wanted.map(v => v.id), ...retained], [TRAVEL_SCRATCH_KEY]);
    for (const v of wanted) this._prepare(v, now);
    // What this frame would draw but cannot yet (export settles these).
    this._wants = wanted;
    this._needed = new Set(wanted.filter((v) => !this.failures.has(v.id) && !this.scene.isReady(v.id)).map((v) => v.id));
    if (!from?.view) { this.reason = from?.fallbackReason || 'no-view-assigned'; return false; }
    // A destination without a view (partial catalog coverage) is legacy
    // scenery: the blend toward it, and the section after it, draw legacy.
    const t = blend.t ?? 1;
    const blending = t > 0 && t < 1 && to !== from;
    // Leaving for a destination without a view (partial catalog coverage):
    // the outgoing view keeps drawing over the legacy stack and fades out
    // across the blend, instead of cutting to legacy on its first frame.
    this._departure = 1;
    let departing = false;
    if (blending && !to?.view) {
      departing = true;
      this._departure = 1 - t * t * (3 - 2 * t);
    }
    if (t >= 1 && !to?.view) { this.reason = to?.fallbackReason || 'no-view-assigned'; return false; }
    // The late-join marker belongs to one travel: forget it once that travel
    // is over (or another has begun), unless a held handoff still runs.
    const travellingTo = blending && to?.view && to.view.id !== from.view.id ? to.view.id : null;
    if (this._waitedFor && this._waitedFor !== travellingTo && !this._handoff) this._waitedFor = null;
    // View-to-view travel: the outgoing view stays valid for the whole
    // blend and the incoming one joins through the travel seam once it is
    // prepared -- a cancelled, failed or still-loading incoming view simply
    // leaves the outgoing one drawing, never a legacy flash.
    let view, incoming = null;
    if (departing) {
      view = from.view;
    } else if (blending && to.view.id !== from.view.id) {
      view = from.view;
      if (!this.failures.has(to.view.id) && this.scene.isReady(to.view.id) && this.shots.settled(to.view.id)) incoming = to.view;
      // A frame of this travel drew the outgoing view alone: when the
      // incoming one does join, it joins late and fades in.
      else this._waitedFor = to.view.id;
    } else {
      view = t >= 1 ? to.view : from.view;
    }
    // A view that joined late and is still fading in when the travel ends
    // keeps the A/B handoff (seam fully across, B at its fade) until the fade
    // completes, instead of replacing A in one frame.
    let holding = false;
    if (!incoming && hold && fading && view.id === hold.incoming.id && hold.outgoing.id !== view.id
      && !this.failures.has(hold.outgoing.id) && this.scene.isReady(hold.outgoing.id)) {
      incoming = view;
      view = hold.outgoing;
      holding = true;
    }
    if (this.failures.has(view.id)) { this.reason = this.failures.get(view.id); return false; }
    if (!this.scene.isReady(view.id)) { this.reason = this.scene.contextLost ? 'context-lost' : 'preparing'; return false; }
    // A view's camera never switches from rail to tour mid-song: it is not
    // drawn until its plan has settled (ready, or fallen back to the rail).
    if (!this.shots.settled(view.id)) { this.reason = 'preparing: camera tour planning'; return false; }
    this.scene.setCameraTour?.(view.id, this.shots.timeline(view.id));
    if (incoming) this.scene.setCameraTour?.(incoming.id, this.shots.timeline(incoming.id));
    this.cameraTourActive = !!this.shots.timeline(view.id);
    // What this frame draws stays resident (never evicted mid-use) -- pinned
    // before any reservation below, which may evict unpinned entries.
    const vp = inputs.scenicViewport;
    this.scene.pinView?.(incoming ? [view.id, incoming.id] : view.id, [TRAVEL_SCRATCH_KEY]);
    try {
      // Quality rung and look decide the target's multisampling
      // (RangeRenderPolicy); Pixel/Palette never smooth their grid.
      this.scene.resize({ widthPx: vp.backingWidth, heightPx: vp.backingHeight, pixelRatio: vp.pixelRatio || 1,
        quality: inputs.sim.perf?.level ?? 0, pixelated: !!this.pixelated, pixelScale: 'original',
        pixelHeightPx: this.pixelPolicy?.grid?.height ?? null });
    } catch (err) {
      this.reason = `budget: ${err.message}`;
      // The render target was refused room: let the owner free fallback
      // scenery (legacy strips for covered biomes) before the next frame.
      this._budgetRefused(view.id);
      return false;
    }
    // The incoming side needs its own target and a composition buffer,
    // reserved before they exist; without room the outgoing view carries on
    // alone.
    if (incoming && !(this.scene.ensureSide?.('B') && this._ensureScratch(vp))) {
      // A frame drew the outgoing view alone: if room appears later in this
      // travel, the incoming view joins late and fades in.
      this._waitedFor = incoming.id;
      incoming = null;
    }
    if (!incoming) {
      this.scene.releaseSide?.('B');
      this._releaseScratch();
    }
    this.incomingViewId = incoming?.id ?? null;
    this.seamP = holding ? 1 : blend.travel ? (blend.travelP ?? t) : t;
    this._updateIncomingFade(incoming, inputs.sim);
    this._handoff = incoming && this.incomingFade < 1 ? { outgoing: view, incoming } : null;
    this.scene.pinView?.(incoming ? [view.id, incoming.id] : view.id, incoming ? [TRAVEL_SCRATCH_KEY] : []);
    this.timings.frameId = this.frameId + 1;
    this.timings.frameRenderMs = 0;
    this.timings.frameCopyMs = 0;
    this.scene.skyClouds = null;
    this.frame = buildRangeFrame({
      frameId: ++this.frameId, generation: this.generation, sim: inputs.sim, pose: inputs.pose,
      scenicViewport: inputs.scenicViewport, groundViewport: inputs.groundViewport,
      sceneAssignments: this.sceneByBiome, forcedView: this.forced, renderedViews: [view, incoming].filter(Boolean),
    });
    if (this.scene.prepareFrameCoverage?.(view, this.frame) === false) {
      this.reason = 'budget: tour terrain coverage is preparing';
      this._budgetRefused(view.id);
      return false;
    }
    this.skyPan = this._skyPan(view, incoming, this.frame);
    if ((this.skyPan.tourPose || this.skyPan.skyCamera) && mgr.celestialState) {
      const solar = sunScreenFrac(cyclePhase01(this.frame.timeMs, mgr._dayNightCycleMs));
      const state = this.skyPan.tourPose
        ? projectRangeCelestials(mgr.celestialState, this.skyPan.tourPose, this.frame.cameraEffects.halfAngleScale, solar, this.skyPan.celestialOffsetDeg ?? 0)
        : projectRailCelestials(mgr.celestialState, this.skyPan.skyCamera, solar);
      mgr.celestialState = state;
      const active = state[state.activeBody];
      if (active && mgr._scenicLight) {
        const x = active.xFrac * inputs.scenicViewport.logicalWidth;
        const y = active.yFrac * inputs.scenicViewport.logicalHeight;
        const dir = lightDirTo({ x, y }, inputs.scenicViewport.logicalWidth / 2, inputs.scenicViewport.logicalHeight);
        mgr._scenicLight = { ...mgr._scenicLight, x, y, dirX: dir.x, dirY: dir.y };
        mgr._groundLight = convertLightBetween(mgr._scenicLight, inputs.scenicViewport.transform, inputs.groundViewport.transform);
        this.frame = Object.freeze({ ...this.frame, light: Object.freeze({ ...this.frame.light, state,
          celestial: Object.freeze({ ...active, body: state.activeBody, intensity: this.frame.light.celestial.intensity }),
          ground: Object.freeze({ ...mgr._groundLight }) }) });
      }
    }
    this.scene.prepareShafts?.(this.frame, incoming ? [view.id, incoming.id] : [view.id]);
    this.scene.skyPan = this.skyPan; // rain curtains and lightning stand where the sky draws them
    this.viewId = view.id;
    this.active = true;
    this.reason = null;
    if (!this.shown.has(view.id) && !this.forced && !this.exportMode && !inputs.sim.exportMode) {
      this.shown.add(view.id);
      noteViewShown(view);
    }
    return true;
  }

  /** How far the camera's section move has swung and tilted the sky, in
   *  NDC of the rendered lens ({x, y}): the sky's clouds turn with the land
   *  instead of holding still on the screen. Each view's own rail is the
   *  reference; the moved pose is the scene's own (ground clearance
   *  included, RangeScene.movedPose). During a travel the turn and lens
   *  blend as the incoming view shows (seam and late-join fade), so a
   *  handoff between views never jumps the clouds. */
  _skyPan(view, incoming, frame) {
    const still = { x: 0, y: 0 };
    if (!frame?.cameraMove || !frame.scenicViewport) return still;
    const vp = frame.scenicViewport;
    const one = (v) => {
      let rail, proj, pose;
      if (typeof this.scene.movedPose === 'function') ({ rail, proj, pose } = this.scene.movedPose(v, frame));
      else {
        rail = scenePoseAt(v, { progress01: v.glacier ? (frame.glacier?.journey01 ?? frame.progress01) : frame.progress01, timeMs: frame.timeMs });
        proj = scenicProjection(rail.fovYDeg, vp);
        pose = applyCameraMoves(rail, frame.cameraMove, null);
      }
      if (v.tour) return { tourPose: { ...pose, fovYDeg: proj.fovYDeg, aspect: proj.aspect } };
      // A shot tour turns anywhere: its sky and light are world-fixed, with
      // the sun and moon arcs anchored to the view's own rail heading (the
      // highway tour's arcs assume a north-east flight, 45 degrees).
      if (this.shots.timeline(v.id)) {
        const railHeading = headingPitch(lookDir(scenePoseAt(v, { progress01: .5 }))).headingDeg;
        return { tourPose: { ...pose, fovYDeg: proj.fovYDeg, aspect: proj.aspect }, celestialOffsetDeg: railHeading - 45 };
      }
      const turn = skyTurn(pose, cameraBasis(rail).forward);
      const referenceFov = Math.atan(Math.tan(proj.fovYDeg * Math.PI / 360) / (frame.cameraEffects?.halfAngleScale || 1)) * 360 / Math.PI;
      const skyCamera = { referencePose: { ...rail, fovYDeg: referenceFov }, pose: { ...pose, fovYDeg: proj.fovYDeg }, aspect: proj.aspect };
      return { ...turn, skyCamera, tanY: Math.tan((proj.fovYDeg * Math.PI) / 360) / (frame.cameraEffects?.halfAngleScale || 1), aspect: proj.aspect };
    };
    try {
      const a = one(view);
      const b = incoming ? one(incoming) : a;
      const k = incoming ? Math.min(1, Math.max(0, (this.seamP ?? 0) * (this.incomingFade ?? 1))) : 0;
      // World-fixed and rail-relative skies cannot be blended: a travel that
      // involves a tour hands the sky over at the seam's midpoint.
      if (a.tourPose || b.tourPose) {
        const side = k >= .5 ? b : a;
        if (side.tourPose) return { x: 0, y: 0, tourPose: side.tourPose, ...(side.celestialOffsetDeg != null ? { celestialOffsetDeg: side.celestialOffsetDeg } : {}) };
        if (!(side.tanY > 0 && side.aspect > 0)) return still;
        return { x: side.x / (side.tanY * side.aspect), y: side.y / side.tanY, skyCamera: Object.freeze({ from: side.skyCamera, to: side.skyCamera, mix: 0 }) };
      }
      const mix = (key) => a[key] + (b[key] - a[key]) * k;
      const tanY = mix('tanY'), aspect = mix('aspect');
      if (!(tanY > 0 && aspect > 0)) return still;
      return { x: mix('x') / (tanY * aspect), y: mix('y') / tanY, skyCamera: Object.freeze({ from: a.skyCamera, to: k === 0 ? a.skyCamera : b.skyCamera, mix: k }) };
    } catch { return still; }
  }

  /**
   * An incoming view that joins a travel already under way (it finished
   * preparing late) fades in over ARRIVAL_SEC of heard time instead of
   * appearing at the current seam in one frame. Joining before the seam has
   * entered the frame needs no fade; an export never fades.
   */
  _updateIncomingFade(incoming, sim) {
    const tSec = Number(sim?.biomes?.tSec);
    if (!incoming || this.exportMode || sim?.exportMode || !Number.isFinite(tSec)) {
      this._incomingJoin = null;
      this.incomingFade = 1;
      return;
    }
    if (this._incomingJoin?.id !== incoming.id) {
      const late = this._waitedFor === incoming.id && (this.seamP ?? 0) > 0.001;
      this._incomingJoin = late ? { id: incoming.id, tSec } : { id: incoming.id, tSec: -Infinity };
      this._waitedFor = null;
    }
    const u = (tSec - this._incomingJoin.tSec) / ARRIVAL_SEC;
    this.incomingFade = u < 0 ? 1 : fade01(u);
  }

  /** The travel composition buffer: one canvas at the scenic backing size,
   *  reserved before it exists. False when the budget refuses it. */
  _ensureScratch(vp) {
    const w = Math.max(2, Math.round(vp.backingWidth)), h = Math.max(2, Math.round(vp.backingHeight));
    const bytes = w * h * 4;
    // Both dimensions must fit: a same-area but taller viewport would
    // otherwise be squashed into the stale height.
    if (this._scratch && this._scratch.width >= w && this._scratch.height >= h) return true;
    this._releaseScratch();
    let res = null;
    if (this.residency) {
      res = this.residency.reserve({ key: TRAVEL_SCRATCH_KEY, bytes, owner: 'range-targets' });
      if (!res) return false;
    }
    const canvas = this._makeCanvas(w, h);
    this._scratch = canvas;
    this._scratchBytes = bytes;
    if (res) {
      this.residency.commit(res, canvas, (c) => {
        if (this._scratch === c) { this._scratch = null; this._scratchBytes = 0; }
        c.width = 0; c.height = 0;
      });
    }
    return true;
  }

  _releaseScratch() {
    if (!this._scratch) return;
    if (this.residency) this.residency.release(TRAVEL_SCRATCH_KEY);
    this._scratch = null;
    this._scratchBytes = 0;
  }

  drawSkyGiants(ctx, stage) {
    if (!this.active || !this.frame) return false;
    const cols = this.incomingViewId ? this._travelBandColumns(stage.width) : null;
    const render = (id, side) => this.scene.renderSkyGiants?.(this.frame, id, { side, bandColumns: cols?.[side] });
    if (this.incomingViewId) return this._compositeSides(ctx, stage, 'L2',
      () => render(this.viewId, 'A'), () => render(this.incomingViewId, 'B'));
    const image = render(this.viewId, 'A');
    if (!image) return false;
    ctx.save(); ctx.globalAlpha = this.arrival; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(image, 0, 0, stage.width, stage.height); ctx.restore();
    return true;
  }

  /** Composite one partition into `ctx` over the scenic stage, under the
   *  transform currently in effect (applied exactly once). */
  drawPartition(ctx, pass, stage) {
    this.lastPartition = null;
    if (!this.active || !this.frame) return false;
    const t0 = performance.now();
    // Everything painted before the middle distance (sky, aurora, distant
    // ranges, the far terrain) is the backdrop the lake reflects.
    if (pass === 'mid') {
      const manager = this.frameInputs?.sim?.biomes;
      const drawSky = manager?.highResolutionSky && manager.rangeSkyLayer ? (target, width, height) =>
        manager.drawHighResolutionSky(target, target.canvas, { transform: [width / stage.width, 0, 0, height / stage.height, 0, 0] }) : null;
      this.scene.captureBackdrop?.(ctx, stage, this.frame, drawSky);
    }
    if (this.incomingViewId) {
      // Travel between two views: each side renders into its own target and
      // is composited through the shared travel seam (TravelSeam.js), the
      // nearest partition changing first, as the legacy ranges do.
      const layerKey = PASS_LAYER[pass] || 'L3';
      const cols = this._travelBandColumns(stage.width);
      let renderMs = 0;
      const timed = (fn) => () => { const r0 = performance.now(); const r = fn(); renderMs += performance.now() - r0; return r; };
      const drawn = this._compositeSides(ctx, stage, layerKey,
        timed(() => this.scene.renderPartition(this.frame, pass, this.viewId, { side: 'A', bandColumns: cols.A })),
        timed(() => this.scene.renderPartition(this.frame, pass, this.incomingViewId, { side: 'B', bandColumns: cols.B })));
      this._noteTiming(renderMs, performance.now() - t0 - renderMs);
      if (drawn) this.lastPartition = { pass, ...this._lastComposite, arrival: this.arrival, shafted: !!this.scene.lastShafted };
      return drawn;
    }
    const img = this.scene.renderPartition(this.frame, pass, this.viewId);
    const t1 = performance.now();
    if (!img) return false;
    ctx.save();
    ctx.globalAlpha = this.arrival;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0, stage.width, stage.height);
    ctx.restore();
    // The partition's own pixels, valid until the next partition renders:
    // light that belongs on this terrain can use them as its mask.
    this.lastPartition = { pass, image: img, width: img.width, height: img.height,
      arrival: this.arrival, shafted: !!this.scene.lastShafted };
    this._noteTiming(t1 - t0, performance.now() - t1);
    return true;
  }

  /** One pass's render and copy cost: kept as the last pass and summed
   *  into the frame's totals (a frame has several passes, two sides each
   *  during a travel). */
  _noteTiming(renderMs, copyMs) {
    const t = this.timings;
    t.lastPartitionMs = renderMs;
    t.lastCopyMs = copyMs;
    t.frameRenderMs += renderMs;
    t.frameCopyMs += copyMs;
  }

  /**
   * Where each side draws its mid and near passes during travel, as width
   * fractions [x0, x1]: side A up to the far edge of that band's seam
   * feather, side B from its near edge (A everywhere while a late-joining B
   * is still fading in). Each side's depth pre-pass holds a nearer band only
   * there, so the far image never keeps ridge-shaped holes for ridges the
   * other side has replaced.
   */
  _travelBandColumns(width) {
    const fading = (this.incomingFade ?? 1) < 1;
    const out = { A: {}, B: {} };
    for (const [band, layer] of [['mid', PASS_LAYER.mid], ['near', PASS_LAYER.near]]) {
      const { lo, hi } = travelSpans(width, layer, this.seamP ?? 0, V2_TRAVEL_BANDS);
      out.A[band] = fading ? [0, 1] : [0, Math.min(1, Math.max(0, hi / width))];
      out.B[band] = [Math.min(1, Math.max(0, lo / width)), 1];
    }
    return out;
  }

  /**
   * Blend side A (left of the seam) and side B (right of it) in the
   * composition buffer, then copy it to the stage once. Each span of the
   * seam gives B a weight w (0 left of the feather, the band's weight inside
   * it, 1 right of it; all scaled by the incoming fade): A is drawn at 1 - w,
   * then B is ADDED at w ('lighter' on premultiplied pixels), so where both
   * sides are opaque the blend stays opaque -- a plain source-over pair would
   * leave the bands up to 25% see-through. Each render returns the shared
   * drawing buffer, so A is fully drawn before B is rendered.
   */
  _compositeSides(ctx, stage, layerKey, renderA, renderB, backing = null) {
    const { lo, hi, bands } = travelSpans(stage.width, layerKey, this.seamP ?? 0, V2_TRAVEL_BANDS);
    const fadeB = this.incomingFade ?? 1;
    const far = stage.width * 2;
    const spans = [{ x0: -far, x1: lo, w: 0 }, ...bands.map((b) => ({ x0: b.x0, x1: b.x1, w: b.weightB })), { x0: hi, x1: far, w: 1 }]
      .filter((sp) => sp.x1 > sp.x0)
      .map((sp) => ({ ...sp, w: sp.w * fadeB }));
    const out = this._scratch;
    const a = renderA();
    if (!out) return false;
    // Scenic and ground images differ in size: blend in the top-left W x H
    // of the buffer (reserved at the scenic backing size, which the ground
    // image -- same scale, smaller stage -- never exceeds), so the buffer is
    // not reallocated between the two composites of one frame.
    const W = Math.min(out.width, backing?.backingWidth || a?.width || out.width), H = Math.min(out.height, backing?.backingHeight || a?.height || out.height);
    const sctx = out.getContext('2d');
    const sx = W / stage.width;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, W, H);
    const put = (img, x0, x1, alpha, op) => {
      if (!img || !(alpha > 0.001)) return;
      // Whole pixels: neighbouring bands share an exact edge (no
      // anti-aliased hairline where both would be partly transparent).
      const cx0 = Math.max(0, Math.round(x0 * sx)), cx1 = Math.min(W, Math.round(x1 * sx));
      if (!(cx1 > cx0)) return;
      sctx.save();
      sctx.beginPath();
      sctx.rect(cx0, 0, cx1 - cx0, H);
      sctx.clip();
      sctx.globalAlpha = Math.min(1, alpha);
      sctx.globalCompositeOperation = op;
      sctx.drawImage(img, 0, 0, W, H);
      sctx.restore();
    };
    for (const sp of spans) put(a, sp.x0, sp.x1, 1 - sp.w, 'source-over');
    const b = renderB();
    for (const sp of spans) put(b, sp.x0, sp.x1, sp.w, 'lighter');
    if (!a && !b) return false;
    ctx.save();
    ctx.globalAlpha = this.arrival;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(out, 0, 0, W, H, 0, 0, stage.width, stage.height);
    ctx.restore();
    this._lastComposite = { image: out, width: W, height: H };
    return true;
  }

  /** Composite the rock stage under the fixed-ground transform. */
  drawGround(ctx, stage) {
    this.stage = null;
    if (!this.active || !this.frame) return false;
    const needsGround = id => this.frame.compositions?.[id]?.foreground === 'ledge';
    const needsA = needsGround(this.viewId), needsB = this.incomingViewId && needsGround(this.incomingViewId);
    if (!needsA && !needsB) { this.scene.releaseGroundTarget?.(); return true; }
    const render = id => needsGround(id) ? this.scene.renderGround(this.frame, id) : null;
    if (this.incomingViewId) {
      // The rock stage wears each side's material through the nearest seam;
      // its receivers (pools) come from whichever side holds the centre.
      let outA = null, outB = null, renderMs = 0;
      const g0 = performance.now();
      const timed = (fn) => () => { const r0 = performance.now(); const r = fn(); renderMs += performance.now() - r0; return r; };
      const drawn = this._compositeSides(ctx, stage, 'L5',
        timed(() => (outA = render(this.viewId))?.canvas),
        timed(() => (outB = render(this.incomingViewId))?.canvas), this.frame.groundViewport);
      this.timings.frameRenderMs += renderMs;
      this.timings.frameCopyMs += performance.now() - g0 - renderMs;
      // Receivers (pools, wet masks) follow the side that visibly holds the
      // centre: B's seam weight there, scaled by its late-join fade.
      const { lo, hi, bands } = travelSpans(stage.width, 'L5', this.seamP ?? 0, V2_TRAVEL_BANDS);
      const cx = stage.width / 2;
      const seamW = cx < lo ? 0 : cx >= hi ? 1 : (bands.find((b) => cx >= b.x0 && cx < b.x1)?.weightB ?? 0.5);
      const bHolds = seamW * (this.incomingFade ?? 1) >= 0.5;
      this.stage = (bHolds ? outB : outA)?.stage || null;
      return drawn;
    }
    const g0 = performance.now();
    const out = render(this.viewId);
    const g1 = performance.now();
    if (!out) return false;
    ctx.save();
    ctx.globalAlpha = this.arrival;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(out.canvas, 0, 0, stage.width, stage.height);
    ctx.restore();
    this.timings.frameRenderMs += g1 - g0;
    this.timings.frameCopyMs += performance.now() - g1;
    this.stage = out.stage;
    return true;
  }

  /** Any actual travel side has adopted geographic foreground ownership. */
  get hasViewComposition() {
    return this.active && [this.viewId, this.incomingViewId].some(id => id && this.frame?.compositions?.[id]);
  }

  /** Wet receivers for GroundResponse / reflections: exact pool polygons
   *  in fixed-ground coordinates (no rectangles). */
  groundReceivers() {
    if (!this.active || !this.stage || this.arrival < 1) return null;
    return { wetMasks: this.stage.wetMasks, litEdges: [], pools: this.stage.pools };
  }

  /** Small enough for the control to poll while paused; unlike the full
   *  snapshot this does not copy scene, terrain or residency diagnostics. */
  status() {
    const selectedViewId = this.forcedViewId || this.viewId || this._wants[0]?.id || null;
    const runtimeReady = this.runtimeState === 'ready' && !!this.scene && !this.scene.contextLost;
    const active = this.active && runtimeReady;
    const fallbackReason = active ? null : this.failures.get(selectedViewId)
      || (this.scene?.contextLost ? 'context-lost' : this.reason);
    return {
      mode: this.mode, requestedMode: this.mode, resolvedMode: active ? 'v2' : 'legacy',
      tourMode: this.tourMode, active, viewId: active ? this.viewId : null, selectedViewId,
      runtime: this.runtimeState, runtimeReady, reason: this.reason, fallbackReason,
      tourPreparation: { ...this._tourPreparation }, generation: this.generation,
      shotTours: { enabled: this.shots.enabled, active: this.active && this.cameraTourActive, views: this.shots.status() },
    };
  }

  /** The shot tour state of one view at a heard time (capture diagnostics). */
  shotState(viewId, timeMs) { return this.shots.stateAt(viewId, timeMs); }

  /** The current tour timelines and committed horizon for an in-place
   *  rebuild of the same song (full-analysis adoption). */
  cameraContinuation(committedThroughMs) { return this.shots.continuation(committedThroughMs); }

  snapshot() {
    return {
      ...this.status(),
      tour: this.tour ? { durationMs: this.tour.durationMs, heroes: this.tour.heroes, notes: this.tour.notes, meanQualityRatio: this.tour.meanQualityRatio, heroFraming: this.tour.heroFraming || [], heroCoverage: this.tour.heroCoverage || null } : null,
      forcedCandidate: !!this.forced?.forcedCandidate, forcedViewId: this.forcedViewId, diag: this.diag,
      generation: this.generation, runtime: this.runtimeState, runtimeAttempts: this.runtimeAttempts, arrival: this.arrival, incomingFade: this.incomingFade, incomingViewId: this.active ? this.incomingViewId : null, seamP: this.seamP ?? null,
      failures: Object.fromEntries(this.failures), deferred: [...this.deferred.keys()], frameId: this.frameId, progress01: this.frame?.progress01 ?? null,
      scene: this.scene?.snapshot?.() || null, residency: this.residency?.snapshot?.() || null,
      narrative: this.frame?.narrative || null,
      timings: { ...this.timings }, catalogVersion: this.catalog.catalogVersion,
    };
  }

  dispose() {
    this._readinessOwner = {};
    this._tourAbort?.abort();
    this._replanAbort?.abort();
    this._releaseScratch();
    if (this.residency && this.generation) this.residency.cancelGeneration(this.generation);
    this.scene?.dispose();
    this.scene = null;
    this.active = false;
    this.frame = null;
    this.viewId = null;
    this.incomingViewId = null;
    this._runtimeEpoch++; // a load still in flight must not publish
    this.runtimeState = this.enabled ? 'idle' : 'off';
  }
}

export { viewportState };
