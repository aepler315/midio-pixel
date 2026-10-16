// Find the placement ring using a separate terrain-only diagnostic draw.
// Read luminance from the original, untinted stage; the diagnostic cannot
// change that saved image. It uses the production terrain vertex and mask.
export function outputToScenicPixel(viewport, x, y) {
  const [a,b,c,d,e,f] = viewport.transform, determinant = a*d-b*c;
  const logicalX = (d*(x-e)-c*(y-f))/determinant;
  const logicalY = (-b*(x-e)+a*(y-f))/determinant;
  return [Math.floor(logicalX/viewport.logicalWidth*viewport.backingWidth),
    Math.floor(logicalY/viewport.logicalHeight*viewport.backingHeight)];
}

export async function measureForestRingTone(page, crop) {
  // Tools are outside the public source tree. Expose just the tested pure
  // mapping function to this diagnostic page through the harness route.
  await page.route('**/tools/lib/forest-ring-tone.mjs', route => route.fulfill({
    contentType: 'text/javascript', body: `export ${outputToScenicPixel.toString()}`,
  }));
  return page.evaluate(async crop => {
    const scene=window.__SMW.sim.biomes.rangePresentation.scene, T=scene.THREE;
    const viewport=window.__SMW.sim.biomes.rangePresentation.frame.scenicViewport;
    const { outputToScenicPixel }=await import('/tools/lib/forest-ring-tone.mjs');
    const p=[...scene.prepared.values()].find(p=>p.windowCache);
    const { SCENE_VERT,SCENE_FRAG }=await import('/src/world/alpine/TerrainMaterial.js');
    const stage=document.querySelector('#stage'), canvas=document.createElement('canvas');
    canvas.width=stage.width; canvas.height=stage.height;
    canvas.getContext('2d').drawImage(stage,0,0);
    const original=canvas.getContext('2d').getImageData(0,0,stage.width,stage.height).data;
    const start=p.windowIndex*8000,end=Math.min(p.view.tour.durationMs,start+8000);
    const rail=Array.from({length:17},(_,i)=>p.view.tour.poseAt(start+(end-start)*i/16).eyeM);
    const constants=rail.map((v,i)=>`const vec3 rail${i}=vec3(${v.map(x=>Number(x).toFixed(8)).join(',')});`).join('\n');
    const segments=rail.slice(1).map((_,i)=>`d=min(d,segmentDistance(rail${i},rail${i+1},vWorld));`).join('\n');
    const funcs=`${constants}
      float segmentDistance(vec3 a,vec3 b,vec3 p){vec3 ab=b-a;float t=clamp(dot(p-a,ab)/max(dot(ab,ab),.00001),0.,1.);return length(p-a-t*ab);}`;
    const fragment=SCENE_FRAG.replace('  void main() {', `${funcs}\n  void main() {`).replace('      float snowLine =',
      `float d=1.e9; ${segments} float q=floor(clamp(d/20000.,0.,1.)*65535.+.5);
        outColor=vec4(floor(q/256.)/255.,mod(q,256.)/255.,forest,1.);return;
        float snowLine =`);
    const material=new T.ShaderMaterial({glslVersion:T.GLSL3,vertexShader:SCENE_VERT,fragmentShader:fragment,uniforms:p.uniforms});
    const diagnostic=new T.Scene();
    for(const band of Object.values(p.scenes)) for(const mesh of band.children) if(mesh.material===p.material) {
      const m=new T.Mesh(mesh.geometry,material);m.frustumCulled=false;diagnostic.add(m);
    }
    const width=viewport.backingWidth,height=viewport.backingHeight;
    const target=new T.WebGLRenderTarget(width,height), bytes=new Uint8Array(width*height*4);
    const r=scene.renderer,previous=r.getRenderTarget(),mask=scene.camera.layers.mask,auto=r.autoClear;
    try {
      scene.camera.layers.set(0);r.autoClear=true;r.setRenderTarget(target);r.setClearColor(0,0);
      r.render(diagnostic,scene.camera);r.readRenderTargetPixels(target,0,0,width,height,bytes);
    } finally { r.setRenderTarget(previous);r.autoClear=auto;scene.camera.layers.mask=mask;material.dispose();target.dispose(); }
    const inside=[],outside=[];
    for(let y=crop.y;y<crop.y+crop.height;y+=2) for(let x=crop.x;x<crop.x+crop.width;x+=2) {
      // Invert the exact Canvas transform used by RangePresentation's copy.
      // Nearest diagnostic samples avoid interpolating packed distance bytes.
      const [sx,sy]=outputToScenicPixel(viewport,x+.5,y+.5);
      if(sx<0||sy<0||sx>=width||sy>=height)continue;
      const i=((height-1-sy)*width+sx)*4;
      if(bytes[i+3]<250 || bytes[i+2]<.35*255)continue;
      const distance=(bytes[i]*256+bytes[i+1])/65535*20000;
      const group=distance>=7500&&distance<8000?inside:distance>=8000&&distance<=8500?outside:null;
      if(group){const k=(y*stage.width+x)*4;group.push({x,y,distance,luma:.2126*original[k]+.7152*original[k+1]+.0722*original[k+2]});}
    }
    const mean=a=>a.length?a.reduce((s,v)=>s+v.luma,0)/a.length:null;
    const a=mean(inside),b=mean(outside),differencePercent=a&&b?Math.abs(b/a-1)*100:null;
    return { crop,forestDebug:false,windowIndex:p.windowIndex,rangeM:[7500,8000,8500],maskMinimum:.35,
      scenicViewport:viewport,
      method:'Terrain-only production vertex/mask draw at scenic backing dimensions locates distance to the same 17 rail chords. Output pixel centers invert the production Canvas transform including overscan, zoom, shake and roll; nearest diagnostic samples preserve packed distance bytes. Brightness comes from the original untinted stage at a two-pixel stride.',
      inside:{count:inside.length,meanLuminance:a,pixels:inside},outside:{count:outside.length,meanLuminance:b,pixels:outside},differencePercent,
      pass:differencePercent!=null&&inside.length>=64&&outside.length>=64&&differencePercent<=5 };
  },crop);
}
