import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStructure, analyzeStructureAsync, boundedStructureInput, MAX_STRUCTURE_POINTS } from '../src/audio/StructureAnalyzer.js';
import { analyzeStructureOffThread } from '../src/audio/StructureWorkerClient.js';
import { packBundle, unpackBundle } from '../src/audio/AnalysisBundle.js';
import { buildSongProfile } from '../src/audio/SongProfile.js';
import { EnergyCurves } from '../src/audio/EnergyCurves.js';

function fixture(n=120) {
  const durationMs=n*2000, energyCurves=new EnergyCurves(durationMs,1);
  const frames=Array.from({length:n}, (_,i)=> {
    const v=new Float32Array(84); v[i < n/2 ? 24 : 28]=1; return v;
  });
  for(let i=0;i<energyCurves.n;i++) energyCurves.setFrame(i,Array.from({length:7},(_,b)=>b===(i<n ? 1:5) ? .8 : .02));
  return { pointsMs:Array.from({length:n},(_,i)=>i*2000),pitchFeatures:{rate:.5,frames},energyCurves,durationMs };
}
test('cooperative structure matches numeric worker calculation and yields across rows',async()=> {
  const input=fixture(); let checks=0;
  const result=await analyzeStructureAsync(input,{maybeYield:async()=>{checks++;return false;}});
  assert.deepEqual(result,analyzeStructure(input));
  assert.ok(checks >= input.pointsMs.length * 4);
});
test('large structure inputs cap quadratic resolution while preserving endpoints and pacing',async()=> {
  const input=fixture(1000); input.minGapPoints=20;
  const bounded=boundedStructureInput(input);
  assert.equal(bounded.pointsMs.length,MAX_STRUCTURE_POINTS);
  assert.equal(bounded.pointsMs[0],0); assert.equal(bounded.pointsMs.at(-1),input.pointsMs.at(-1));
  const result=await analyzeStructureAsync(input);
  assert.deepEqual(result,analyzeStructure(bounded));
});
test('worker startup and post failure fall back to identical bounded analysis',async()=> {
  const input=fixture(); let terminated=0;
  const result=await analyzeStructureOffThread(input,{workerFactory:()=>({postMessage(){throw Error('blocked');},terminate(){terminated++;}})});
  assert.deepEqual(result,analyzeStructure(input)); assert.equal(terminated,1);
});
test('worker and cooperative fallback abort without returning partial structure',async()=> {
  const input=fixture(), fallback=new AbortController();
  await assert.rejects(analyzeStructureAsync(input,{signal:fallback.signal,maybeYield:async()=>fallback.abort()}),{name:'AbortError'});
  const controller=new AbortController(); let terminated=0;
  const pending=analyzeStructureOffThread(input,{signal:controller.signal,workerFactory:()=>({postMessage(){},terminate(){terminated++;}})});
  controller.abort(); await assert.rejects(pending,{name:'AbortError'}); assert.equal(terminated,1);
});
test('silent filter-bank frames cannot make a structural identity', async()=> {
  const input=fixture(); input.pitchFeatures.frames.forEach(f=>f.fill(0)); input.energyCurves.bands.forEach(b=>b.fill(0));
  assert.equal(analyzeStructure(input),null); assert.equal(await analyzeStructureAsync(input),null);
});
test('independent harmony and timbre changes expose persistent local boundary evidence', () => {
  const input=fixture(), result=analyzeStructure(input);
  const change=result.boundaryEvidence.find(e=>e.timeMs===120000);
  assert.ok(change.confidence>=.65); assert.ok(change.groups.harmony>.3); assert.ok(change.groups.timbre>.3);
  assert.equal(change.persistenceMs,120000); assert.equal(change.beforePersistenceMs,120000); assert.equal(result.boundaryEvidence[0].confidence,0);
});

test('actual analyzer-to-profile handoff includes the ending regime', () => {
  const input=fixture(), structure=analyzeStructure(input);
  const profile=buildSongProfile({ ...input, structure });
  assert.equal(profile.sections.length,structure.boundariesMs.length);
  assert.equal(profile.sections.at(-1).endMs,input.durationMs);
  assert.ok(profile.sections.at(-1).startMs>0);
});

test('successful module worker returns structure and releases its matrices', async () => {
  const input=fixture(); let terminated=0, payload;
  const worker={ postMessage(data) { payload=data; queueMicrotask(()=>this.onmessage({data:{ok:true,structure:analyzeStructure(input)}})); }, terminate(){ terminated++; } };
  const result=await analyzeStructureOffThread(input,{workerFactory:()=>worker});
  assert.deepEqual(result,analyzeStructure(input)); assert.equal(terminated,1);
  assert.equal(typeof payload.energyCurves.sampleAll,'undefined');
});

test('short fill return records twelve seconds of prior regime, not home duration', () => {
  const n=150,input=fixture(n);
  input.pitchFeatures.frames.forEach((f,i)=>{f.fill(0);f[i>=60&&i<66?28:24]=1;});
  for(let i=0;i<input.energyCurves.n;i++) input.energyCurves.setFrame(i,Array.from({length:7},(_,b)=>b===(i>=120&&i<132?5:1)?.8:.02));
  const structure=analyzeStructure({...input,minGapMs:4000,minGapPoints:2});
  const returning=structure?.boundaryEvidence.find(e=>e.timeMs===132000);
  assert.ok(returning); assert.equal(returning.beforePersistenceMs,12000); assert.ok(returning.persistenceMs>45000);
});
test('physical timbre survives worker serialization while activity remains flattened', async()=> {
  const input=fixture(), c=input.energyCurves;
  c.rmsBands=c.bands.map(b=>Float32Array.from(b)); c.bands.forEach(b=>b.fill(1));
  let payload;
  const worker={postMessage(data) {
    payload=data;
    const decoded={...data,energyCurves:Object.assign(new EnergyCurves(1),data.energyCurves)};
    queueMicrotask(()=>this.onmessage({data:{ok:true,structure:analyzeStructure(decoded)}}));
  },terminate(){}};
  const result=await analyzeStructureOffThread(input,{workerFactory:()=>worker});
  assert.ok(payload.energyCurves.rmsBands); assert.deepEqual(result,await analyzeStructureAsync(input));
  assert.ok(result.boundaryEvidence.find(e=>e.timeMs===120000).groups.timbre>.8);
});
test('nonzero downbeat producer covers the opening and restores from cache', () => {
  const input=fixture(); input.pointsMs=input.pointsMs.map(t=>t+200);
  const structure=analyzeStructure(input);
  const data={...input,structure,firstBarMs:200,barGrid:input.pointsMs.map(ms=>({ms,numerator:4,denominator:4})),timeline:[]};
  const profile=buildSongProfile(data);
  assert.equal(structure.boundariesMs[0],0); assert.equal(profile.sections[0].startMs,0);
  assert.ok(unpackBundle(packBundle({...data,songProfile:profile})));
});
