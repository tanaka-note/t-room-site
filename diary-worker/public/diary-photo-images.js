// T-Cloud's viewport priority, bounded parallelism and generation cancellation,
// with plaintext blobs kept in memory only. No photo bytes enter browser storage.
export function createPhotoImages(runtime) {
  const tasks=new Map(),urls=new Map(),downloads=new Set();
  let active=0,frame=0,generation=0;
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const entry of entries){const task=tasks.get(entry.target);if(task){task.near=entry.isIntersecting;if(!task.near&&task.loaded&&!task.eager){const url=urls.get(entry.target);if(url)URL.revokeObjectURL(url);urls.delete(entry.target);entry.target.removeAttribute('src');task.started=false;task.loaded=false;}}}
    schedule();
  },{rootMargin:'720px 0px'}):null;
  const mutations=new MutationObserver(()=>{
    for(const [image,task] of tasks)if(task.image&&!image.isConnected){task.controller?.abort();tasks.delete(image);observer?.unobserve(image);}
    for(const [image,url] of urls)if(!image.isConnected){URL.revokeObjectURL(url);urls.delete(image);image.removeAttribute('src');}
    schedule();
  });
  if(runtime)mutations.observe(document.body,{subtree:true,childList:true});
  function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;pump();});}
  function pump(){
    if(document.hidden)return;
    const candidates=[...tasks.values()].filter(task=>!task.started&&(!task.readyAt||task.readyAt<=performance.now())&&(task.eager||task.near)&&(!task.image||task.image.isConnected));
    const distance=task=>{if(!task.image)return 1000;const rect=task.image.getBoundingClientRect();return Math.max(-rect.bottom,rect.top-innerHeight,0);};
    candidates.sort((a,b)=>Number(b.eager)-Number(a.eager)||distance(a)-distance(b));
    while(active<4&&candidates.length){
      const task=candidates.shift(),version=generation;task.started=true;active++;
      task.controller=new AbortController();
      runtime.readPhoto(task.photo,task.kind,{signal:task.controller.signal}).then(blob=>{
        if(version!==generation||task.controller.signal.aborted||task.image&&!task.image.isConnected)return;
        if(task.image){
          const url=URL.createObjectURL(blob),old=urls.get(task.image);if(old)URL.revokeObjectURL(old);
          urls.set(task.image,url);task.image.src=url;task.loaded=true;
        }
      }).catch(error=>{
        if(error.name==='AbortError'||version!==generation)return;
        if(task.attempts++<2&&(!error.status||error.status===408||error.status===429||error.status>=500)&&!/Cipher|OperationError|Key|Session|Grant/.test(error.name+' '+error.message)){
          task.started=false;task.readyAt=performance.now()+500*task.attempts;setTimeout(schedule,500*task.attempts);
        }else{
          tasks.delete(task.image||task);if(task.image)observer?.unobserve(task.image);
          task.image?.dispatchEvent(new Event('error'));
        }
      }).finally(()=>{
        active--;
        if(version===generation&&task.started&&!task.loaded&&tasks.get(task.image||task)===task){tasks.delete(task.image||task);if(task.image)observer?.unobserve(task.image);}
        schedule();
      });
    }
  }
  function bind(image,photo,kind,{eager=false}={}) {
    release(image);
    if(!runtime||photo.previewUrl&&!photo[`${kind}Url`]){image.src=photo[`${kind}Url`]||photo.previewUrl;return;}
    image.decoding='async';
    const task={image,photo,kind,eager,near:!observer,started:false,attempts:0};
    tasks.set(image,task);observer?.observe(image);schedule();
  }
  function release(image){const task=tasks.get(image);task?.controller?.abort();tasks.delete(image);observer?.unobserve(image);const url=urls.get(image);if(url){URL.revokeObjectURL(url);urls.delete(image);image.removeAttribute('src');}}
  function prefetch(photo,kind='display'){
    if(!runtime||!photo)return;
    const task={photo,kind,eager:false,near:true,started:false,attempts:0};tasks.set(task,task);schedule();
  }
  async function download(photo){
    const version=generation,blob=await runtime.readPhoto(photo,'original');if(version!==generation)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');downloads.add(url);
    link.href=url;link.download=photo.fileName||'photo';link.click();
    setTimeout(()=>{URL.revokeObjectURL(url);downloads.delete(url);},60000);
  }
  function reset(){
    generation++;for(const task of tasks.values())task.controller?.abort();tasks.clear();observer?.disconnect();
    for(const [image,url] of urls){image.removeAttribute('src');URL.revokeObjectURL(url);}urls.clear();
    for(const url of downloads)URL.revokeObjectURL(url);downloads.clear();
  }
  window.addEventListener('scroll',schedule,{passive:true,capture:true});
  document.addEventListener('visibilitychange',schedule);
  let suspended=[];
  window.addEventListener('pagehide',event=>{suspended=event.persisted?[...tasks.values()].filter(task=>task.image).map(({image,photo,kind,eager})=>({image,photo,kind,eager})):[];reset();});
  window.addEventListener('pageshow',event=>{if(event.persisted){for(const task of suspended)if(task.image.isConnected)bind(task.image,task.photo,task.kind,{eager:task.eager});suspended=[];}});
  return {bind,release,prefetch,download:runtime?download:null,reset,setRuntime:value=>{reset();runtime=value;if(runtime)mutations.observe(document.body,{subtree:true,childList:true});}};
}
