import { escapeHtml } from './visual-evaluation-report.mjs';

// Native-sized, lossless images; labels remain outside the scene. The two
// clip images share one audio clock, including during an instant toggle.
export function renderTerrainReport(before, after) {
  const views = [];
  before.songs.forEach((song, i) => {
    const other = after.songs[i];
    const pair = (f, n) => ({ timeMs: f.actualTimeMs, before: `baseline/${f.png}`, after: `candidate/${other.frames[n].png}` });
    song.frames.forEach((f, n) => {
      if (f.checkpoint) views.push({ label: `${f.view || 'Authored wide view'} · ${(f.timeMs / 1000).toFixed(1)}s`, frames: [pair(f, n)] });
    });
    (song.clips || []).forEach((clip, c) => views.push({ label: `Motion · ${clip.startMs / 1000}–${(clip.startMs + clip.durationMs) / 1000}s · ${before.settings.fps} captured FPS`,
      ...clip, audio: `baseline/${song.audio}`, frames: song.frames.flatMap((f, n) => f.clips.includes(c) ? [pair(f, n)] : []) }));
  });
  const json = JSON.stringify(views).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Mount Moran terrain shading comparison</title>
<style>body{margin:24px;background:#11151c;color:#edf0f5;font:16px/1.5 system-ui}main{max-width:${before.settings.width}px;margin:auto}h1{font-size:26px;margin-bottom:8px}p{max-width:1000px}button,select{font:inherit;padding:8px 12px;border:1px solid #677287;border-radius:5px;background:#202936;color:inherit;cursor:pointer}nav{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0}#stage{position:relative;width:100%;aspect-ratio:${before.settings.width}/${before.settings.height};background:#000}#stage img{display:block;width:100%;height:100%;image-rendering:pixelated}#after{position:absolute;inset:0;clip-path:inset(0 100% 0 0)}label{display:flex;gap:8px;align-items:center}input{width:180px}#status{font-weight:600;min-height:1.5em}audio{width:100%;margin-top:12px}pre{white-space:pre-wrap;font-size:13px}a{color:#a8d9ff}</style>
<main><h1>Mount Moran · terrain-aware shading study</h1>
<p>Baseline shading and experimental Moran shading. Actual camera, lighting, weather, audio timing, assets and presentation were checked for equality. This establishes a matched comparison; it does not establish an artistic improvement.</p>
<p><strong>Both sides:</strong> ${before.settings.width} × ${before.settings.height} output · ${escapeHtml(before.settings.presentation?.pixelGrid)} pixel grid · ${escapeHtml(before.settings.presentation?.pixelScale)} pixel scaling · quality ${before.settings.quality} · unchanged world palette.</p>
<nav><select id="view" aria-label="Comparison view"></select><button id="baseline">Baseline shading</button><button id="experiment">Experimental shading</button><label>Wipe <input id="wipe" type="range" min="0" max="100" value="0"></label><button id="play" hidden>Play matched passage</button></nav>
<div id="status" aria-live="polite">Baseline shading</div><div id="stage"><img id="before" alt="Baseline scene"><img id="after" alt="Experimental scene"></div>
<audio id="audio" controls hidden></audio>
<p>Use the buttons or wipe at the full scene size. Space toggles shading. The closer view uses the existing listener zoom at the same song time. Motion is an offline sequence at the stated capture cadence, not a live frame-rate measurement.</p>
<details><summary>Settings and capture provenance</summary><pre>${escapeHtml(JSON.stringify({ settings: before.settings, baseline: { source: before.source.digest, shading: before.experiment.requested }, experiment: { source: after.source.digest, shading: after.experiment.requested }, environment: before.environment, browser: before.browser }, null, 2))}</pre></details>
<p><a href="baseline/index.html">Baseline report</a> · <a href="candidate/index.html">Experimental report</a> · <a href="terrain-state.json">Matched-state checks</a></p></main>
<script>const views=${json};
const byId=id=>document.getElementById(id), select=byId('view'), audio=byId('audio'), wipe=byId('wipe');
let current, anim=0, shown=-1;
for(const [i,v] of views.entries())select.add(new Option(v.label,i));
function shade(n){wipe.value=n;byId('after').style.clipPath='inset(0 '+(100-n)+'% 0 0)';byId('status').textContent=n===0?'Baseline shading':n===100?'Experimental Moran shading':'Wipe · experiment left / baseline right';}
function frame(n){if(n===shown)return;shown=n;byId('before').src=current.frames[n].before;byId('after').src=current.frames[n].after;}
function tick(){let n=0;for(let i=0;i<current.frames.length;i++){if(current.frames[i].timeMs>audio.currentTime*1000)break;n=i;}frame(n);if(audio.currentTime*1000>=current.startMs+current.durationMs)audio.pause();if(!audio.paused)anim=requestAnimationFrame(tick);}
function view(){audio.pause();cancelAnimationFrame(anim);current=views[Number(select.value)];shown=-1;frame(0);audio.hidden=byId('play').hidden=!current.audio;if(current.audio){audio.src=current.audio;audio.currentTime=current.startMs/1000;}}
select.onchange=view;wipe.oninput=()=>shade(Number(wipe.value));byId('baseline').onclick=()=>shade(0);byId('experiment').onclick=()=>shade(100);
byId('play').onclick=()=>{audio.currentTime=current.startMs/1000;audio.play();};audio.onplay=()=>{cancelAnimationFrame(anim);tick();};audio.onseeked=tick;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','BUTTON','AUDIO'].includes(document.activeElement.tagName)){e.preventDefault();shade(Number(wipe.value)>0?0:100);}});view();</script></html>`;
}
