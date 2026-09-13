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
  async function openMp4Header(demux, check) {
    // MP4 already supplies codec parameters/sample tables in its header.
    // ff_init_demuxer_file additionally probes all streams, which can exhaust
    // the thumbnail budget (especially for codecs absent from the demux build).
    const call=(name,...args)=>demux.c(name,...args);
    const context=await call('avformat_open_input_js','input',null,null);check();
    if(!context)throw new Error('MP4 header unavailable');
    const count=await call('AVFormatContext_nb_streams',context), streams=[];
    if(count>64)throw new Error('Too many MP4 streams');
    for(let index=0;index<count;index++){
      check();const ptr=await call('AVFormatContext_streams_a',context,index);
      const [codecpar,num,den,lo,hi]=await Promise.all([
        call('AVStream_codecpar',ptr),call('AVStream_time_base_num',ptr),call('AVStream_time_base_den',ptr),
        call('AVStream_duration',ptr),call('AVStream_durationhi',ptr)
      ]);
      const codec_type=await call('AVCodecParameters_codec_type',codecpar);
      streams.push({index,codecpar,codec_type,time_base_num:num,time_base_den:den,duration:(lo+hi*4294967296)*num/den});
    }
    return [context,streams];
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
  async function recoverAvc(demux, context, stream, par, file, check, instances) {
    // MP4's AVC configuration and compressed packets go only to the browser's
    // local decoder. This avoids HTMLMediaElement container/audio failures.
    const extra=par.extradata;
    const trace=file.thumbnailTrace;
    trace.stage='avc-config';
    if(!global.VideoDecoder || !extra || extra.length<7 || extra[0]!==1)return null;
    const codec='avc1.'+Array.from(extra.slice(1,4),b=>b.toString(16).padStart(2,'0')).join('');
    file.thumbnailCodec=`${codec} (${par.width}x${par.height})`;
    const config={codec,description:extra,codedWidth:par.width,codedHeight:par.height,optimizeForLatency:true};
    if(!(await VideoDecoder.isConfigSupported(config)).supported){trace.stage='unsupported';return null;}
    check();
    const packet=await demux.av_packet_alloc(), duration=Number(stream.duration);
    // Poorly indexed MP4s can spend the whole read budget seeking before a
    // single frame is decoded. Try buffered opening packets first; quality
    // checks still reject blank opening frames before later candidates.
    const times=Number.isFinite(duration)&&duration>.2?[0,Math.min(10,duration*.1),Math.min(40,duration*.25),duration*.5,duration*.75,duration*.9]:[0];
    let decoder=null, best=null, failure=null, sampled=0;
    const release=()=>{if(decoder?.state!=='closed')decoder?.close();decoder=null;if(best){best.width=1;best.height=1;best=null;}};
    const resource={terminate:release};instances.add(resource);
    try {
      for(const time of times){
        check();release();failure=null;sampled=0;
        if(time>0){trace.stage='avc-seek';trace.seeks=(trace.seeks||0)+1;const [lo,hi]=demux.f64toi64(time*stream.time_base_den/stream.time_base_num);await demux.av_seek_frame(context,stream.index,lo,hi,1);}
        decoder=new VideoDecoder({error:error=>{failure=error;},output:frame=>{
          let canvas=null;
          try {
            check();trace.frames++;if(best || sampled++%5!==0)return;
            const scale=Math.min(1,640/Math.max(frame.displayWidth,frame.displayHeight));
            canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(frame.displayWidth*scale));canvas.height=Math.max(1,Math.round(frame.displayHeight*scale));
            canvas.getContext('2d',{alpha:false}).drawImage(frame,0,0,canvas.width,canvas.height);
            if(TCloudUI.videoFrameQuality(canvas).accepted){best=canvas;canvas=null;}
          }catch(error){failure=error;}finally{frame.close();if(canvas){canvas.width=1;canvas.height=1;}}
        }});
        decoder.configure(config);let started=false;
        // Decode each available packet immediately. A later malformed packet
        // must not discard an earlier usable frame buffered in a batch read.
        for(let batch=0;batch<240&&!best&&!failure;batch++){
          check();trace.stage='avc-read';let result,packets;
          try {[result,packets]=await demux.ff_read_frame_multi(context,packet,{limit:1});}
          catch(error){
            if(started&&!failure&&decoder.state==='configured'){await decoder.flush();check();if(best)break;}
            throw error;
          }
          for(const input of packets[stream.index]||[]){
            check();if(best||failure)break;
            trace.videoPackets=(trace.videoPackets||0)+1;if(input.flags&1)trace.keyPackets=(trace.keyPackets||0)+1;
            if(!started && !(input.flags&1))continue;
            started=true;
            while(decoder.decodeQueueSize>=8&&!best&&!failure){await new Promise(resolve=>setTimeout(resolve,5));check();}
            if(best||failure)break;
            const timestamp=Math.round(demux.i64tof64(input.pts||0,input.ptshi||0)*stream.time_base_num/stream.time_base_den*1e6);
            trace.stage='avc-decode';trace.packets++;
            decoder.decode(new EncodedVideoChunk({type:input.flags&1?'key':'delta',timestamp,data:input.data}));
          }
          if(result===demux.AVERROR_EOF)break;
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(!failure&&decoder.state==='configured')await decoder.flush();
        if(failure)trace.error=failure.name||'DecodeError';
        check();if(best){const blob=await new Promise(resolve=>best.toBlob(resolve,'image/webp',.78));check();return blob;}
      }
      return null;
    }finally{release();instances.delete(resource);}
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
    const trace=file.thumbnailTrace={stage:'start',reads:0,readBytes:0,packets:0,frames:0};
    const blocks=new Map();
    let readBytes=0, finished=false;
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
      trace.stage='demux';
      demux.onblockread=async(name,pos,length)=>{
        check();
        if(pos>=size){await demux.ff_block_reader_dev_send(name,pos,new Uint8Array());return;}
        const cacheStart=Math.floor(pos/BLOCK)*BLOCK;
        let cache=blocks.get(cacheStart);
        if(cache){blocks.delete(cacheStart);blocks.set(cacheStart,cache);trace.cacheHits=(trace.cacheHits||0)+1;}
        else {
          const end=Math.min(size,cacheStart+BLOCK);
          trace.reads++;
          if(readBytes+end-cacheStart>READ_LIMIT){trace.error='read-limit';throw new Error("Thumbnail read limit");}
          if(localFile)cache=new Uint8Array(await localFile.slice(cacheStart,end).arrayBuffer());
          else {
            const response=await fetch(url,{headers:{Range:`bytes=${cacheStart}-${end-1}`},credentials:"same-origin",cache:"no-store",signal:controller.signal});
            check();if(response.status!==206)throw new Error("Thumbnail range unavailable");
            const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range")||"");
            if(!range || Number(range[1])!==cacheStart || Number(range[2])!==end-1 || Number(range[3])!==size)throw new Error("Thumbnail range mismatch");
            cache=new Uint8Array(await response.arrayBuffer());
            if(cache.length!==end-cacheStart)throw new Error("Thumbnail range length");
          }
          check();readBytes+=cache.length;trace.readBytes=readBytes;
          blocks.set(cacheStart,cache);
          while(blocks.size>4){const oldest=blocks.keys().next().value;blocks.get(oldest).fill(0);blocks.delete(oldest);}
        }
        await demux.ff_block_reader_dev_send(name,pos,cache.slice(pos-cacheStart,pos-cacheStart+Math.max(length,65536)));
      };
      await demux.mkblockreaderdev("input",size);check();
      const [context,streams]=format==='mp4'?await openMp4Header(demux,check):await demux.ff_init_demuxer_file("input");check();
      const stream=streams.find(item=>item.codec_type===0);if(!stream)return null;
      // The modular frontend omits this helper from its generated shortcuts;
      // use the same worker RPC used by those shortcuts, keeping work off-thread.
      const par=await demux.c("ff_copyout_codecpar",stream.codecpar);check();
      trace.probeReadBytes=readBytes;
      const codec=({12:"mpeg4",17:"wmv1",18:"wmv2",71:"wmv3"})[par.codec_id];
      file.thumbnailCodec=`${codec||`codec-${par.codec_id}`} (${par.width}x${par.height})`;
      if(!par.width || !par.height || par.width*par.height>3840*2160)return null;
      if(Number.isFinite(stream.duration)&&stream.duration>0)onDuration?.(stream.duration);
      if(par.codec_id===27)return await recoverAvc(demux,context,stream,par,file,check,instances);
      if(!codec)return null;
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
    catch(error) {trace.error=trace.error||(controller.signal.aborted?(signal?.aborted?'cancelled':'timeout'):(error.name||'DecodeError'));return null;}
    finally {finished=true;controller.abort();clearTimeout(timeout);signal?.removeEventListener("abort",aborted);for(const value of instances)value.terminate();instances.clear();for(const bytes of blocks.values())bytes.fill(0);blocks.clear();}
  }
  global.TCloudThumbnailCodec=Object.freeze({recover});
})(globalThis);
