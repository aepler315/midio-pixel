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
// Run npm as `node npm-cli.js` when npm started us (npm_execpath), with no
// shell, so an argument such as an output path with spaces stays one
// argument. Otherwise fall back to npm itself (npm.cmd needs a shell on
// Windows; arguments are then quoted).
const npmCli = process.env.npm_execpath && /\.c?js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null;
const npmCommand = (args) => (npmCli
  ? [process.execPath, [npmCli, ...args], false]
  : process.platform === 'win32'
    ? ['npm.cmd', args.map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)), true]
    : ['npm', args, false]);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** Runs one npm step, logging everything it prints; resolves its exit code. */
function run(name, npmArgs, env = {}) {
  const [command, args, shell] = npmCommand(npmArgs);
  return new Promise((resolve) => {
    const started = Date.now();
    const log = [];
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, shell, windowsHide: true });
    child.on('error', (error) => log.push(Buffer.from(String(error))));
    child.stdout.on('data', (d) => log.push(d));
    child.stderr.on('data', (d) => log.push(d));
    child.on('close', async (code) => {
      await fs.writeFile(path.join(out, `${name}.log`), Buffer.concat(log));
      resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000 });
    });
  });
}

/** Starts tools/serve.js on `port` serving `siteRoot` (the source tree when
 *  empty). PORT and SITE_ROOT are always set, so a developer's exported
 *  values cannot redirect the check; a server that exits is never mistaken
 *  for whatever else may answer on the port. */
async function startServer(port, siteRoot, servers) {
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'), String(port)], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SITE_ROOT: siteRoot }, stdio: 'ignore', windowsHide: true,
  });
  servers.push(child);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server on ${port} exited (${child.exitCode ?? child.signalCode})`);
    try { if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).ok) return child; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
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
  const result = await run(name, args);
  results.push(result);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name} (${result.seconds.toFixed(0)} s)`);
}

const staged = results.find((r) => r.name === 'stage-site')?.code === 0;
if (!flag('--no-browser')) {
  const [sourcePort, stagedPort] = [await freePort(), await freePort()];
  const servers = [];
  try {
    await startServer(sourcePort, '', servers);
    if (staged) await startServer(stagedPort, path.join(root, '_site'), servers);
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
      const result = await run(name, args);
      results.push(result);
      console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name} (${result.seconds.toFixed(0)} s)`);
    }
  } catch (error) {
    // A server that cannot start fails the run with a summary, not a crash.
    results.push({ name: 'servers', code: 1, seconds: 0 });
    console.log(`FAIL servers: ${error.message}`);
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
