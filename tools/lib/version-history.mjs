import { execFileSync } from 'node:child_process';

// Reviewed main.js changes that only alter input, menus, captions or version
// navigation. Everything else touching main.js is conservatively a version.
export const UI_ONLY_MAIN = Object.freeze({
  'f0a08fe9ae65648a01430965d171620cd761775e': 'file chooser import repair', 'dc3d1cc015ea8394a5dc2218a6e2dd8c93c483df': 'file chooser import reconciliation',
  'ef368829f24b99a4933849d3aa98d914c20fe473': 'upload world selection flow', '183e186fa8634620f05753ac294849f1c7d0cae7': 'seek pointer coordinates',
  '30ec58c79942fcdaeb8a4b8fcb287c1a6378ed54': 'fullscreen controls', '1ee04175c8fc21737782e2587703742f240d31b6': 'Bluetooth trim editor',
  '9bcb5b4fc23d2501c7755e744c95ce228577949d': 'world chooser keyboard and modal focus', '4369d78fa169260ccea37889a618bf5789619769': 'fullscreen and display wake controls',
  'fe090026c71b92b4ef0a4fffc6c2bfb4901576fe': 'range name caption', '5e7dd3a91e2ea82bd83dcf571c836eb4729817ae': 'range picker readability and selection',
  '5ebd89b2f3c607261fa5de332cc1f51034af2dac': 'hide duplicate pilot choices', '75641ba349b23b096a60ff848bd34c7990b2eb41': 'native input keyboard ownership',
  '88f3776477d21cf5795a20ab6c494656d62aea62': 'version navigation and source handoff',
});
// Additional reviewed menu/input changes whose helpers live outside src/ui.
export const UI_ONLY_REVISIONS = Object.freeze({
  'c0d26391b8edaaa17b5e1c383fc098225dc58844': 'song search menu', '1e7fc821d2c09aef4b55f70aa31a5168240b61cf': 'song search configuration',
  '627bb0f2e0a7ab4a4e11ddf310dc07984cbc7c41': 'Soulseek loader controls', '4145b83582a1f0e4bfe6bfb972633b72dabda5fc': 'duplicate search UI removal',
  '93697b16d2808882736e8230802935ce72386e05': 'search import and deployment repair',
  '0fd901102fdf307740dccd9f089aafe4779e5d77': 'world chooser preview', '07488979cb1ecbc45c17550f3b6aa3b12103e32c': 'world descriptions',
  'bfc08638104a4a057984ca360aef8fc734a6a942': 'URL file input', '59ad121bee658444979359adbb6eb9fb4f9012cf': 'URL listing selection',
  '1ece85084839a0a2c74e42e71a9a5c20522b270f': 'credentials and folder preferences',
  '6792dbe08547523a6c3d6b5f2ba6962666322518': 'range and biome menu',
});
export function isPublicPath(name) {
  return typeof name === 'string' && !name.includes('\\') && !name.split('/').some(s => !s || s.startsWith('.'))
    && (name === 'index.html' || name.startsWith('src/') || name.startsWith('soundfonts/'));
}
export function indexRuntimeSignature(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/VersionBootstrap|midio-version-metadata/.test(m[0])).map(m => ({
    src: (m[1].match(/src=["']([^"']+)["']/i)?.[1] || '').replace(/^\/src\//, './src/'),
    type: m[1].match(/type=["']([^"']+)["']/i)?.[1] || '', body: m[2].trim(),
  }));
  const stage = html.match(/<canvas\b[^>]*id=["']stage["'][^>]*>/i)?.[0] || '';
  const size = ['width', 'height'].map(name => stage.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1] || '');
  return JSON.stringify([size, scripts]);
}
const uiPath = name => name === 'index.html' || name.startsWith('src/ui/') || name.startsWith('src/eval/') || /\.(?:md|txt)$/i.test(name);
export function groupHistory(revisions) {
  const entries = [], audit = []; let previous = null;
  for (const rev of revisions) {
    if (!rev.files['index.html'] || !rev.files['src/main.js']) { audit.push({ sha: rev.sha, reason: 'no-runnable-app' }); continue; }
    const changed = previous ? [...new Set([...Object.keys(previous.files), ...Object.keys(rev.files)])].filter(p => previous.files[p] !== rev.files[p]) : Object.keys(rev.files);
    const reviewedRevision = UI_ONLY_REVISIONS[rev.sha];
    const reviewed = rev.uiOnly || reviewedRevision || UI_ONLY_MAIN[rev.sha];
    const bootstrapChanged = previous && rev.indexRuntime !== previous.indexRuntime;
    const engineChange = !previous || bootstrapChanged || (!reviewedRevision && changed.some(p => !uiPath(p) && !(p === 'src/main.js' && reviewed)));
    if (engineChange) {
      const pr = /(?:#|pull request #)(\d+)/.exec(rev.subject || '');
      entries.push({ id: `v-${rev.sha.slice(0, 12)}`, label: rev.subject || rev.sha.slice(0, 12), visualSha: rev.sha, sourceSha: rev.sha, sourcePr: pr ? Number(pr[1]) : null, date: rev.date, revisions: [], live: false });
    }
    const entry = entries.at(-1); entry.sourceSha = rev.sha; entry.updated = rev.date; entry.revisions.push(rev.sha);
    audit.push({ sha: rev.sha, id: entry.id, reason: engineChange ? 'engine-change' : changed.length ? 'ui-only' : 'no-runtime-change', changed, review: reviewed || null });
    previous = rev;
  }
  if (!entries.length) throw new Error('History contains no runnable application.');
  entries.at(-1).live = true;
  return { entries, audit, liveId: entries.at(-1).id };
}
export function readHistory(source, ref = 'HEAD') {
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') throw new Error('Full version history is required. Run git fetch --unshallow, then npm start.');
  const rows = git('log', '--first-parent', '--reverse', '--format=%H%x09%cs%x09%s', ref).trim().split('\n');
  const revisions = rows.map(row => {
    const [sha, date, title] = row.split('\t');
    const body = /^Merge pull request #/.test(title) ? git('show', '-s', '--format=%B', sha).split('\n').slice(2).find(line => line.trim()) : null;
    const pr = /#(\d+)/.exec(title);
    const subject = body ? `${body.trim()} (#${pr[1]})` : title; const files = {};
    for (const item of git('ls-tree', '-rz', sha, '--', 'index.html', 'src', 'soundfonts').split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(item);
      if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !isPublicPath(match[4])) throw new Error(`Unsafe historical public file: ${item}`);
      files[match[4]] = match[3];
    }
    const indexRuntime = files['index.html'] ? indexRuntimeSignature(git('show', `${sha}:index.html`)) : null;
    return { sha, date, subject, files, indexRuntime };
  });
  return { ...groupHistory(revisions), revisions, buildSha: git('rev-parse', ref).trim() };
}
