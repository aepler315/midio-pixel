import { sharedResidency } from './GraphicsResidency.js';
import { noteSyncWait } from './SyncWaits.js';

// Five nearest samples describe a smooth ramp or, where two contrasting
// neighbors bracket a mixed sample, the area of a contour inside its cell.
// `strength` is the slope gain validated on Classic+ at 720p (cells
// `referenceCell` output px wide): there a cell boundary keeps a step 1.8x
// the step inside a cell. cellStrength holds that ratio at any cell width.
export const CINEMATIC_CELLS = Object.freeze({ strength: .8, referenceCell: 3.2, edgeStart: .04, edgeEnd: .18, maxWidth: 3840, maxHeight: 2160 });
/** Boundary step over in-cell step on a reconstructed ramp: 1 + k(1-g)/g. */
export const CELL_RESIDUAL = 1 + CINEMATIC_CELLS.referenceCell * (1 - CINEMATIC_CELLS.strength) / CINEMATIC_CELLS.strength;
/** The slope gain for cells `k` output px wide that leaves CELL_RESIDUAL at
 *  every grid and output size (a fixed gain left wide cells, Classic or a
 *  4K export, with their boundaries standing out, and narrow ones blurred). */
export function cellStrength(k) {
  return Number.isFinite(k) && k > 0 ? k / (k + CELL_RESIDUAL - 1) : CINEMATIC_CELLS.strength;
}
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); };
const minmod = (a,b) => a*b > 0 ? Math.sign(a)*Math.min(Math.abs(a),Math.abs(b)) : 0;
const dot3 = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const diff3 = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];

// Project a unit square onto its edge normal. Its area distribution is a
// trapezoid: two triangular tails and a linear middle. Invert the source
// area to position the edge, then integrate the smaller output pixel box.
function contourCoverage(area, gx, gy, offset, footprint) {
  const sum = Math.abs(gx) + Math.abs(gy), nx = gx/sum, ny = gy/sum;
  const a = Math.max(Math.abs(nx), Math.abs(ny)), b = 1-a, q = Math.min(area, 1-area);
  const fromTip = 2*a*q < b ? Math.sqrt(2*a*b*q) : a*q + .5*b;
  const edge = Math.sign(.5-area) * (.5-fromTip);
  const d = nx*offset[0] + ny*offset[1] - edge;
  const wx = Math.abs(nx)*footprint[0], wy = Math.abs(ny)*footprint[1];
  const major = Math.max(wx,wy), minor = Math.min(wx,wy);
  const tail = Math.max(0, .5*(major+minor)-Math.abs(d));
  const away = tail < minor ? .5*tail*tail/(major*minor) : (tail-.5*minor)/major;
  return d < 0 ? away : 1-away;
}

/** Numerical reference for the GPU reconstruction, with straight RGBA 0..1. */
export function cinematicCellColor(center, left, right, down, up, offset, strength = CINEMATIC_CELLS.strength,
  footprint = [1/CINEMATIC_CELLS.referenceCell, 1/CINEMATIC_CELLS.referenceCell], freePixelMotion = true) {
  const subcell = freePixelMotion && Math.min(...footprint) < 1;
  if (center[3] < .999) {
    const ax = right[3]-left[3], ay = up[3]-down[3], alongX = Math.abs(ax) >= Math.abs(ay);
    const lo = alongX ? Math.min(left[3],right[3]) : Math.min(down[3],up[3]);
    const hi = alongX ? Math.max(left[3],right[3]) : Math.max(down[3],up[3]);
    if (subcell && lo <= .004 && hi-lo > .12 && lo < center[3] && center[3] < hi) {
      return [...center.slice(0,3), lo+(hi-lo)*contourCoverage((center[3]-lo)/(hi-lo),ax,ay,offset,footprint)];
    }
    return [...center];
  }
  if (subcell && Math.min(left[3], right[3], down[3], up[3]) >= .999) {
    const dx = diff3(right,left), dy = diff3(up,down), alongX = dot3(dx,dx) >= dot3(dy,dy);
    const lo = alongX ? left : down, delta = alongX ? dx : dy, span2 = dot3(delta,delta);
    if (span2 > .18**2) {
      const rel = diff3(center,lo), frac = dot3(rel,delta)/span2;
      if (frac > 0 && frac < 1) {
        const error = rel.map((v,i) => v-frac*delta[i]), tolerance = .0001+.003*span2;
        const confidence = smooth((span2-.18**2)/(.36**2-.18**2)) * (1-smooth(dot3(error,error)/tolerance));
        if (confidence > 0) {
          const coverage = contourCoverage(frac,dot3(dx,delta),dot3(dy,delta),offset,footprint);
          return [...center.slice(0,3).map((v,i) => Math.max(0,Math.min(1,v+confidence*(coverage-frac)*delta[i]))),center[3]];
        }
      }
    }
  }
  const compatible = c => (c[3] >= .999 ? 1 : 0) * (1-smooth((Math.hypot(...center.slice(0,3).map((v,i)=>v-c[i]))-CINEMATIC_CELLS.edgeStart)/(CINEMATIC_CELLS.edgeEnd-CINEMATIC_CELLS.edgeStart)));
  const gx = compatible(left)*compatible(right), gy = compatible(down)*compatible(up);
  return [...center.slice(0,3).map((v,i) => Math.max(0,Math.min(1,v + strength*(gx*minmod(v-left[i],right[i]-v)*offset[0]+gy*minmod(v-down[i],up[i]-v)*offset[1])))),center[3]];
}
const VERT = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const FRAG = `precision highp float;
  uniform sampler2D image; uniform vec2 size; uniform float strength; uniform vec2 footprint; varying vec2 uv;
  float compatibility(vec4 c,vec4 n){return step(.999,n.a)*(1.-smoothstep(${CINEMATIC_CELLS.edgeStart},${CINEMATIC_CELLS.edgeEnd},length(c.rgb-n.rgb)));}
  vec3 minmod(vec3 a,vec3 b){return step(vec3(0.00000001),a*b)*sign(a)*min(abs(a),abs(b));}
  float contourCoverage(float area,vec2 gradient,vec2 local){
    vec2 n=gradient/dot(abs(gradient),vec2(1.));
    float a=max(abs(n.x),abs(n.y)),b=1.-a,q=min(area,1.-area);
    float fromTip=2.*a*q<b?sqrt(2.*a*b*q):a*q+.5*b;
    float d=dot(n,local)-sign(.5-area)*(.5-fromTip);
    vec2 width=abs(n)*footprint;
    float major=max(width.x,width.y),minor=min(width.x,width.y);
    float tail=max(0.,.5*(major+minor)-abs(d));
    float away=tail<minor?.5*tail*tail/(major*minor):(tail-.5*minor)/major;
    return d<0.?away:1.-away;
  }
  void main(){
    vec2 p=uv*size, cell=floor(p), base=(cell+.5)/size, texel=1./size;
    vec4 c=texture2D(image,base);
    bool subcell=min(footprint.x,footprint.y)<1.;
    if(c.a>=.999 || (subcell && c.a>0.)){
      vec4 l=texture2D(image,base-vec2(texel.x,0.)),r=texture2D(image,base+vec2(texel.x,0.));
      vec4 d=texture2D(image,base-vec2(0.,texel.y)),u=texture2D(image,base+vec2(0.,texel.y));
      vec2 local=fract(p)-.5;
      if(c.a<.999){
        // A transparent neighbor and a covered neighbor bound a silhouette.
        // An isolated translucent mark, or a flat layer, keeps its alpha.
        vec2 grad=vec2(r.a-l.a,u.a-d.a);
        vec2 ends=abs(grad.x)>=abs(grad.y)?vec2(l.a,r.a):vec2(d.a,u.a);
        float lo=min(ends.x,ends.y),hi=max(ends.x,ends.y);
        if(lo<=.004 && hi-lo>.12 && c.a>lo && c.a<hi)
          c.a=mix(lo,hi,contourCoverage((c.a-lo)/(hi-lo),grad,local));
        gl_FragColor=vec4(c.rgb*c.a,c.a);return;
      }
      if(subcell && min(min(l.a,r.a),min(d.a,u.a))>=.999){
        // Test the strongest opposing palette pair. Perpendicular error in
        // RGB rejects a third hue at a junction or an independently lit mark.
        vec3 dx=r.rgb-l.rgb,dy=u.rgb-d.rgb;
        bool alongX=dot(dx,dx)>=dot(dy,dy);
        vec3 lo=alongX?l.rgb:d.rgb,delta=alongX?dx:dy;
        float span2=dot(delta,delta);
        if(span2>.0324){
          vec3 rel=c.rgb-lo;
          float fraction=dot(rel,delta)/span2;
          if(fraction>0. && fraction<1.){
            vec3 error=rel-fraction*delta;
            float confidence=smoothstep(.0324,.1296,span2)*(1.-smoothstep(0.,.0001+.003*span2,dot(error,error)));
            if(confidence>0.){
              float coverage=contourCoverage(fraction,vec2(dot(dx,delta),dot(dy,delta)),local);
              gl_FragColor=vec4(clamp(c.rgb+confidence*(coverage-fraction)*delta,0.,1.),c.a);return;
            }
          }
        }
      }
      vec3 gx=minmod(c.rgb-l.rgb,r.rgb-c.rgb)*compatibility(c,l)*compatibility(c,r);
      vec3 gy=minmod(c.rgb-d.rgb,u.rgb-c.rgb)*compatibility(c,d)*compatibility(c,u);
      c.rgb=clamp(c.rgb+strength*(gx*local.x+gy*local.y),0.,1.);
    }
    gl_FragColor=vec4(c.rgb*c.a,c.a);
  }`;
let nextPass=0;
/** Consecutive draws that never need the whole drawing buffer before it
 *  shrinks to what they used; also how many draws a denied growth is not
 *  retried for. */
export const CINEMATIC_BUFFER_SHRINK_DRAWS=120;
/** Draws after new GL objects, a new buffer or a restored context that still check gl.getError(). */
export const ERROR_CHECK_DRAWS=3;
/** Optional output-space pass. One native colour upload and five nearest taps.
 * Drawing-buffer and source-texture estimates share the scene residency budget.
 * Driver/context overhead remains outside these estimates, as for RangeScene.
 * Display and capture can ask for different output sizes in one frame (a
 * recording at encoder size). They share one context and one drawing buffer
 * grown to the union of those sizes; each draw renders into the buffer's
 * bottom-left w x h and copies that region out, so neither resizes it. */
export class CinematicPixelRenderer {
  constructor({ residency=sharedResidency(), makeCanvas=()=>document.createElement('canvas') }={}) {
    this.residency=residency; this.makeCanvas=makeCanvas; this.key=`cinematic-cells:${++nextPass}`;
    this.reason=null; this.bytes=0; this.failed=false; this.denied=null;
    this.bufW=this.bufH=this.srcW=this.srcH=0; this.peakW=this.peakH=this.underDraws=0;
    // gl.getError() flushes and waits for the GPU. It is checked on the first
    // draws after new GL objects, a new buffer or a restored context; steady
    // state relies on isContextLost() and exceptions.
    this.errorChecks=ERROR_CHECK_DRAWS;
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
      this.lost=false;this.failed=false;this.program=this.texture=this.buffer=null;this.errorChecks=ERROR_CHECK_DRAWS;
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
    this.strengthLocation=gl.getUniformLocation(this.program,'strength');
    this.footprintLocation=gl.getUniformLocation(this.program,'footprint');
    this.errorChecks=ERROR_CHECK_DRAWS;
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
  _releaseBuffer(){
    this.residency.release(this.key);this.bytes=0;
    this.bufW=this.bufH=this.srcW=this.srcH=0;this.peakW=this.peakH=this.underDraws=0;
  }
  /** Admit a drawing buffer that holds w x h for this source. Reallocates only
   *  to grow past the held buffer, for a new source size, or to shrink after
   *  CINEMATIC_BUFFER_SHRINK_DRAWS draws that never needed all of it. */
  _ensureBuffer(w,h,srcW,srcH){
    if(this.denied&&--this.denied.draws<=0)this.denied=null;
    const held=this.bufW>0&&!!this.residency.get(this.key);
    const covers=held&&srcW===this.srcW&&srcH===this.srcH&&w<=this.bufW&&h<=this.bufH;
    let bufW=w,bufH=h;
    if(covers){
      this.peakW=Math.max(this.peakW,w);this.peakH=Math.max(this.peakH,h);
      if(this.peakW>=this.bufW&&this.peakH>=this.bufH){this.peakW=this.peakH=this.underDraws=0;return true;}
      if(++this.underDraws<CINEMATIC_BUFFER_SHRINK_DRAWS)return true;
      bufW=this.peakW;bufH=this.peakH;
    }else if(held){
      bufW=Math.max(w,this.bufW);bufH=Math.max(h,this.bufH);
      // A growth denied moments ago is not retried every frame; the held
      // buffer keeps serving the draws it is big enough for.
      const d=this.denied;
      if(d&&bufW>=d.w&&bufH>=d.h&&srcW*srcH>=d.pixels){this.reason='allocation-denied';return false;}
    }
    const bytes=bufW*bufH*12+srcW*srcH*4+4096;
    if(held&&!this.residency.canFit(bytes-this.bytes)){
      if(covers){this.peakW=this.peakH=this.underDraws=0;return true;}
      this.denied={w:bufW,h:bufH,pixels:srcW*srcH,draws:CINEMATIC_BUFFER_SHRINK_DRAWS};
      this._releaseBuffer();this._deleteObjects();this.reason='allocation-denied';return false;
    }
    this._releaseBuffer();
    const reservation=this.residency.reserve({key:this.key,bytes,owner:'cinematic-cells',evictable:false});
    if(!reservation){this._deleteObjects();this.reason='allocation-denied';return false;}
    try{
      if(!this.gl)this._initialize();
      this.canvas.width=bufW;this.canvas.height=bufH;
      if(!this.residency.commit(reservation,this.canvas,canvas=>{canvas.width=canvas.height=0;}))throw Error('allocation-stale');
      this.bufW=bufW;this.bufH=bufH;this.srcW=srcW;this.srcH=srcH;this.bytes=bytes;this.errorChecks=ERROR_CHECK_DRAWS;
      return true;
    }catch(error){this.residency.releaseReservation(reservation);this.residency.release(this.key);this._deleteObjects();this.failed=true;this.reason=error.message;if(this.canvas)this.canvas.width=this.canvas.height=0;return false;}
  }
  draw(ctx,source,fit, outputScale=1, freePixelMotion=true, smoothPlacement=false) {
    if(this.disposed||this.failed||this.lost)return false;
    const scale=Math.min(outputScale,CINEMATIC_CELLS.maxWidth/fit.width,CINEMATIC_CELLS.maxHeight/fit.height);
    const w=Math.max(1,Math.round(fit.width*scale)),h=Math.max(1,Math.round(fit.height*scale));
    if(!this._ensureBuffer(w,h,source.width,source.height))return false;
    try{
      const gl=this.gl;if(gl.isContextLost()){this.reason='context-lost';return false;}
      if(!this.program)this._createObjects();
      gl.viewport(0,0,w,h);gl.useProgram(this.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.enableVertexAttribArray(this.position);gl.vertexAttribPointer(this.position,2,gl.FLOAT,false,0,0);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      // Cells as wide as they are drawn here (the capped output, if capped),
      // never as wide as the shared buffer.
      this.strength=cellStrength(w/source.width);
      gl.uniform2f(this.size,source.width,source.height);gl.uniform1f(this.strengthLocation,this.strength);
      gl.uniform2f(this.footprintLocation,freePixelMotion?source.width/w:1,freePixelMotion?source.height/h:1);
      gl.drawArrays(gl.TRIANGLES,0,3);
      // getError (first draws only) and the copy below wait for the GPU: timed as one wait.
      const waitStart=performance.now();
      if(this.errorChecks>0){this.errorChecks--;if(gl.getError()!==gl.NO_ERROR){noteSyncWait('presenter',performance.now()-waitStart);this.reason='draw-failed';return false;}}
      // GL's origin is bottom-left: the viewport is the canvas's bottom rows.
      // Copied in the same task, so the unpreserved buffer is still intact.
      // Reconstruction already happened at display resolution. A translated
      // or rolled terrain layer can now carry fractional device-pixel coverage.
      ctx.imageSmoothingEnabled=smoothPlacement && scale === 1;
      ctx.drawImage(this.canvas,0,this.canvas.height-h,w,h,fit.x,fit.y,fit.width,fit.height);
      noteSyncWait('presenter',performance.now()-waitStart);
      this.reason=null;return true;
    }catch(error){this.reason=error.message;return false;}
  }
  suspend(){
    this.denied=null;
    if(this.disposed || (!this.bytes && !this.program && !this.texture && !this.buffer && !this.bufW))return;
    this._releaseBuffer();this._deleteObjects();
    // Keep one idle context for quality/mode round trips; intentional context
    // loss is observable as a real renderer failure to clients and diagnostics.
    if(this.canvas)this.canvas.width=this.canvas.height=0;
  }
  dispose(){if(this.disposed)return;this.suspend();this.disposed=true;this.canvas=null;this.gl=null;}
}
