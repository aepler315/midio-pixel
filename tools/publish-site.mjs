// Publishes exactly the staged site, never the repository, to the gh-pages
// branch that GitHub Pages serves (supermaudio.com).
//
//   npm run publish:site                    # stage main, boot it, push gh-pages
//   npm run publish:site -- --ref <commit>  # any commit or branch
//   npm run publish:site -- --dry-run       # everything except the push
//
// The ref is exported with `git archive` (line-ending conversion off, so the
// pinned Range/vendor bytes are exactly the committed blobs), staged and
// verified by tools/stage-site.mjs, booted headless by the bootstrap smoke,
// and committed onto gh-pages with plumbing in a private index. The working
// tree, its index and the checked-out branch are never touched.
import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSite } from './stage-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const dryRun = argv.includes('--dry-run');
const ref = option('--ref', 'main');
const remote = option('--remote', 'origin');
const branch = option('--branch', 'gh-pages');

// With stdio 'inherit' or 'ignore' execFileSync returns null, not a string.
const git = (args, opts = {}) => (execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', ...opts }) ?? '').trim();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** git archive <sha> | tar -x, in-process so no shell parses either side. */
async function exportTree(sha, dir) {
  await fs.mkdir(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', sha], { cwd: root });
    const tar = spawn('tar', ['-xf', '-', '-C', dir]);
    archive.stdout.pipe(tar.stdin);
    let failed = '';
    archive.stderr.on('data', (d) => { failed += d; });
    tar.stderr.on('data', (d) => { failed += d; });
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`export of ${sha} failed: ${failed}`))));
    archive.on('error', reject); tar.on('error', reject);
  });
}

async function bootSmoke(siteDir) {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'), String(port)], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', SITE_ROOT: siteDir }, stdio: 'ignore', windowsHide: true,
  });
  try {
    const code = await new Promise((resolve) => {
      const smoke = spawn(process.execPath, [path.join(root, 'tools', 'bootstrap-smoke.mjs'), `http://127.0.0.1:${port}`], { cwd: root, stdio: 'inherit' });
      smoke.on('close', resolve);
    });
    if (code !== 0) throw new Error(`the staged site failed its bootstrap smoke (exit ${code}); nothing was published`);
  } finally {
    server.kill();
  }
}

/** Commits siteDir as the next gh-pages commit without touching any checkout. */
function commitSite(siteDir, sha, parent) {
  const index = path.join(os.tmpdir(), `midio-publish-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(['--work-tree', siteDir, 'add', '--all', '--force', '.'], { env });
    const tree = git(['write-tree'], { env });
    const message = `Publish ${sha} (${ref})\n\nStaged by tools/publish-site.mjs; serves only the stage:site output.`;
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  } finally {
    rmSync(index, { force: true });
  }
}

const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-publish-'));
const source = path.join(work, 'source'), site = path.join(work, 'site');
try {
  console.log(`publish: exporting ${ref} (${sha.slice(0, 7)})`);
  await exportTree(sha, source);
  // The stage rebuilds the Range bundle from installed dependencies when it
  // can, and rejects a stale committed bundle; lend it this checkout's.
  try { await fs.symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'junction'); } catch { /* no deps: hashes are still verified */ }
  await stageSite(source, site, { commit: sha, ref });
  await bootSmoke(site);
  // Build on the remote's current gh-pages (none on the first publish).
  let parent = null;
  try { git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { stdio: 'ignore' }); } catch { /* first publish */ }
  try { parent = git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]); } catch { parent = null; }
  const commit = commitSite(site, sha, parent || null);
  console.log(`publish: ${branch} commit ${commit.slice(0, 7)} holds ${ref} ${sha.slice(0, 7)}`);
  if (dryRun) console.log('publish: --dry-run, not pushing');
  else {
    git(['push', remote, `${commit}:refs/heads/${branch}`], { stdio: 'inherit' });
    git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { stdio: 'ignore' });
    console.log(`publish: pushed. Once Pages builds, https://supermaudio.com/version.json reports ${sha}`);
  }
} finally {
  try { await fs.unlink(path.join(source, 'node_modules')); } catch { /* not linked */ }
  await fs.rm(work, { recursive: true, force: true });
}
