import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engines,startUIFixture} from './ui-fixture.mjs';
const fixture=await startUIFixture();
try{
  // Synthetic 160x90 H.264 baseline/yuv420p, six seconds, white half-frame after
  // 4.1 seconds. No real user media. A tiny faststart fixture avoids recorder timing.
  const video={type:'video/mp4',bytes:[...readFileSync(new URL('./fixtures/video-quality-late-scene.mp4',import.meta.url))]};
  for(const [name,engine,launch] of engines){
    const browser=await engine.launch({headless:true,...launch});
    try{
      const page=await browser.newPage();await page.goto(fixture.origin+'/cloud/');
      const result=await page.evaluate(async video=>{
        const seeks=[],property=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');let duration=0;
        Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...property,set(value){seeks.push(value);duration=this.duration;property.set.call(this,value);}});
        const supported=!!document.createElement('video').canPlayType(video.type);
        if(!supported)return {supported,type:video.type};
        const url=URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type}));
        try{
          const blob=await TCloudUI.recoverVideoThumbnail(url,new AbortController().signal);
          if(!blob)return {supported,present:false,seeks,duration};
          const decoded=await TCloudUI.decodeThumbnail(blob);const quality=TCloudUI.videoFrameQuality(decoded.image);URL.revokeObjectURL(decoded.url);
          return {supported,present:true,quality,seeks,duration,type:video.type};
        }catch(error){
          // Separate an unavailable platform decoder from a selector regression.
          const control=document.createElement('video');control.muted=true;
          const controlError=await new Promise(resolve=>{
            const timer=setTimeout(()=>resolve(0),5000);
            control.onloadeddata=()=>{clearTimeout(timer);resolve(0);};
            control.onerror=()=>{clearTimeout(timer);resolve(control.error?.code||0);};
            control.src=url;control.load();
          });
          control.removeAttribute('src');control.load();
          return {supported,nativeError:true,controlError,type:video.type};
        }finally{URL.revokeObjectURL(url);Object.defineProperty(HTMLMediaElement.prototype,'currentTime',property);}
      },video);
      if(!result.supported){console.log('UNAVAILABLE native codec',name,result);continue;}
      if(result.nativeError){assert.ok([3,4].includes(result.controlError));console.log('UNAVAILABLE native decoder; plain video control also rejects valid fixture',name,result);continue;}
      assert.equal(result.present,true);assert.equal(result.quality.accepted,true);assert.ok(result.seeks.length<=5);
      assert.ok(Math.abs(result.seeks.at(-1)/result.duration-.75)<.02);
      console.log('PASS native video first visible scene at 75 percent',name,result);
    }finally{await browser.close();}
  }
}finally{await fixture.close();}
