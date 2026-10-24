import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestHostname, requestHostAllowed, isIpLiteral, hostList } from '../tools/lib/request-host.mjs';

test('Host headers parse to a bare hostname or nothing', () => {
  assert.equal(requestHostname('LocalHost:8080'), 'localhost');
  assert.equal(requestHostname('[::1]:8080'), '[::1]');
  assert.equal(requestHostname('127.0.0.1'), '127.0.0.1');
  for (const bad of ['', '   ', 'user@127.0.0.1', '127.0.0.1/x', '127.0.0.1?x', 'a b', '127.0.0.1:99999', undefined]) {
    assert.equal(requestHostname(bad), null, String(bad));
  }
});

test('only loopback names pass the default gate', () => {
  for (const ok of ['127.0.0.1:1', '127.8.9.10', 'localhost', 'app.localhost:5', '[::1]:9']) {
    assert.equal(requestHostAllowed(ok), true, ok);
  }
  for (const bad of ['127.evil.example', '127.0.0.1.nip.io', 'localhost.attacker.example', '192.168.1.5', 'evil.example', '127.0.0.1@evil.example']) {
    assert.equal(requestHostAllowed(bad), false, bad);
  }
});

test('IP literals and configured names pass only when asked for', () => {
  assert.equal(requestHostAllowed('192.168.1.5:8088', { allowIpLiterals: true }), true);
  assert.equal(requestHostAllowed('[fe80::1]:8088', { allowIpLiterals: true }), true);
  assert.equal(requestHostAllowed('192.168.1.5.nip.io', { allowIpLiterals: true }), false);
  assert.equal(requestHostAllowed('Music.Lan:1', { extraHosts: hostList('music.lan, other') }), true);
  assert.equal(requestHostAllowed('music.lan.evil.example', { extraHosts: ['music.lan'] }), false);
  assert.equal(isIpLiteral('[::1]'), true);
  assert.equal(isIpLiteral('localhost'), false);
});
