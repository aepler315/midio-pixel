import { sharedResidency } from './GraphicsResidency.js';

// Reconstruction is deliberately conservative: nearest coverage owns the cell;
// only a monotone, low-contrast colour slope can vary inside it. No history,
// pixel jitter, frame readback or interpolation of alpha/silhouette geometry.
export const CINEMATIC_CELLS = Object.freeze({ strength: .8, edgeStart: .04, edgeEnd: .18, maxWidth: 3840, maxHeight: 2160 });
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); };
const minmod = (a,b) => a*b > 0 ? Math.sign(a)*Math.min(Math.abs(a),Math.abs(b)) : 0;
/** Numerical reference for the GPU reconstruction, with straight RGBA 0..1. */
export function cinematicCellColor(center, left, right, down, up, offset) {
  if (center[3] < .999) return [...center];
  const compatible = c => (c[3] >= .999 ? 1 : 0) * (1-smooth((Math.hypot(...center.slice(0,3).map((v,i)=>v-c[i]))-CINEMATIC_CELLS.edgeStart)/(CINEMATIC_CELLS.edgeEnd-CINEMATIC_CELLS.edgeStart)));
  const gx = compatible(left)*compatible(right), gy = compatible(down)*compatible(up);
  return [...center.slice(0,3).map((v,i) => Math.max(0,Math.min(1,v + CINEMATIC_CELLS.strength*(gx*minmod(v-left[i],right[i]-v)*offset[0]+gy*minmod(v-down[i],up[i]-v)*offset[1])))),center[3]];
}
const VERT = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const FRAG = `precision highp float;
  uniform sampler2D image; uniform vec2 size; varying vec2 uv;
  float compatibility(vec4 c,vec4 n){return step(.999,n.a)*(1.-smoothstep(${CINEMATIC_CELLS.edgeStart},${CINEMATIC_CELLS.edgeEnd},length(c.rgb-n.rgb)));}
  vec3 minmod(vec3 a,vec3 b){return step(vec3(0.00000001),a*b)*sign(a)*min(abs(a),abs(b));}
  void main(){
    vec2 p=uv*size, cell=floor(p), base=(cell+.5)/size, texel=1./size;
    vec4 c=texture2D(image,base);
    vec3 rgb=c.rgb;
    if(c.a>=.999){
      vec4 l=texture2D(image,base-vec2(texel.x,0.)),r=texture2D(image,base+vec2(texel.x,0.));
      vec4 d=texture2D(image,base-vec2(0.,texel.y)),u=texture2D(image,base+vec2(0.,texel.y));
      vec2 local=fract(p)-.5;
      vec3 gx=minmod(c.rgb-l.rgb,r.rgb-c.rgb)*compatibility(c,l)*compatibility(c,r);
      vec3 gy=minmod(c.rgb-d.rgb,u.rgb-c.rgb)*compatibility(c,d)*compatibility(c,u);
      rgb=clamp(rgb+${CINEMATIC_CELLS.strength}*(gx*local.x+gy*local.y),0.,1.);
    }
    gl_FragColor=vec4(rgb*c.a,c.a);
  }`;
let nextPass=0;
/** Optional output-space pass. One native colour upload and five nearest taps.
 * Drawing-buffer and source-texture estimates share the scene residency budget.
 * Driver/context overhead remains outside these estimates, as for RangeScene. */
export class CinematicPixelRenderer {
  constructor({ residency=sharedResidency(), makeCanvas=()=>document.createElement('canvas') }={}) {
    this.residency=residency; this.makeCanvas=makeCanvas; this.key=`cinematic-cells:${++nextPass}`;
    this.reason=null; this.bytes=0; this.signature=null; this.failed=false;
  }
  _initialize() {
    this.canvas=this.makeCanvas();
    const gl=this.canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
    if(!gl) throw Error('webgl-unavailable');
    this.gl=gl;
    this.canvas.addEventListener?.('webglcontextlost',event=>{event.preventDefault();this.lost=true;this.reason='context-lost';});
    this.canvas.addEventListener?.('webglcontextrestored',()=>{
      // Restored contexts cannot delete handles from their previous epoch.
      // Forget them; the next draw recreates this context's own objects.
      this.lost=false;this.failed=false;this.program=this.texture=this.buffer=null;
    });
    this._createObjects();
  }
  _createObjects() {
    const gl=this.gl;
    const compile=(type,source)=>{
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);throw Error('shader-compile');}return shader;
    };
    let vertex,fragment;
    try {
      vertex=compile(gl.VERTEX_SHADER,VERT);fragment=compile(gl.FRAGMENT_SHADER,FRAG);
      this.program=gl.createProgram();gl.attachShader(this.program,vertex);gl.attachShader(this.program,fragment);gl.linkProgram(this.program);
      if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error('shader-link');
    } finally {if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);}
    this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);
    for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,axis,gl.CLAMP_TO_EDGE);
    for(const filter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,filter,gl.NEAREST);
    this.position=gl.getAttribLocation(this.program,'position');this.size=gl.getUniformLocation(this.program,'size');
  }
  _deleteObjects(){
    const gl=this.gl;if(!gl)return;
    // Deleting a current program defers its retirement until it is unbound.
    gl.useProgram(null);gl.bindTexture(gl.TEXTURE_2D,null);gl.bindBuffer(gl.ARRAY_BUFFER,null);
    if(this.program)gl.deleteProgram(this.program);
    if(this.texture)gl.deleteTexture(this.texture);
    if(this.buffer)gl.deleteBuffer(this.buffer);
    this.program=this.texture=this.buffer=null;
  }
  draw(ctx,source,fit) {
    if(this.disposed||this.failed||this.lost)return false;
    const scale=Math.min(1,CINEMATIC_CELLS.maxWidth/fit.width,CINEMATIC_CELLS.maxHeight/fit.height);
    const w=Math.max(1,Math.round(fit.width*scale)),h=Math.max(1,Math.round(fit.height*scale));
    const signature=`${w}:${h}:${source.width}:${source.height}`;
    if(signature!==this.signature || !this.residency.get(this.key)){
      this.residency.release(this.key);this.bytes=0;this.signature=null;
      const bytes=w*h*12+source.width*source.height*4+4096;
      const reservation=this.residency.reserve({key:this.key,bytes,owner:'cinematic-cells',evictable:false});
      if(!reservation){this._deleteObjects();this.reason='allocation-denied';return false;}
      try{
        if(!this.gl)this._initialize();
        this.canvas.width=w;this.canvas.height=h;
        if(!this.residency.commit(reservation,this.canvas,canvas=>{canvas.width=canvas.height=0;}))throw Error('allocation-stale');
        this.signature=signature;this.bytes=bytes;
      }catch(error){this.residency.releaseReservation(reservation);this.residency.release(this.key);this._deleteObjects();this.failed=true;this.reason=error.message;if(this.canvas)this.canvas.width=this.canvas.height=0;return false;}
    }
    try{
      const gl=this.gl;if(gl.isContextLost()){this.reason='context-lost';return false;}
      if(!this.program)this._createObjects();
      gl.viewport(0,0,w,h);gl.useProgram(this.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.enableVertexAttribArray(this.position);gl.vertexAttribPointer(this.position,2,gl.FLOAT,false,0,0);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      gl.uniform2f(this.size,source.width,source.height);gl.drawArrays(gl.TRIANGLES,0,3);
      if(gl.getError()!==gl.NO_ERROR){this.reason='draw-failed';return false;}
      ctx.imageSmoothingEnabled=false;ctx.drawImage(this.canvas,fit.x,fit.y,fit.width,fit.height);
      this.reason=null;return true;
    }catch(error){this.reason=error.message;return false;}
  }
  suspend(){
    if(this.disposed || (!this.bytes && !this.program && !this.texture && !this.buffer && !this.signature))return;
    this.residency.release(this.key);this.bytes=0;this.signature=null;this._deleteObjects();
    // Keep one idle context for quality/mode round trips; intentional context
    // loss is observable as a real renderer failure to clients and diagnostics.
    if(this.canvas)this.canvas.width=this.canvas.height=0;
  }
  dispose(){if(this.disposed)return;this.suspend();this.disposed=true;this.canvas=null;this.gl=null;}
}
