(function (global) {
  "use strict";
  const BASE = "/cloud/vendor/libav/";
  const VERSION = "6.7.7.1.1";
  const BLOCK = 1024 * 1024;
  const READ_LIMIT = 32 * BLOCK;
  const modules = new Map();
  async function moduleFor(variant) {
    if (!modules.has(variant)) modules.set(variant, import(`${BASE}libav-${VERSION}-${variant}.mjs`).catch(error => { modules.delete(variant); throw error; }));
    return (await modules.get(variant)).default;
  }
  function frameCanvas(frame) {
    // These legacy decoders output planar 8-bit YUV. Convert only a thumbnail,
    // rather than allocating an RGBA copy of the full decoded video frame.
    if (![0,4,5,12,13,14].includes(frame.format) || frame.layout?.length !== 3) return null;
    const crop = frame.crop || {}, left=crop.left||0, top=crop.top||0;
    const width=frame.width-left-(crop.right||0), height=frame.height-top-(crop.bottom||0);
    if (width<=0 || height<=0) return null;
    const sar=frame.sample_aspect_ratio, ratio=sar?.[0]>0&&sar?.[1]>0?sar[0]/sar[1]:1;
    const displayWidth=width*Math.min(10,Math.max(.1,ratio)), scale=Math.min(1,640/Math.max(displayWidth,height)), canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(displayWidth*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const context=canvas.getContext("2d",{alpha:false}), image=context.createImageData(canvas.width,canvas.height);
    const full=frame.format>=12, horizontal=[5,14].includes(frame.format)?1:2, vertical=[0,12].includes(frame.format)?2:1;
    const [yp,up,vp]=frame.layout, data=frame.data;
    for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
      const sx=left+Math.min(width-1,Math.floor(x*width/canvas.width)), sy=top+Math.min(height-1,Math.floor(y*height/canvas.height));
      const yy=data[yp.offset+sy*yp.stride+sx], u=data[up.offset+Math.floor(sy/vertical)*up.stride+Math.floor(sx/horizontal)]-128;
      const v=data[vp.offset+Math.floor(sy/vertical)*vp.stride+Math.floor(sx/horizontal)]-128, i=(y*canvas.width+x)*4;
      const l=full?yy:1.164*(yy-16);
      image.data[i]=l+(full?1.402:1.596)*v;
      image.data[i+1]=l-(full?.344:.392)*u-(full?.714:.813)*v;
      image.data[i+2]=l+(full?1.772:2.017)*u;image.data[i+3]=255;
    }
    context.putImageData(image,0,0);return canvas;
  }
  async function recover(url, file, signal, onDuration) {
    const localFile=file instanceof Blob ? file : null;
    const source=new URL(url,location.href);
    // Network reads must terminate at the existing device-only SW gateway.
    // Never use a remote URL, a direct API URL, or a proxy for plaintext video.
    if (!localFile && (source.origin!==location.origin || !source.pathname.startsWith("/cloud/local-media/"))) return null;
    const ext=String(file.name||"").split(".").pop().toLowerCase();
    const format=["wmv","asf"].includes(ext)?"asf":["mp4","m4v","mov"].includes(ext)?"mp4":null;
    const size=Number(localFile?.size||file.sizeBytes);
    if (!format || !Number.isSafeInteger(size) || size<=0 || signal?.aborted) return null;
    const controller=new AbortController(), instances=new Set();
    let cache=null, cacheStart=0, readBytes=0, finished=false;
    const aborted=()=>controller.abort();signal?.addEventListener("abort",aborted,{once:true});
    const timeout=setTimeout(aborted,45000);
    const check=()=>{if(controller.signal.aborted||finished)throw new DOMException("Thumbnail cancelled","AbortError");};
    const stop=new Promise((_,reject)=>controller.signal.addEventListener("abort",()=>reject(new DOMException("Thumbnail cancelled","AbortError")),{once:true}));
    async function instance(variant) {
      check();const mod=await moduleFor(variant);check();
      const value=await mod.LibAV({nothreads:true});
      if(controller.signal.aborted||finished){value.terminate();check();}
      instances.add(value);await value.av_log_set_level?.(8);return value;
    }
    const work=(async()=>{
      const demux=await instance(`demuxer-${format}`);
      demux.onblockread=async(name,pos,length)=>{
        check();
        if(pos>=size){await demux.ff_block_reader_dev_send(name,pos,new Uint8Array());return;}
        if(!cache || pos<cacheStart || pos>=cacheStart+cache.length){
          cache?.fill(0);cache=null;cacheStart=Math.floor(pos/BLOCK)*BLOCK;
          const end=Math.min(size,cacheStart+BLOCK);
          if(readBytes+end-cacheStart>READ_LIMIT)throw new Error("Thumbnail read limit");
          if(localFile)cache=new Uint8Array(await localFile.slice(cacheStart,end).arrayBuffer());
          else {
            const response=await fetch(url,{headers:{Range:`bytes=${cacheStart}-${end-1}`},credentials:"same-origin",cache:"no-store",signal:controller.signal});
            check();if(response.status!==206)throw new Error("Thumbnail range unavailable");
            const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range")||"");
            if(!range || Number(range[1])!==cacheStart || Number(range[2])!==end-1 || Number(range[3])!==size)throw new Error("Thumbnail range mismatch");
            cache=new Uint8Array(await response.arrayBuffer());
            if(cache.length!==end-cacheStart)throw new Error("Thumbnail range length");
          }
          check();readBytes+=cache.length;
        }
        await demux.ff_block_reader_dev_send(name,pos,cache.slice(pos-cacheStart,pos-cacheStart+Math.max(length,65536)));
      };
      await demux.mkblockreaderdev("input",size);check();
      const [context,streams]=await demux.ff_init_demuxer_file("input");check();
      const stream=streams.find(item=>item.codec_type===0);if(!stream)return null;
      // The modular frontend omits this helper from its generated shortcuts;
      // use the same worker RPC used by those shortcuts, keeping work off-thread.
      const par=await demux.c("ff_copyout_codecpar",stream.codecpar);check();
      const codec=({12:"mpeg4",17:"wmv1",18:"wmv2",71:"wmv3"})[par.codec_id];
      file.thumbnailCodec=codec||`codec-${par.codec_id}`;
      if(!codec || !par.width || !par.height || par.width*par.height>3840*2160)return null;
      if(Number.isFinite(stream.duration)&&stream.duration>0)onDuration?.(stream.duration);
      const decoder=await instance(`decoder-${codec}`);
      const [,dc,dp,df]=await decoder.ff_init_decoder(par.codec_id,{codecpar:par,time_base:[stream.time_base_num,stream.time_base_den]});
      const packet=await demux.av_packet_alloc(), duration=Number(stream.duration);
      const times=Number.isFinite(duration)&&duration>.2?[Math.min(10,duration*.1),Math.min(40,duration*.25),duration*.5,duration*.75,duration*.9]:[0];
      for(const time of times){
        check();
        if(time>0){const [lo,hi]=demux.f64toi64(time*stream.time_base_den/stream.time_base_num);await demux.av_seek_frame(context,stream.index,lo,hi,1);await decoder.avcodec_flush_buffers(dc);}
        let decoded=0;
        for(let batch=0;batch<40;batch++){
          check();const [result,packets]=await demux.ff_read_frame_multi(context,packet,{limit:32768});
          for(const input of packets[stream.index]||[]){
            check();const frames=await decoder.ff_decode_multi(dc,dp,df,[input]);
            for(const frame of frames){
              check();let canvas=null;
              try {
                if(decoded++%5===0)canvas=frameCanvas(frame);
                if(canvas && TCloudUI.videoFrameQuality(canvas).accepted){
                  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/webp",.78));check();return blob;
                }
              } finally {frame.data?.fill?.(0);if(canvas){canvas.width=1;canvas.height=1;}}
            }
          }
          if(result===demux.AVERROR_EOF)break;
        }
      }
      return null;
    })();
    try {return await Promise.race([work,stop]);}
    catch {return null;}
    finally {finished=true;controller.abort();clearTimeout(timeout);signal?.removeEventListener("abort",aborted);for(const value of instances)value.terminate();instances.clear();cache?.fill(0);cache=null;}
  }
  global.TCloudThumbnailCodec=Object.freeze({recover});
})(globalThis);
