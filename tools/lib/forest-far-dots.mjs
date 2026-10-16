// Separate terrain-only draw; never tint or recrop the saved production frame.
import { outputToScenicPixel } from './forest-ring-tone.mjs';

export async function measureForestFarDots(page) {
  await page.route('**/tools/lib/forest-far-dots-map.mjs',route=>route.fulfill({
    contentType:'text/javascript',body:`export ${outputToScenicPixel.toString()}`,
  }));
  return page.evaluate(async()=>{
    const pres=window.__SMW.sim.biomes.rangePresentation,scene=pres.scene,T=scene.THREE;
    const p=[...scene.prepared.values()].find(p=>p.windowCache);
    const viewport=pres.frame.scenicViewport,stage=document.querySelector('#stage');
    const {outputToScenicPixel}=await import('/tools/lib/forest-far-dots-map.mjs');
    const {SCENE_VERT,SCENE_FRAG}=await import('/src/world/alpine/TerrainMaterial.js');
    const marker='      // Two snow scales';
    if(!SCENE_FRAG.includes(marker))throw Error('Production far-dot diagnostic marker missing');
    const fragment=SCENE_FRAG.replace(marker,`
      float packed=floor(clamp(forestDist/20000.,0.,1.)*65535.+.5);
      outColor=vec4(floor(packed/256.)/255.,mod(packed,256.)/255.,habitat,cover*dotCrownWeight);return;
      ${marker}`);
    const width=viewport.backingWidth,height=viewport.backingHeight;
    const target=new T.WebGLRenderTarget(width,height),bytes=new Uint8Array(width*height*4);
    const renderer=scene.renderer,previous=renderer.getRenderTarget(),mask=scene.camera.layers.mask;
    const auto=renderer.autoClear,clear=renderer.getClearColor(new T.Color()),alpha=renderer.getClearAlpha();
    const oldViewport=renderer.getViewport(new T.Vector4()),oldScissor=renderer.getScissor(new T.Vector4()),scissorTest=renderer.getScissorTest();
    const draw=negative=>{
      // Reproduce the rejected four-slab/isotropic eligibility as a negative
      // control. Profile, traits, terrain, camera and pixel mapping stay fixed.
      const reachLine='float reach=(bound/max(rise,.00001)+along)*major+2.*(farCrownRadius(bound)+max(.5*side,.001))*minor;';
      if(!fragment.includes(reachLine))throw Error('Far-dot negative control reach marker missing');
      const code=negative?fragment.replace(reachLine,
        'side=length(abs(dx)+abs(dy));float reach=bound/max(rise,.00001);')
        .replace('return vec4(side,along*max(rise,0.),reach,rise);','return vec4(side,0.,reach,rise);'):fragment;
      const material=new T.ShaderMaterial({glslVersion:T.GLSL3,vertexShader:SCENE_VERT,fragmentShader:code,uniforms:p.uniforms});
      material.defines={...p.material.defines,...(negative?{FAR_FOREST_KMAX:4}:{})};
      const diagnostic=new T.Scene();
      for(const band of Object.values(p.scenes))for(const mesh of band.children)if(mesh.material===p.material){
        const m=new T.Mesh(mesh.geometry,material);m.frustumCulled=false;diagnostic.add(m);
      }
      try{
        renderer.setRenderTarget(target);renderer.setScissorTest(false);renderer.setViewport(0,0,width,height);
        renderer.autoClear=true;renderer.setClearColor(0,0);scene.camera.layers.set(0);
        renderer.render(diagnostic,scene.camera);renderer.readRenderTargetPixels(target,0,0,width,height,bytes);
        const bands=[8000,10000,12000].map(start=>({startM:start,endM:start+2000,samples:0,active:0,coverageSum:0,maxCoverage:0}));
        let beyond15kmActive=0;
        for(let y=0;y<stage.height;y+=2)for(let x=0;x<stage.width;x+=2){
          const [sx,sy]=outputToScenicPixel(viewport,x+.5,y+.5);
          if(sx<0||sy<0||sx>=width||sy>=height)continue;
          const i=((height-1-sy)*width+sx)*4;
          if(bytes[i+2]<.1*255)continue;
          const distance=(bytes[i]*256+bytes[i+1])/65535*20000,coverage=bytes[i+3]/255;
          if(distance>=15000&&coverage>0)beyond15kmActive++;
          const band=bands.find(b=>distance>=b.startM&&distance<b.endM);
          if(band){band.samples++;band.active+=coverage>0;band.coverageSum+=coverage;band.maxCoverage=Math.max(band.maxCoverage,coverage);}
        }
        return {bands,active:bands.reduce((n,b)=>n+b.active,0),beyond15kmActive};
      }finally{material.dispose();}
    };
    let production,negative;
    try{production=draw(false);negative=draw(true);}
    finally{
      renderer.setRenderTarget(previous);renderer.autoClear=auto;scene.camera.layers.mask=mask;
      renderer.setClearColor(clear,alpha);renderer.setViewport(oldViewport);renderer.setScissor(oldScissor);renderer.setScissorTest(scissorTest);target.dispose();
    }
    return {timeMs:window.__SMW.sim.heardTimeMs,windowIndex:p.windowIndex,forestDebug:false,scenicViewport:viewport,
      source:'Production terrain vertex/fragment, lattice painter, uniforms and draw camera. Separate RGBA8 target packs camera distance, habitat and painted canopy contribution; original stage PNG stays unchanged.',
      samplingStride:2,habitatMinimum:.1,production,negative,
      pass:production.active>=64&&production.beyond15kmActive===0&&production.active>negative.active};
  });
}
