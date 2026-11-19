// T-Cloud's viewport priority, bounded parallelism and generation cancellation,
// with plaintext blobs kept in memory only. No photo bytes enter browser storage.
export function createPhotoImages(runtime) {
  const tasks=new Map(),urls=new Map(),downloads=new Set();
  const observers = new Map();
  let active=0,frame=0,generation=0;
  function observerFor(root) {
    if (typeof IntersectionObserver !== 'function') return null;
    if (observers.has(root)) return observers.get(root);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const image = entry.target;
        const task = tasks.get(image);
        if (task?.observer !== observer) continue;
        task.near = entry.isIntersecting;
        if (!task.near && task.loaded && !task.eager) {
          revokeImageUrl(image);
          task.started = false;
          task.loaded = false;
        }
      }
      schedule();
    }, { root, rootMargin: '720px 0px' });
    observers.set(root, observer);
    return observer;
  }
  function revokeImageUrl(image) {
    const url = urls.get(image);
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.delete(image);
    image.removeAttribute('src');
    delete image.dataset.photoState;
  }
  const mutations=new MutationObserver(()=>{
    for(const [image,task] of tasks)if(task.image&&!image.isConnected)release(image);
    for(const image of urls.keys())if(!image.isConnected)revokeImageUrl(image);
    schedule();
  });
  if(runtime)mutations.observe(document.body,{subtree:true,childList:true});
  function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;pump();});}
  function distanceFromViewport(task) {
    if (!task.image) return 1000;
    const rect = task.image.getBoundingClientRect();
    const root = task.root?.getBoundingClientRect();
    const top = Math.max(root?.top ?? 0, 0);
    const bottom = Math.min(root?.bottom ?? innerHeight, innerHeight);
    return Math.max(top - rect.bottom, rect.top - bottom, 0);
  }
  function pump(){
    if(document.hidden)return;
    const candidates=[...tasks.values()]
      .filter(task=>!task.started&&(!task.readyAt||task.readyAt<=performance.now())&&(task.eager||task.near)&&(!task.image||task.image.isConnected))
      .map(task => ({ task, distance: distanceFromViewport(task) }))
      .filter(({ task, distance }) => !task.visibleOnly || distance === 0);
    candidates.sort((a, b) => Number(b.task.eager) - Number(a.task.eager)
      || Number(a.distance > 0) - Number(b.distance > 0)
      || Number(Boolean(a.task.visibleOnly)) - Number(Boolean(b.task.visibleOnly))
      || a.distance - b.distance);
    while(active<4&&candidates.length){
      const { task } = candidates.shift();
      const version=generation;task.started=true;active++;
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
          tasks.delete(task.image||task);task.observer?.unobserve(task.image);
          task.image?.dispatchEvent(new Event('error'));
        }
      }).finally(()=>{
        active--;
        if(version===generation&&task.started&&!task.loaded&&tasks.get(task.image||task)===task){tasks.delete(task.image||task);task.observer?.unobserve(task.image);}
        schedule();
      });
    }
  }
  function bind(image,photo,kind,{eager=false,root=null,visibleOnly=false}={}) {
    release(image);
    if(!runtime||photo.previewUrl&&!photo[`${kind}Url`]){image.src=photo[`${kind}Url`]||photo.previewUrl;return;}
    image.decoding='async';
    const observer = observerFor(root);
    const task={image,photo,kind,eager,root,visibleOnly,observer,near:!observer,started:false,attempts:0};
    tasks.set(image,task);observer?.observe(image);schedule();
  }
  function release(image) {
    const task = tasks.get(image);
    task?.controller?.abort();
    task?.observer?.unobserve(image);
    tasks.delete(image);
    revokeImageUrl(image);
  }
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
    generation++;for(const task of tasks.values())task.controller?.abort();tasks.clear();
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
    for (const image of urls.keys()) revokeImageUrl(image);
    for(const url of downloads)URL.revokeObjectURL(url);downloads.clear();
  }
  window.addEventListener('scroll',schedule,{passive:true,capture:true});
  window.addEventListener('resize',schedule,{passive:true});
  document.addEventListener('visibilitychange',schedule);
  let suspended=[];
  window.addEventListener('pagehide', event => {
    suspended = event.persisted ? [...tasks.values()].filter(task => task.image)
      .map(({ image, photo, kind, eager, root, visibleOnly }) => ({ image, photo, kind, eager, root, visibleOnly })) : [];
    reset();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    for (const { image, photo, kind, eager, root, visibleOnly } of suspended) {
      if (image.isConnected) bind(image, photo, kind, { eager, root, visibleOnly });
    }
    suspended = [];
  });
  return {bind,release,prefetch,download:runtime?download:null,reset,setRuntime:value=>{reset();runtime=value;if(runtime)mutations.observe(document.body,{subtree:true,childList:true});}};
}
