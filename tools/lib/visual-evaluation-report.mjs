export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const document = (title, body, script = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;background:#111722;color:#e8edf4;margin:28px;max-width:1500px}h1{font-size:28px}h2{margin-top:36px}p{max-width:1000px;line-height:1.6}a{color:#9bd9ff}img{width:100%;background:#000}figure{margin:0;background:#202b3b;padding:10px;border-radius:8px}figcaption{padding:8px 2px;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}button{background:#b5e7ff;color:#101720;border:0;border-radius:5px;padding:9px;cursor:pointer;margin:8px}pre{white-space:pre-wrap;font-size:12px}audio{display:block;width:min(100%,640px);margin:12px 0}.status{color:#ffc66c}</style>
<h1>${escapeHtml(title)}</h1>${body}${script ? `<script>${script}</script>` : ''}</html>`;

export function renderRunReport(report) {
  const songs = report.songs.map((s, index) => `<section><h2>${escapeHtml(s.id)}</h2>
    <p>${escapeHtml(s.fixture ? `Generated ${s.fixture} fixture` : 'Local recording')} · audio SHA-256 ${escapeHtml(s.audioSha256)}<br>
    ${escapeHtml(s.durationMs ?? '?')} ms · ${s.frames.length} saved frames</p>
    ${s.audio ? `<audio id="audio-${index}" controls preload="metadata" src="${escapeHtml(s.audio)}"></audio>` : ''}
    ${(s.clips || []).map((c, n) => `<button data-song="${index}" data-clip="${n}">Play clip ${(c.startMs / 1000).toFixed(2)}–${((c.startMs + c.durationMs) / 1000).toFixed(2)}s</button>`).join('')}
    ${(s.clips || []).length ? `<img id="clip-${index}" alt="Motion clip frames" style="max-width:${report.settings.width}px;display:none">` : ''}
    <div class="grid">${s.frames.filter(f => f.checkpoint).map(f => `<figure><a href="${escapeHtml(f.png)}"><img loading="lazy" src="${escapeHtml(f.png)}" alt="${escapeHtml(s.id)} at ${f.actualTimeMs}ms"></a><figcaption>${f.view ? escapeHtml(f.view) + " · " : ""}Requested ${(f.timeMs / 1000).toFixed(3)}s · actual ${(f.actualTimeMs / 1000).toFixed(3)}s<br>v2 ${escapeHtml(f.range?.viewId)} · quality ${f.quality}${f.accessibility ? ` · flash ${f.accessibility.reducedFlash ? 'reduced' : 'full'} · motion ${f.accessibility.reducedMotion ? 'reduced' : 'full'}` : ' · preferences unverified'}<br>Energy ${Number(f.audio?.energy ?? 0).toFixed(3)} · storm ${Number(f.controls?.storm?.amount ?? 0).toFixed(3)}</figcaption></figure>`).join('')}</div>
    <details><summary>All consecutive clip frames</summary><div class="grid">${s.frames.filter(f => f.clips.length).map(f => `<figure><img loading="lazy" src="${escapeHtml(f.png)}" alt="${escapeHtml(s.id)} ${f.actualTimeMs}ms"><figcaption>${f.actualTimeMs.toFixed(2)}ms</figcaption></figure>`).join('')}</div></details>
    <details><summary>Diagnostics</summary><pre>${escapeHtml(JSON.stringify({ errors: s.errors, warnings: s.warnings }, null, 2))}</pre></details></section>`).join('');
  return document('Midio visual evaluation', `<p class="status">Capture: ${escapeHtml(report.status)} · visual judgment: unreviewed</p>
  <p>${escapeHtml(report.settings.mode)} export sampling · ${report.settings.width} × ${report.settings.height} · ${report.settings.fps} FPS clip cadence.<br>
  Sparse runs advance simulation across gaps but do not draw every intervening frame. Continuous runs draw from zero. These are actual app renders; software WebGL timing is not device FPS.</p>
  <p>Source ${escapeHtml(report.source?.commit)} · ${escapeHtml(report.source?.digest)}<br>Browser ${escapeHtml(report.browser)} · seed ${report.settings.seed} · quality ${report.settings.quality} · reduced flash ${report.settings.reducedFlash ?? false} · reduced motion ${report.settings.reducedMotion ?? false} · pinned view ${escapeHtml(report.settings.view ?? 'natural')} / biome ${escapeHtml(report.settings.biome ?? 'natural')}</p>
  <p>Listen and inspect: Is the intended object answering the audible attack? Does quiet material stay quiet? Does the climax preserve that response? Is camera movement coherent? Are terrain, sky and water readable together? Record each finding with song, time and hypothesis.</p>
  ${report.experiment ? `<p>Terrain shading: ${escapeHtml(report.experiment.requested)} · pixel scaling: ${escapeHtml(report.settings.presentation?.pixelScale)} · grid: ${escapeHtml(report.settings.presentation?.pixelGrid)}</p>` : ''}
  ${report.error ? `<pre class="status">${escapeHtml(report.error)}</pre>` : ''}${songs}`, `
  const songs=${json(report.songs.map(s => ({ frames: s.frames.map(f => ({ actualTimeMs: f.actualTimeMs, png: f.png, clips: f.clips })), clips: s.clips || [] })))};
  let cancel = () => {};
  for (const button of document.querySelectorAll('[data-clip]')) button.onclick = async () => {
    cancel(); const i = Number(button.dataset.song), n = Number(button.dataset.clip);
    const audio = document.getElementById('audio-' + i), img = document.getElementById('clip-' + i);
    const frames = songs[i].frames.filter(f => f.clips.includes(n)), clip = songs[i].clips[n];
    if (!frames.length) return;
    let running = true; cancel = () => { running = false; audio.pause(); };
    img.style.display = 'block'; img.src = frames[0].png; audio.currentTime = frames[0].actualTimeMs / 1000;
    try { await audio.play(); } catch { cancel(); return; }
    const draw = () => {
      if (!running) return;
      const ms = audio.currentTime * 1000;
      let frame = frames[0]; for (const f of frames) { if (f.actualTimeMs > ms) break; frame = f; }
      if (img.getAttribute('src') !== frame.png) img.src = frame.png;
      if (ms >= clip.startMs + clip.durationMs || audio.ended) { cancel(); return; }
      requestAnimationFrame(draw);
    }; draw();
  };`);
}

export function renderComparisonReport(diff, before, after) {
  return document('Midio before / after', `<p class="status">Visual judgment: unreviewed</p>
  <p>Inputs, capture schedule, settings and browser match. Source changes: ${escapeHtml(before.source?.commit)} → ${escapeHtml(after.source?.commit)}.<br>
  Accessibility provenance: ${escapeHtml(diff.accessibility?.provenance ?? 'unknown')}${diff.accessibility?.freshBaselineRequired ? ' — the baseline predates verified preferences; capture a fresh baseline before relying on matched flash/motion state' : ''}.
  Pixel differences show change, not improvement. Listen to the matching audio in the baseline and candidate reports before accepting a change.</p>
  <p><a href="baseline/index.html">Baseline with audio and motion</a> · <a href="candidate/index.html">Candidate with audio and motion</a></p>
  ${diff.frames.map((f, i) => `<section><h2>${escapeHtml(f.songId)} · ${(f.timeMs / 1000).toFixed(3)}s</h2>
  <p>${f.identical ? 'Identical PNG' : 'PNG changed'} · ${(100 * f.difference.changedFraction).toFixed(2)}% changed pixels in 64 × 36 thumbnail</p>
  <div class="pair"><figure><img loading="lazy" src="baseline/${escapeHtml(f.before)}" alt="Baseline ${i}"><figcaption>Before</figcaption></figure><figure><img loading="lazy" src="candidate/${escapeHtml(f.after)}" alt="Candidate ${i}"><figcaption>After</figcaption></figure></div></section>`).join('')}`);
}
