// The whole local validation sequence from docs/local-validation.md, in one
// command, with its own servers on free ports and a summary to paste into a
// pull request. Usage: npm run validate [-- --out .smoke/validate-x] [--no-browser]
//
// Every browser check stays headless; logs go to the output directory, which
// lives under .smoke/ and is never committed.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(root, option('--out') || `.smoke/validate-${stamp}`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** Runs one step, logging everything it prints; resolves its exit code. */
function run(name, command, args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = [];
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, shell: process.platform === 'win32' });
    child.stdout.on('data', (d) => log.push(d));
    child.stderr.on('data', (d) => log.push(d));
    child.on('close', async (code) => {
      await fs.writeFile(path.join(out, `${name}.log`), Buffer.concat(log));
      resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000 });
    });
  });
}

async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'), String(port)], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', ...env }, stdio: 'ignore', windowsHide: true,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).ok) return child; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server on ${port} did not start`);
}

await fs.mkdir(out, { recursive: true });
const results = [];
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) console.warn(`validate: Node ${process.versions.node}; package.json requires 24.x (see .nvmrc)`);

for (const [name, args] of [
  ['audit', ['audit', '--audit-level=high']],
  ['lint', ['run', 'lint']],
  ['test', ['test']],
  ['ridgeview-test', ['--prefix', 'ridgeview', 'test']],
  ['stage-site', ['run', 'stage:site']],
]) {
  const result = await run(name, npm, args);
  results.push(result);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name} (${result.seconds.toFixed(0)} s)`);
}

const staged = results.find((r) => r.name === 'stage-site')?.code === 0;
if (!flag('--no-browser')) {
  const [sourcePort, stagedPort] = [await freePort(), await freePort()];
  const servers = [await startServer(sourcePort, {})];
  if (staged) servers.push(await startServer(stagedPort, { SITE_ROOT: '_site' }));
  try {
    const browserSteps = [
      ['bootstrap-source', ['run', 'test:bootstrap', '--', `http://127.0.0.1:${sourcePort}`]],
      ['smoke-source', ['run', 'test:smoke', '--', `http://127.0.0.1:${sourcePort}`]],
    ];
    if (staged) browserSteps.push(
      ['bootstrap-staged', ['run', 'test:bootstrap', '--', `http://127.0.0.1:${stagedPort}`]],
      ['smoke-staged', ['run', 'test:smoke', '--', `http://127.0.0.1:${stagedPort}`]],
      ['routes-staged', ['run', 'test:routes', '--', '--site-root', '_site', '--out', path.join(out, 'current-routes')]],
    );
    for (const [name, args] of browserSteps) {
      const result = await run(name, npm, args);
      results.push(result);
      console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name} (${result.seconds.toFixed(0)} s)`);
    }
  } finally {
    for (const server of servers) server.kill();
  }
}

const commit = await new Promise((resolve) => {
  const git = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  let text = ''; git.stdout.on('data', (d) => { text += d; }); git.on('close', () => resolve(text.trim() || 'unknown'));
});
const failed = results.filter((r) => r.code !== 0);
const summary = [
  `### npm run validate — ${failed.length ? `${failed.length} failing` : 'all passed'}`,
  '',
  `Node ${process.versions.node} · ${process.platform} · commit ${commit} · logs \`${path.relative(root, out)}\``,
  '',
  '| Step | Result | Time |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.name} | ${r.code === 0 ? 'pass' : `**fail (exit ${r.code})**`} | ${r.seconds.toFixed(0)} s |`),
  ...(staged ? [] : ['', 'Browser checks against `_site` were skipped because staging failed.']),
  ...(flag('--no-browser') ? ['', 'Browser checks were skipped (`--no-browser`).'] : []),
].join('\n');
await fs.writeFile(path.join(out, 'summary.md'), `${summary}\n`);
console.log(`\n${summary}`);
process.exit(failed.length ? 1 : 0);
