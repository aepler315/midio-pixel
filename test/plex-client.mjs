import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePms } from './helpers/plex-fixtures.mjs';
import { readPlexConfig } from '../tools/plex/config.mjs';
import { createPlexClient } from '../tools/plex/client.mjs';
const env = baseUrl => ({ MIDIO_PLEX_ENABLED: 'true', PLEX_BASE_URL: baseUrl, PLEX_TOKEN: 'fixture-secret', PLEX_CLIENT_IDENTIFIER: 'fixture-adapter', PLEX_MUSIC_SECTION_IDS: '1' });
async function fixture(t, options = {}, config = {}) { const pms = await createFakePms(options); t.after(pms.close); return { pms, client: createPlexClient({ ...readPlexConfig(env(pms.baseUrl)), ...config }) }; }
test('disabled-config-needs-no-secret', () => { assert.equal(typeof readPlexConfig, 'function'); assert.equal(readPlexConfig({}).enabled, false); });
test('enabled-config-requires-section-allowlist', () => { assert.equal(typeof readPlexConfig, 'function'); assert.throws(() => readPlexConfig({ ...env('http://127.0.0.1:32400'), PLEX_MUSIC_SECTION_IDS: '' }), /section/i); });
test('token-only-in-upstream-header', async t => { const {pms,client} = await fixture(t); const result = await client.discover(); assert.equal(result.sections[0].id, '1'); for (const req of pms.requests) { assert.equal(req.headers['x-plex-token'], 'fixture-secret'); assert.ok(!JSON.stringify(req.query).includes('fixture-secret')); } });
test('rejects-cross-origin-provider-key', async t => { const {pms,client} = await fixture(t,{overrides:{'/media/providers':(_req,res) => res.end(JSON.stringify({MediaContainer:{machineIdentifier:'x',MediaProvider:[{identifier:'com.plexapp.plugins.library',Feature:[{type:'metadata',key:'http://evil.invalid/library/metadata'},{type:'search',key:'/hubs/search'},{type:'content',Directory:[{id:1,type:'artist',key:'/library/sections/1/all'}]}]}]}}))}}); await assert.rejects(client.discover(), /key/i); assert.equal(pms.requests.length,1); });
test('rejects-token-bearing-redirect', async t => { const {client} = await fixture(t,{overrides:{'/library/metadata/30':(_req,res)=>{res.writeHead(302,{Location:'http://evil.invalid/'});res.end();}}}); await assert.rejects(client.getJson('/library/metadata/30'), /redirect/i); });
test('metadata-body-timeout', async t => { const {client} = await fixture(t,{overrides:{'/library/metadata/30':(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}}},{metadataTimeoutMs:30}); await assert.rejects(client.getJson('/library/metadata/30'), e=>e.code==='UPSTREAM_TIMEOUT'); });
test('rejects-oversized-json', async t => { const {client} = await fixture(t,{overrides:{'/library/metadata/30':(_req,res)=>res.end(JSON.stringify({x:'x'.repeat(2000)}))}},{metadataMaxBytes:100}); await assert.rejects(client.getJson('/library/metadata/30'),e=>e.code==='UPSTREAM_INVALID'); });
test('hostile-keys-never-requested',async t=>{const {pms,client}=await fixture(t);for(const key of ['http://evil.invalid/library/metadata/1','//evil.invalid/x','/library/metadata/%2e%2e/settings','/library/metadata/%252e%252e/settings','/library/metadata/1?X-Plex-Token=leak','/settings','/library/metadata/1\n'])await assert.rejects(client.getJson(key));assert.equal(pms.requests.length,0);});
test('startup-rejects-video-section',async t=>{const {pms}=await fixture(t);const client=createPlexClient(readPlexConfig({...env(pms.baseUrl),PLEX_MUSIC_SECTION_IDS:'3'}));await assert.rejects(client.discover(),/section/i);});
test('operator-probe-is-redacted-and-checks-original-eligibility',async t=>{const {pms}=await fixture(t);const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['tools/plex-probe.mjs'],{env:{...process.env,...env(pms.baseUrl)},cwd:new URL('..',import.meta.url)});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const exit=await new Promise(resolve=>child.on('close',resolve));assert.equal(exit,0,stderr);const report=JSON.parse(stdout);assert.equal(report.originalDownload.eligible,true);assert.equal(report.artwork.available,true);for(const secret of ['fixture-secret','C:','fixture-machine-private',pms.baseUrl])assert.ok(!(stdout+stderr).includes(secret),secret);assert.ok(pms.requests.some(x=>x.query.download==='1'));});
test('private-client-refuses-token-and-arbitrary-query-fields',async t=>{const {pms,client}=await fixture(t);for(const query of [{'X-Plex-Token':'leak'},{url:'http://evil.invalid/'},{'__proto__':null,token:'leak'}])await assert.rejects(client.getJson('/library/metadata/30',{query}));assert.equal(pms.requests.length,0);});
test('aborted-metadata-subscriber-releases-capacity', { timeout: 5000 }, async t => {
  let closed = false, markStarted, markClosed;
  const started = new Promise(resolve => { markStarted = resolve; });
  const connectionClosed = new Promise(resolve => { markClosed = resolve; });
  const { pms, client } = await fixture(t, { overrides: {
    '/library/metadata/30': (_req, res) => {
      res.on('close', () => { closed = true; markClosed(); });
      res.write('{');
      markStarted();
    },
  } }, { maxMetadataRequests: 1 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const first = client.getJson('/library/metadata/30', { signal: controller.signal });
  // Abort an actually admitted upstream body, not a request that may still
  // be waiting for the event loop after an arbitrary ten-millisecond sleep.
  await Promise.race([started, first.then(() => assert.fail('metadata ended before abort'))]);
  controller.abort();
  await assert.rejects(first);
  await connectionClosed;
  assert.equal(closed, true);
  assert.ok((await client.getJson('/library/metadata/31')).MediaContainer.Metadata.length);
  assert.equal(pms.requests.length, 2);
});
