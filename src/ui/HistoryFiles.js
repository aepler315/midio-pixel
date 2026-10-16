const VERSION = /^v-[a-f0-9]{12}$/;
export function parseHistoryRequest(url, siteRoot) {
  const root = new URL(siteRoot), request = new URL(url);
  if (request.origin !== root.origin || !request.pathname.startsWith(root.pathname + 'versions/run/')) return null;
  let tail;
  try { tail = decodeURIComponent(request.pathname.slice((root.pathname + 'versions/run/').length)); } catch { return null; }
  const [id, ...parts] = tail.split('/');
  if (!VERSION.test(id)) return null;
  let file = parts.join('/'); if (!file) file = 'index.html';
  if (file.includes('\\') || file.split('/').some(p => !p || p.startsWith('.')) || !(file === 'index.html' || file.startsWith('src/') || file.startsWith('soundfonts/'))) return null;
  return { id, file };
}
export function historyMime(file) {
  const extension = file.split('.').at(-1).toLowerCase();
  return { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gz: 'application/gzip', wasm: 'application/wasm', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', mid: 'audio/midi', midi: 'audio/midi' }[extension] || 'application/octet-stream';
}
export function portableHistoryText(text, file, base, id) {
  // Early releases used /src URLs. Preserve their layout on project Pages and
  // prevent them from accidentally importing today's engine.
  text = text.replace(/(["'`])\/(src|soundfonts)\//g, (_, quote, dir) => `${quote}${base}${dir}/`);
  if (file === 'index.html') {
    text = text.replace(/<script[^>]*id="midio-version-metadata"[\s\S]*?<\/script>/g, '')
      .replace(/<script[^>]*src="[^"]*VersionBootstrap\.js"[^>]*><\/script>/g, '')
      .replace(/<link[^>]*href="[^"]*version-navigation\.css"[^>]*>/g, '');
    // Historical preference/cache formats are not interchangeable. Each
    // engine retains its own settings without corrupting another release.
    const namespace = `<script>(()=>{const prefix=${JSON.stringify(`midio-history:${id}:`)};const store=localStorage;for(const name of ['getItem','setItem','removeItem']){const original=Storage.prototype[name];Storage.prototype[name]=function(key,...args){return original.call(this,this===store?prefix+key:key,...args)}}for(const name of ['open','deleteDatabase']){const original=indexedDB[name].bind(indexedDB);indexedDB[name]=(key,...args)=>original(prefix+key,...args)}})();</script>`;
    text = text.replace(/<head[^>]*>/i, match => match + namespace);
  }
  if (file === 'src/main.js') text += HISTORY_ENGINE_BRIDGE;
  return text;
}

// Expose existing lifecycle controls without changing historical simulation,
// audio, shader or draw code. Missing controls stay explicitly unsupported.
export const HISTORY_ENGINE_BRIDGE = `
;window.__MIDIO_HISTORY_ENGINE = {
  getState() {
    const audio = typeof audioEngine === 'undefined' ? null : audioEngine;
    const simulation = typeof sim === 'undefined' ? null : sim;
    const active = typeof running !== 'undefined' && running && !!simulation;
    const clock = typeof conductor === 'undefined' ? null : conductor;
    const capturing = typeof songRecorder !== 'undefined' && (songRecorder?.recording || songRecorder?.finalizing);
    const exporting = (typeof bulkExportArmed !== 'undefined' && bulkExportArmed) || (typeof pendingExportPresetId !== 'undefined' && pendingExportPresetId);
    const calibrating = typeof recalibration !== 'undefined' && recalibration?.active;
    const custom = typeof getCustomWorld === 'function' && simulation?.worldId === 'custom' ? getCustomWorld() : null;
    return { ready: active, positionMs: Math.max(0, (audio?.nowMs || 0) - (audio && typeof choreographyOutputLatencyMs === 'function' ? choreographyOutputLatencyMs() : 0)), durationMs: clock?.durationMs || 0,
      settings: { worldBaseId: custom?.registeredId || custom?.baseId || null },
      blockedReason: capturing || exporting ? 'Finish the current recording or export before changing versions.' : calibrating ? 'Finish calibration before changing versions.' : null,
      paused: typeof paused !== 'undefined' ? paused : audio?.ctx?.state === 'suspended', seed: simulation?.songSeed, worldId: simulation?.worldId, lyricsDisabled: typeof lyricsDisabled !== 'undefined' ? lyricsDisabled : false, sourceName: typeof lastSongName === 'undefined' ? null : lastSongName, audioState: audio?.ctx?.state };
  },
  seek: typeof seekSong === 'function' ? ms => seekSong(ms) : null,
  async setPaused(value) {
    if (typeof togglePause === 'function' && typeof paused !== 'undefined') { if (paused !== value) await togglePause(); if (typeof audioEngine !== 'undefined' && audioEngine?.ctx) { if (value) await audioEngine.ctx.suspend(); else await audioEngine.ctx.resume(); } }
    else if (typeof audioEngine !== 'undefined' && audioEngine?.ctx) { if (value) await audioEngine.ctx.suspend(); else await audioEngine.ctx.resume(); }
  },
  wakeHud: typeof wakeHud === 'function' ? () => wakeHud() : () => {},
};
`;
