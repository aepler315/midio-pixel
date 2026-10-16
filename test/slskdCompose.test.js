// OPS-002: the companion must not float on :latest, and its published
// ports stay on loopback unless an operator deliberately changes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
const slskdYml = readFileSync(join(root, 'slskd/slskd.yml'), 'utf8');

test('the slskd image is pinned by version and digest, not latest', () => {
  assert.match(compose, /image:\s*slskd\/slskd:0\.26\.0@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(compose, /slskd\/slskd:latest(?:\s|$)/);
});

test('published slskd ports stay on loopback', () => {
  assert.match(compose, /127\.0\.0\.1:5030:5030/);
  assert.match(compose, /127\.0\.0\.1:\$\{SLSKD_PORT:-50300\}:50300/);
});

test('the companion drops privileges and bounds memory', () => {
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:/);
  assert.match(compose, /mem_limit:\s*512m/);
});

test('bundled slskd auth stays off only with an explicit loopback warning', () => {
  assert.match(slskdYml, /authentication:\s*\n(?:[^\n]*\n)*\s*disabled:\s*true/);
  assert.match(slskdYml, /host-trust boundary|loopback/i);
});
