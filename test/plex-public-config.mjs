import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writePlexPublicConfig } from '../tools/write-plex-public-config.mjs';
import { stageSite } from '../tools/stage-site.mjs';

test('public-config-is-disabled-by-default-and-never-reads-secrets', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'plex-config-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  process.env.PLEX_TOKEN='canary-private-secret';
  t.after(()=>delete process.env.PLEX_TOKEN);
  const target=path.join(dir,'plex.json');
  await writePlexPublicConfig(target,{});
  assert.deepEqual(JSON.parse(await fs.readFile(target,'utf8')),{version:1,apiBase:''});
  for(const apiBase of ['https://music.example/api/plex/v1','http://127.0.0.1:8787/api/plex/v1','http://[::1]:8787/api/plex/v1']) {
    await writePlexPublicConfig(target,{apiBase});
    assert.deepEqual(JSON.parse(await fs.readFile(target,'utf8')),{version:1,apiBase});
  }
});
test('public-config-rejects-private-authentication-and-unrelated-inputs',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'plex-config-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const apiBase of ['https://user:secret@example.com/api/plex/v1','https://example.com/api/plex/v1?X-Plex-Token=secret','https://example.com/api/plex/v1#token','http://192.168.1.2/api/plex/v1','https://example.com/not-plex','https://example.com/prefix/api/plex/v1','https://example.com/api/plex/v1/','file:///api/plex/v1']) {
    await assert.rejects(writePlexPublicConfig(path.join(dir,'plex.json'),{apiBase}));
  }
  await assert.rejects(writePlexPublicConfig(path.join(dir,'plex.json'),{apiBase:'',token:'secret'}));
});
test('staging-publishes-only-explicit-public-config',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'plex-stage-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source'),out=path.join(dir,'out');
  await fs.mkdir(path.join(source,'src/config'),{recursive:true});
  await fs.mkdir(path.join(source,'soundfonts'));
  for(const f of ['index.html','CNAME','src/main.js']) await fs.writeFile(path.join(source,f),'fixture');
  await fs.writeFile(path.join(source,'src/config/plex.json'),JSON.stringify({version:1,apiBase:'http://127.0.0.1:9999/api/plex/v1'}));
  await fs.writeFile(path.join(source,'.env.plex'),'PLEX_TOKEN=canary-private-secret');
  const prior=process.env.MIDIO_PLEX_PUBLIC_API_BASE;
  process.env.MIDIO_PLEX_PUBLIC_API_BASE='https://music.example/api/plex/v1';
  t.after(()=>{if(prior===undefined)delete process.env.MIDIO_PLEX_PUBLIC_API_BASE;else process.env.MIDIO_PLEX_PUBLIC_API_BASE=prior;});
  await stageSite(source,out);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'src/config/plex.json'),'utf8')),{version:1,apiBase:'https://music.example/api/plex/v1'});
  await assert.rejects(fs.access(path.join(out,'.env.plex')));
  await assert.rejects(fs.access(path.join(out,'tools/plex')));
  for(const f of ['index.html','CNAME','src/main.js','src/config/plex.json']) assert.doesNotMatch(await fs.readFile(path.join(out,f),'utf8'),/canary-private-secret|127\.0\.0\.1/);
});
