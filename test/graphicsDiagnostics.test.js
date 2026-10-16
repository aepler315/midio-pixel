import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicsReport, shaderFailureLog } from '../src/render/GraphicsDiagnostics.js';

test('shader diagnostics retain the native compiler error when the link log is generic', () => {
  const gl={getProgramInfoLog:()=> 'Fragment shader is not compiled.',getAttachedShaders:()=>[1,2],
    getShaderInfoLog:s=>s===2?'ERROR: 0:172: too many uniforms':''};
  assert.match(shaderFailureLog(gl,{}),/0:172: too many uniforms/);
});
test('shader diagnostics stay bounded and tolerate a lost context', () => {
  assert.ok(shaderFailureLog({getProgramInfoLog:()=> 'x'.repeat(10000)},{}).length<=768);
  assert.equal(shaderFailureLog({getProgramInfoLog(){throw Error('lost');}},{}),'program link failed');
});
test('verbose successful-shader warnings cannot displace the failed compiler error', () => {
  const gl={COMPILE_STATUS:1,getProgramInfoLog:()=> 'not compiled',getAttachedShaders:()=>[1,2],
    getShaderParameter:s=>s===1,getShaderInfoLog:s=>s===1?'warning '.repeat(500):'ERROR: native fragment failure'};
  assert.match(shaderFailureLog(gl,{}),/ERROR: native fragment failure/);
});
test('a graphics report distinguishes loading, permanent fallback and active v2 without song data', () => {
  const range={active:false,mode:'v2',reason:'shader: native error',runtime:'ready',failures:{view:'native error'},
    scene:{pending:[],prepared:[],contextLost:false},residency:{budget:'mobile',denials:3},privateTrack:'/personal/audio.wav'};
  const report=graphicsReport({range,profile:{look:'pixel'},canvas:{width:320,height:180},env:{navigator:{userAgent:'Android Chrome',maxTouchPoints:5},devicePixelRatio:3,location:{href:'secret-url'}}});
  assert.equal(report.range.reason,range.reason);assert.equal(report.range.residency.denials,3);
  assert.equal(report.device.touchPoints,5);assert.equal(report.device.dpr,3);
  assert.equal(JSON.stringify(report).includes('personal'),false);assert.equal(JSON.stringify(report).includes('secret-url'),false);
  assert.equal(graphicsReport({range:{...range,reason:'preparing',scene:{pending:['view']}}}).range.reason,'preparing');
  assert.equal(graphicsReport({range:{...range,active:true,reason:null}}).range.active,true);
});
test('reporting before playback or after context loss never creates a graphics context', () => {
  assert.equal(graphicsReport().range,null);
  const gl={isContextLost:()=>true,getParameter(){throw Error('lost');}};
  assert.equal(graphicsReport({gl}).gpu.contextLost,true);
});
