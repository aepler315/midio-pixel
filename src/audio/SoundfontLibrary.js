// SoundfontLibrary: manages a collection of loaded SoundFonts. Supports
// single buffer, multi-file (incl. .zip extraction), and File System Access
// directory loading + rescanning. Cycles through fonts with onChange callback.
//
// SynthRouter: drop-in replacement for SimpleSynth that routes noteOn to the
// active SF2 engine when a font is loaded, otherwise to the fallback synth.
import { parseSf2 } from './Sf2Parser.js';
import { Sf2Synth } from './Sf2Synth.js';
import { extractZip } from '../utils/zip.js';

export class SoundfontLibrary {
  constructor() {
    /** @type {{name:string, data:object, hidden:boolean, review?:object, _dirSourced?:boolean}[]} */
    this.fonts = [];
    this.activeIndex = -1;
    this.onChange = null; // (activeFont | null) => void
    this.onAdded = null;  // (font) => void — fires per font as it lands (FontRecommender hook)
    this._dirHandle = null;
  }

  get active() {
    return this.activeIndex >= 0 ? this.fonts[this.activeIndex] : null;
  }

  get count() {
    return this.fonts.length;
  }

  /** Fonts not hidden — what the switcher popup's main list and `cycle`
   *  operate over. Each entry keeps its real index into `fonts` so the UI
   *  can call `select`/`hide` without having to re-derive it. */
  get visibleFonts() {
    return this.fonts
      .map((font, index) => ({ font, index }))
      .filter(({ font }) => !font.hidden);
  }

  /** Fonts the user hid — what the settings "unhide" panel lists. */
  get hiddenFonts() {
    return this.fonts
      .map((font, index) => ({ font, index }))
      .filter(({ font }) => font.hidden);
  }

  /** Parse an SF2 ArrayBuffer and add it to the library. auto-activates the
   *  very first font ever added (or the next one added after every font
   *  was hidden/removed) — always the font that was just added, never a
   *  stale index 0 that might now point at something else. */
  async addBuffer(name, arrayBuffer) {
    const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const parsed = parseSf2(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), name);
    const font = { name: parsed.name || name, data: parsed, hidden: false };
    this.fonts.push(font);
    if (this.activeIndex < 0) this.activeIndex = this.fonts.length - 1;
    this._notify();
    if (this.onAdded) this.onAdded(font);
    return parsed;
  }

  /** Handle <input> files: .sf2 single, multi-select, .zip extraction. */
  async addFiles(fileList) {
    for (const file of fileList) {
      const name = file.name.toLowerCase();
      const buf = await file.arrayBuffer();
      if (name.endsWith('.sf2')) {
        await this.addBuffer(file.name, buf);
      } else if (name.endsWith('.zip')) {
        await this._addZipContents(buf, file.name);
      }
    }
  }

  async _addZipContents(arrayBuffer, zipName) {
    const entries = await extractZip(arrayBuffer);
    for (const [fname, data] of entries) {
      if (fname.toLowerCase().endsWith('.sf2')) {
        await this.addBuffer(fname, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
    }
  }

  /**
   * Best-effort: fetch tools/serve.js's `/soundfonts/` manifest and load
   * every font it lists — the "I don't know where to put the .sf2 files"
   * fix. Silently loads nothing (never throws) when the endpoint is 404,
   * unreachable, or returns something unexpected, so it's always safe to
   * fire off at boot even when the app is served by a plain static host
   * that doesn't implement the manifest route.
   * @returns {Promise<number>} how many fonts were loaded
   */
  async autoLoadFromServer(baseUrl = './soundfonts/') {
    let names;
    try {
      const res = await fetch(baseUrl);
      if (!res.ok) return 0;
      names = await res.json();
      if (!Array.isArray(names)) return 0;
    } catch {
      return 0;
    }

    let loaded = 0;
    for (const name of names) {
      try {
        const res = await fetch(baseUrl + encodeURIComponent(name));
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        if (name.toLowerCase().endsWith('.zip')) {
          await this._addZipContents(buf, name);
        } else {
          await this.addBuffer(name, buf);
        }
        loaded++;
      } catch {
        // Skip this one file and keep going — a single corrupt/unreadable
        // font shouldn't block the rest of the manifest from loading.
      }
    }
    return loaded;
  }

  /** File System Access API: load all .sf2/.zip from a directory handle. */
  async useDirectory(dirHandle) {
    this._dirHandle = dirHandle;
    await this._scanDirectory();
  }

  async _scanDirectory() {
    if (!this._dirHandle) return;
    for await (const entry of this._dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      const name = entry.name.toLowerCase();
      if (!name.endsWith('.sf2') && !name.endsWith('.zip')) continue;
      const file = await entry.getFile();
      const buf = await file.arrayBuffer();
      const before = this.fonts.length;
      if (name.endsWith('.sf2')) {
        await this.addBuffer(entry.name, buf);
      } else if (name.endsWith('.zip')) {
        await this._addZipContents(buf, entry.name);
      }
      // Mark fonts added by this scan as directory-sourced
      for (let i = before; i < this.fonts.length; i++) {
        this.fonts[i]._dirSourced = true;
      }
    }
  }

  /** Re-scan the bound directory: clears dir-sourced fonts and re-scans. */
  async rescanDirectory() {
    this.fonts = this.fonts.filter((f) => !f._dirSourced);
    this.activeIndex = this.fonts.length > 0 ? Math.min(this.activeIndex, this.fonts.length - 1) : -1;
    await this._scanDirectory();
    this._notify();
  }

  /** Cycle to the next/prev VISIBLE font. dir=1 next, dir=-1 prev. Hidden
   *  fonts are skipped entirely, as if they weren't in the library. */
  cycle(dir = 1) {
    const visible = this.visibleFonts;
    if (visible.length === 0) return;
    const curPos = visible.findIndex((v) => v.index === this.activeIndex);
    const nextPos = curPos < 0 ? 0 : (curPos + dir + visible.length) % visible.length;
    this.activeIndex = visible[nextPos].index;
    this._notify();
  }

  /** Explicitly activate a specific (visible) font by index — the switcher
   *  popup's click-to-select interaction. No-ops on a hidden or out-of-
   *  range index rather than surfacing something the user just hid. */
  select(index) {
    const font = this.fonts[index];
    if (!font || font.hidden) return;
    this.activeIndex = index;
    this._notify();
  }

  /** Hide a font: excluded from `cycle` and the switcher's main list until
   *  `unhide`. If it was active, auto-advances to the next visible font (or
   *  clears to "no font" if none remain). Data stays in memory — this is a
   *  visibility toggle, not a removal. */
  hide(index) {
    const font = this.fonts[index];
    if (!font || font.hidden) return;
    font.hidden = true;
    if (this.activeIndex === index) {
      this._activateNextVisible(index);
    } else {
      this._notify(); // list membership changed even though the active font didn't
    }
  }

  /** Clear the active font entirely (back to the built-in oscillator
   *  synth). Used by the recommender when every loaded font is disqualified
   *  for the current song — a plain synth beats silence or rumble. */
  deselect() {
    if (this.activeIndex === -1) return;
    this.activeIndex = -1;
    this._notify();
  }

  /** Restore a hidden font to the rotation. Does not auto-activate it. */
  unhide(index) {
    const font = this.fonts[index];
    if (!font || !font.hidden) return;
    font.hidden = false;
    this._notify();
  }

  _activateNextVisible(fromIndex) {
    const n = this.fonts.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step) % n;
      if (!this.fonts[idx].hidden) {
        this.activeIndex = idx;
        this._notify();
        return;
      }
    }
    this.activeIndex = -1; // nothing visible left
    this._notify();
  }

  _notify() {
    if (this.onChange) this.onChange(this.active);
  }
}

/**
 * Routes noteOn to the SF2 engine when a font is loaded, else to the fallback.
 * Mirrors SimpleSynth's shape so main.js can use it as a drop-in `synth`.
 */
export class SynthRouter {
  constructor(fallback) {
    this.fallback = fallback;
    this.sf2 = null; // Sf2Synth instance (may have no loaded font)
    // Router-level gate: the source of truth for "is the timeline allowed
    // to make sound." Child engines also get the flag, but noteOn checks
    // THIS first so a forgetful engine (or a newly-attached font) cannot
    // start voicing over a playing audio file.
    this._enabled = true;
  }

  setSf2Engine(sf2Engine) {
    this.sf2 = sf2Engine;
    if (this.sf2) this.sf2.enabled = this._enabled;
  }

  /** The active engine: SF2 synth if a font is loaded, else fallback. */
  get current() {
    return (this.sf2 && this.sf2.sf2) ? this.sf2 : this.fallback;
  }

  connectConductor(conductor) {
    return conductor.on('*', (evt) => this.noteOn(evt));
  }

  noteOn(evt) {
    if (!this._enabled) return;
    const engine = this.current;
    if (engine) engine.noteOn(evt);
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.fallback) this.fallback.enabled = this._enabled;
    if (this.sf2) this.sf2.enabled = this._enabled;
  }

  /** Releases every currently-sounding voice in both engines, including
   *  voices left behind by a change of active font. Call this before
   *  starting a new song (or swapping fonts) so the outgoing song's notes
   *  never bleed into the incoming one. */
  stopAll() {
    this.fallback?.stopAll?.();
    this.sf2?.stopAll?.();
  }
}
