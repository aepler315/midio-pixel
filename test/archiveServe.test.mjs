import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startArchive } from '../tools/archive-serve.mjs';

// A throwaway history, because CI checks this repository out one commit deep.
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'midio-archive-'));
  const git = (...args) => {
    const result = spawnSync('git', [
      '-c', 'user.name=Archive Test', '-c', 'user.email=archive@test.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
    ], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'Readme.md'), '# before the app\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'Create Readme');

  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'soundfonts'));
  writeFileSync(join(repo, 'index.html'),
    '<!doctype html><body><script type="module" src="/src/main.js"></script></body>');
  writeFileSync(join(repo, 'src/main.js'), 'export const version = "one";\n');
  writeFileSync(join(repo, 'soundfonts/README.md'), 'drop fonts here\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'Scaffold the app');
  git('tag', 'alpha');

  writeFileSync(join(repo, 'src/main.js'), 'export const version = "two";\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'Second take (#7)');

  // What GitHub's "Create a merge commit" writes: the title is in the body.
  git('commit', '--quiet', '--allow-empty',
    '-m', 'Merge pull request #9 from someone/some-branch', '-m', 'Teach the ridge to dance');

  // Present on disk, never committed: what a user-dropped SoundFont looks like.
  writeFileSync(join(repo, 'soundfonts/local.sf2'), 'RIFF');
  return repo;
}

// fetch() cannot choose its Host header, and <sha>.localhost need not resolve
// outside a browser, so talk to loopback and name the origin by hand.
function get(port, host, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { Host: `${host}:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('archive serves each commit from its own origin with working navigation', async (t) => {
  const repo = makeRepo();
  const archive = await startArchive({ repo, port: 0 });
  t.after(async () => {
    await archive.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const { port } = archive;

  const timeline = await get(port, 'localhost', '/');
  assert.equal(timeline.status, 200);
  assert.match(timeline.headers['content-type'], /^text\/html/);

  const { versions } = JSON.parse((await get(port, 'localhost', '/versions.json')).body);
  assert.deepEqual(versions.map((v) => v.title),
    ['Create Readme', 'Scaffold the app', 'Second take (#7)', 'Teach the ridge to dance (#9)']);
  assert.equal(versions[3].subject, 'Merge pull request #9 from someone/some-branch');
  assert.deepEqual(versions.map((v) => v.runnable), [false, true, true, true]);
  assert.deepEqual(versions.map((v) => v.tags), [[], ['alpha'], [], []]);
  assert.deepEqual(versions.map((v) => v.pr), [null, null, 7, 9]);
  assert.equal(versions[1].url, `http://${versions[1].id}.localhost:${port}/`);

  const [readme, first, second] = versions.map((v) => `${v.id}.localhost`);
  assert.equal(new Set(versions.map((v) => v.id)).size, versions.length);

  // The same absolute URL means a different file in each version.
  const one = await get(port, first, '/src/main.js');
  assert.equal(one.status, 200);
  assert.match(one.headers['content-type'], /^text\/javascript/);
  assert.match(one.headers['cache-control'], /immutable/);
  assert.match(one.body, /"one"/);
  assert.match((await get(port, second, '/src/main.js')).body, /"two"/);

  const page = await get(port, first, '/');
  assert.match(page.body, /src="\/src\/main\.js"/);
  assert.match(page.body, /<script src="\/__archive\/nav\.js" defer><\/script><\/body>/);
  assert.equal(page.headers['cache-control'], 'no-store');

  const nav = (await get(port, first, '/__archive/nav.js')).body;
  assert.ok(nav.includes(`"prev":"http://${versions[0].id}.localhost:${port}/"`));
  assert.ok(nav.includes(`"next":"http://${versions[2].id}.localhost:${port}/"`));
  const newest = await get(port, `${versions[3].id}.localhost`, '/__archive/nav.js');
  assert.ok(newest.body.includes('"next":null'));
  assert.ok(newest.body.includes('"title":"Teach the ridge to dance (#9)"'));

  // A commit from before the app stays reachable and keeps its navigation.
  const empty = await get(port, readme, '/');
  assert.equal(empty.status, 200);
  assert.match(empty.body, /nothing to run/);
  assert.match(empty.body, /__archive\/nav\.js/);

  // Gitignored SoundFonts come from disk; nothing else on disk does.
  assert.equal((await get(port, first, '/soundfonts/')).body, '["local.sf2"]');
  assert.equal((await get(port, first, '/soundfonts/local.sf2')).body, 'RIFF');
  assert.equal((await get(port, first, '/soundfonts/README.md')).body, 'drop fonts here\n');
  assert.equal((await get(port, readme, '/Readme.md')).status, 200);
  assert.equal((await get(port, first, '/src/missing.js')).status, 404);
  assert.equal((await get(port, first, '/.git/config')).status, 404);

  assert.equal((await get(port, first, '/src/..%2f..%2fsecret')).status, 400);
  assert.equal((await get(port, first, '/%ZZ')).status, 400);
  assert.equal((await get(port, first, '/src%5cmain.js')).status, 400);
  assert.equal((await get(port, '0000000.localhost', '/')).status, 404);
  assert.equal((await get(port, 'evil.example', '/')).status, 400);
  assert.equal((await get(port, `${versions[1].id}.evil.example`, '/')).status, 400);
});

test('archive answers many interleaved blob reads in order', async (t) => {
  const repo = makeRepo();
  const archive = await startArchive({ repo, port: 0 });
  t.after(async () => {
    await archive.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const [, first, second] = archive.versions.map((v) => `${v.id}.localhost`);
  const requests = Array.from({ length: 60 }, (_, i) => {
    const path = ['/src/main.js', '/src/nope.js', '/Readme.md'][i % 3];
    return get(archive.port, i % 2 ? first : second, path).then((res) => ({ i, path, res }));
  });
  for (const { i, path, res } of await Promise.all(requests)) {
    if (path === '/src/nope.js') assert.equal(res.status, 404);
    else if (path === '/Readme.md') assert.equal(res.body, '# before the app\n');
    else assert.match(res.body, i % 2 ? /"one"/ : /"two"/);
  }
});
