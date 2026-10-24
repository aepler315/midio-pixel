// `npm install` / `npm ci` (the `prepare` script) points this clone's Git at
// the versioned hooks in .githooks. Quietly does nothing outside a Git
// checkout (an npm pack, a copied tree) and never replaces a hooks path the
// developer set to something else.
import { execFileSync } from 'node:child_process';

function git(...args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

if (git('rev-parse', '--is-inside-work-tree') === 'true') {
  const current = git('config', '--get', 'core.hooksPath');
  if (!current) git('config', 'core.hooksPath', '.githooks');
  else if (current !== '.githooks') console.warn(`install-hooks: core.hooksPath is ${current}; leaving it (expected .githooks)`);
}
