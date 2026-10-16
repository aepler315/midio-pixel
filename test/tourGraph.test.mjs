import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TourGraph } from '../src/world/terrain/TourGraph.js';
function fixture() {
 const nodes = [{id:'a',posM:[0,0]},{id:'b',posM:[0,-4000]},{id:'c',posM:[4000,-4000]}];
 const edges = [['a','b'],['b','c']].map(([a,b],i)=>{const x=nodes.find(n=>n.id===a).posM,y=nodes.find(n=>n.id===b).posM;return{id:`e${i}`,a,b,kind:'road',lengthM:4000,samples:[...Array(161)].map((_,j)=>[x[0]+(y[0]-x[0])*j/160,x[1]+(y[1]-x[1])*j/160,100,1500])}});
 return {nodes,edges};
}
test('graph shortest paths use oriented roads and circular 400m junction fillets',()=>{
 const graph=new TourGraph(fixture());const path=graph.shortestPath('a','c');
 assert.ok(path.lengthM<8000 && path.lengthM>7600);
 assert.equal(path.steps.length,2);assert.equal(path.fillets.length,1);
 assert.equal(path.fillets[0].radiusM,400);
 assert.deepEqual(path.samples[0].slice(0,2),[0,0]);assert.deepEqual(path.samples.at(-1).slice(0,2),[4000,-4000]);
 for(const p of path.samples)assert.ok(p.every(Number.isFinite));
 assert.deepEqual(graph.shortestPath('a','c'),path);
});
test('reversed routes preserve length and do not invent off-road shortcuts',()=>{
 const g=new TourGraph(fixture()),a=g.shortestPath('a','c'),b=g.shortestPath('c','a');
 assert.ok(Math.abs(a.lengthM-b.lengthM)<.001);assert.equal(g.shortestPath('a','missing'),null);
 assert.deepEqual(g.shortestPath('a','a').samples[0].slice(0,2),[0,0]);
});

test('incoming orientation constrains the first turn of the next route',()=>{
 const g=new TourGraph(fixture()),path=g.shortestPath('a','b');
 const onward=g.shortestPath('b','c',{incoming:path.steps.at(-1)});
 assert.ok(onward.startFillet?.trimM>0);
 assert.equal(g.shortestPath('b','a',{incoming:path.steps.at(-1)}),null);
});
