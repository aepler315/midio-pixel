import {
  EXPORT_RESOLUTIONS, EXPORT_ASPECTS, EXPORT_FPS, EXPORT_ENCODINGS,
  readExportSettings, writeExportSettings, resolveExportSettings, pickMimeType,
  exportFrameRect, exportVideoBitsPerSecond, estimateExportBytes, formatBytes, reachSummary,
} from '../render/VideoExport.js';

/** One set of real controls, available before audio is booted. */
export class ExportSetup {
  constructor({ root, storage, scope = window, onChange = () => {} }) {
    this.root = root; this.storage = storage; this.scope = scope; this.onChange = onChange;
    this.settings = readExportSettings(storage);
    this.durationMs = 0; this.locked = false;
    this.toggle = root.querySelector('#exportEnabled');
    this.fields = root.querySelector('#exportFields');
    this.note = root.querySelector('#exportNote');
    this.controls = {};
    const groups = {
      resolution: EXPORT_RESOLUTIONS.map(v => [v, v === '2160' ? '4K · 2160p' : `${v}p`]),
      aspect: EXPORT_ASPECTS.map((v, i) => [v, [`${v} · Landscape`, `${v} · Portrait`, `${v} · Square`, `${v} · Standard`, '800×480 · Car display'][i]]),
      fps: EXPORT_FPS.map(v => [v, `${v} fps`]),
      encoding: EXPORT_ENCODINGS.map(v => [v, { compact: 'Compact · smaller file', balanced: 'Balanced', best: 'Best · larger file' }[v]]),
      framing: [['fit', 'Fit · keep the whole scene'], ['fill', 'Fill · crop to the frame']],
    };
    for (const [key, choices] of Object.entries(groups)) {
      const input = root.querySelector(`[data-export="${key}"]`);
      this.controls[key] = input;
      for (const [value, label] of choices) {
        const option = root.ownerDocument.createElement('option'); option.value = value; option.textContent = label; input.append(option);
      }
      input.addEventListener('change', () => {
        this.settings = resolveExportSettings({ ...this.settings, [key]: key === 'fps' ? Number(input.value) : input.value });
        writeExportSettings(this.storage, this.settings); this.render(); this.onChange(this.snapshot());
      });
    }
    this.toggle.addEventListener('change', () => { this.render(); this.onChange(this.snapshot()); });
    this.render();
  }

  get candidate() { return pickMimeType(type => this.scope.MediaRecorder?.isTypeSupported(type)); }
  snapshot() { return this.toggle.checked ? { ...this.settings } : null; }
  setBusy(value) { this.locked = !!value; this.render(); }
  setDuration(durationMs) { this.durationMs = durationMs; this.render(); }

  render() {
    const s = this.settings, candidate = this.candidate;
    this.toggle.disabled = this.locked || !candidate;
    this.fields.hidden = !this.toggle.checked;
    this.fields.disabled = this.locked || !candidate;
    for (const [key, control] of Object.entries(this.controls)) control.value = String(s[key]);
    this.controls.resolution.disabled = s.aspect === '5:3';
    const preview = this.root.querySelector('#exportPreview');
    preview.style.aspectRatio = `${s.width} / ${s.height}`;
    const scene = this.root.querySelector('#exportPreviewScene');
    const rect = exportFrameRect(1280, 720, s.width, s.height, s.framing);
    Object.assign(scene.style, { left: `${rect.x / s.width * 100}%`, top: `${rect.y / s.height * 100}%`,
      width: `${rect.width / s.width * 100}%`, height: `${rect.height / s.height * 100}%` });
    const summary = `${s.width} × ${s.height} · ${s.fps} fps · ${(exportVideoBitsPerSecond(s) / 1e6).toFixed(1)} Mbps`;
    this.root.querySelector('#exportSummary').textContent = summary;
    preview.setAttribute('aria-label', `${s.aspect} output, ${s.framing === 'fill' ? 'scene cropped to fill' : 'whole scene fitted with bars when needed'}`);
    const estimate = this.durationMs > 0
      ? `Estimated ${formatBytes(estimateExportBytes(s, this.durationMs))} for this song.`
      : `About ${formatBytes(estimateExportBytes(s, 60000))} per minute.`;
    this.note.textContent = `${reachSummary(candidate)} ${candidate ? estimate + ' Records in real time. FPS is a target; keep this tab visible.' : ''}`;
  }
}
