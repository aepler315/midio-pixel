// Autonomous closed-loop vision self-tuning (spec §5). A vision model is a
// noisy sensor, not a chat partner: slow sampling, strict schema, heavy
// actuator smoothing (owned by ParamBus), and revert-on-regress. This loop
// must be safe to fail 100% of the time — the configured provider being
// absent/unreachable/misconfigured degrades to a silent no-op, never a
// crash or a stuck game. Ollama is the zero-setup default; Anthropic,
// OpenAI, Gemini, and OpenRouter are available with a user-supplied API key
// (see providers.js) so the loop never requires a key baked into the app.
import { RingBuffer } from '../utils/RingBuffer.js';
import { clamp, clamp01 } from '../utils/math.js';
import { VISION_PROVIDERS, callVisionProvider } from './providers.js';

const CRITIC_SYSTEM = `You are the visual director of a rhythm-driven side-scroller. You receive 4 frames spanning ~1 second, in order, plus telemetry. Judge only what is visible. Respond with ONLY a JSON object matching the schema — no prose, no markdown fences.`;

const ADJUST_KEYS = ['jumpHeight', 'obstacleDensity', 'scrollSpeed', 'eqSensitivity', 'onsetThreshold'];
const CAPTURE_INTERVAL_MS = 350;
const CYCLE_PERIOD_MS = 15000;
const COOLDOWN_MS = 8000;
const MIN_FPS = 45;
const FETCH_TIMEOUT_MS = 20000;
const MIN_CONFIDENCE = 0.4;

export class VisionLoop {
  constructor(canvas, paramBus, sim, {
    enabled = false, provider = 'ollama', apiKey = '', endpoint = null, model = null, perfGovernor = null,
  } = {}) {
    this.canvas = canvas;
    this.paramBus = paramBus;
    this.sim = sim;
    this.enabled = enabled;
    this.perfGovernor = perfGovernor;
    this.setProvider(provider, { apiKey, endpoint, model });

    this.ring = new RingBuffer(4);
    this.log = new RingBuffer(40);

    this._captureCanvas = document.createElement('canvas');
    this._captureCanvas.width = 512;
    this._captureCanvas.height = 288;
    this._captureCtx = this._captureCanvas.getContext('2d');

    this._lastCaptureMs = -Infinity;
    this._lastCycleMs = -Infinity;
    this._cooldownUntilMs = -Infinity;
    this._inFlight = false;
    this._pendingBlob = false;

    this._fps = 60;
    this._lastFrameTime = null;
  }

  /** Switch providers (or update the current one's key/model/endpoint) live.
   *  An explicit endpoint/model wins; otherwise falls back to that
   *  provider's default so switching providers doesn't leave e.g. an
   *  Ollama model name pointed at OpenAI. */
  setProvider(provider, { apiKey = '', endpoint = null, model = null } = {}) {
    const cfg = VISION_PROVIDERS[provider] || VISION_PROVIDERS.ollama;
    this.provider = VISION_PROVIDERS[provider] ? provider : 'ollama';
    this.apiKey = apiKey;
    this.endpoint = endpoint || cfg.endpoint;
    this.model = model || cfg.model;
  }

  /** Called once per rAF frame (spec §6.1). tRafMs: performance.now(); nowSimMs: song-relative ms. */
  maybeSample(tRafMs, nowSimMs) {
    this._trackFps(tRafMs);
    if (!this.enabled) return;
    if (this.perfGovernor && !this.perfGovernor.visionAllowed) return;

    if (tRafMs - this._lastCaptureMs >= CAPTURE_INTERVAL_MS && !this._pendingBlob) {
      this._lastCaptureMs = tRafMs;
      this._captureFrame();
    }

    if (tRafMs - this._lastCycleMs < CYCLE_PERIOD_MS) return;
    if (tRafMs < this._cooldownUntilMs) return;
    if (this._fps < MIN_FPS) return; // perf first, aesthetics second
    if (this._inFlight) return;
    if (this.ring.length < 4) return;

    this._lastCycleMs = tRafMs;
    this._runCycle(nowSimMs);
  }

  _trackFps(tRafMs) {
    if (this._lastFrameTime !== null) {
      const dt = tRafMs - this._lastFrameTime;
      if (dt > 0) this._fps = this._fps * 0.9 + (1000 / dt) * 0.1;
    }
    this._lastFrameTime = tRafMs;
  }

  _captureFrame() {
    this._pendingBlob = true;
    try {
      this._captureCtx.drawImage(this.canvas, 0, 0, this._captureCanvas.width, this._captureCanvas.height);
    } catch { this._pendingBlob = false; return; }
    this._captureCanvas.toBlob((blob) => {
      if (!blob) { this._pendingBlob = false; return; }
      const reader = new FileReader();
      reader.onload = () => {
        this._pendingBlob = false;
        const base64 = String(reader.result).split(',')[1];
        if (base64) this.ring.push(base64);
      };
      reader.onerror = () => { this._pendingBlob = false; };
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.7);
  }

  async _runCycle(nowSimMs) {
    this._inFlight = true;
    const frames = this.ring.toArray();
    const telemetry = this._buildTelemetry(nowSimMs);

    try {
      const data = await callVisionProvider(this.provider, {
        apiKey: this.apiKey,
        endpoint: this.endpoint,
        model: this.model,
        systemPrompt: CRITIC_SYSTEM,
        telemetry,
        frames,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      const parsed = this._parseResponse(data);
      if (parsed) this._applyResult(parsed, nowSimMs);
      else this.log.push({ t: nowSimMs, applied: false, reason: 'invalid-or-low-confidence-payload' });
    } catch (err) {
      this.log.push({ t: nowSimMs, applied: false, reason: String((err && err.message) || err) });
    } finally {
      this._inFlight = false;
    }
  }

  _buildTelemetry(nowSimMs) {
    const p = this.paramBus.live;
    const bpm = this.sim.jump ? this.sim.jump.bpm : 0;
    const energy = this.sim.energyCurves ? this.sim.energyCurves.globalEnergy(nowSimMs) : 0;
    return [
      `TELEMETRY: bpm=${Math.round(bpm)} sectionEnergy=${energy.toFixed(2)}/1 fps=${Math.round(this._fps)}`,
      `multipliers: jump=${p.jumpHeight.toFixed(2)} obstacles=${p.obstacleDensity.toFixed(2)} scroll=${p.scrollSpeed.toFixed(2)} eqSens=${p.eqSensitivity.toFixed(2)} onset=${p.onsetThreshold.toFixed(2)}`,
      'CHECKLIST — score each 0(fine)–3(broken):',
      'eq_motion: are EQ bars moving with apparent music energy, or stagnant/pinned?',
      'speed_match: does world scroll urgency match the energy of the frames?',
      'companion_weight: do companion poses differ across frames (alive) or repeat?',
      'clutter: is the character silhouette readable against particles/cracks?',
      'Then propose multiplier targets (0.5–1.5) for: jumpHeight, obstacleDensity, scrollSpeed, eqSensitivity, onsetThreshold. Only move what your observations justify; return 1.0 for anything fine.',
    ].join('\n');
  }

  _parseResponse(data) {
    return parseVisionResponse(data);
  }

  _applyResult(parsed, nowSimMs) {
    const severity = parsed.observations.eq_motion + parsed.observations.speed_match
      + parsed.observations.companion_weight + parsed.observations.clutter;

    // Evaluate the PREVIOUS applied cycle's effect first (may revert it),
    // then snapshot the (possibly-reverted) state before applying this
    // cycle's own proposal (spec §5.2.3).
    this.paramBus.updateTrust(severity);
    this.paramBus.snapshotForRevert();
    this.paramBus.propose(parsed.adjust, parsed.confidence);

    this._cooldownUntilMs = this._lastCycleMs + COOLDOWN_MS;

    this.log.push({
      t: nowSimMs, applied: true, observations: parsed.observations, adjust: parsed.adjust,
      confidence: parsed.confidence, trust: this.paramBus.trust, severity,
    });
  }
}

/**
 * Defensive parse of an Ollama chat response into a validated adjustment
 * (spec §5.2.1): strip stray fences, type-check every field, clamp
 * everything to schema bounds, reject the whole payload on any doubt.
 * Pure function — exported standalone so it's unit-testable without a DOM.
 */
export function parseVisionResponse(data) {
  try {
    let content = data?.message?.content ?? data?.response ?? '';
    content = String(content).trim()
      .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const obj = JSON.parse(content);
    if (!obj || typeof obj !== 'object') return null;

    const obs = obj.observations, adj = obj.adjust, confidence = obj.confidence;
    if (!obs || !adj || typeof confidence !== 'number') return null;
    if (!ADJUST_KEYS.every((k) => k in adj)) return null;

    const clampScore = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(3, Math.round(v))) : 0);
    const observations = {
      eq_motion: clampScore(obs.eq_motion),
      speed_match: clampScore(obs.speed_match),
      companion_weight: clampScore(obs.companion_weight),
      clutter: clampScore(obs.clutter),
      notes: typeof obs.notes === 'string' ? obs.notes.slice(0, 160) : '',
    };

    const adjust = {};
    for (const k of ADJUST_KEYS) {
      const v = adj[k];
      adjust[k] = Number.isFinite(v) ? clamp(v, 0.5, 1.5) : 1.0;
    }

    const conf = clamp01(confidence);
    if (conf < MIN_CONFIDENCE) return null;

    return { observations, adjust, confidence: conf };
  } catch {
    return null;
  }
}
