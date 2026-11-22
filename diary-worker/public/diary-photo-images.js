// Keep decoding and image memory bounded even when the connection is fast.
// Separate slots let a tapped or visible photo start while prefetch is busy.
export function createPhotoImages(runtime) {
  const tasks=new Map(),urls=new Map(),downloads=new Set();
  const observers = new Map();
  const prefetchMargin=2000;
  const albumMargin=4000;
  const idleAlbumSlots=12;
  const limits={selected:2,visible:8,nearby:6};
  const running={selected:new Set(),visible:new Set(),nearby:new Set()};
  let frame=0,generation=0;
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
    }, { root, rootMargin: `${root?.id==='camera-roll-dialog'?albumMargin:prefetchMargin}px 0px` });
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
    const element=task.image;
    if (!element) return 500;
    if (!element.isConnected) return Infinity;
    const rect = element.getBoundingClientRect();
    if (!rect.width||!rect.height) return Infinity;
    const root = task.root?.getBoundingClientRect();
    const top = Math.max(root?.top ?? 0, 0);
    const bottom = Math.min(root?.bottom ?? innerHeight, innerHeight);
    return Math.max(top - rect.bottom, rect.top - bottom, 0);
  }
  function laneFor(task,distance) {
    return task.eager?'selected':task.image&&distance===0?'visible':'nearby';
  }
  const albumThumbnail=task=>task.root?.id==='camera-roll-dialog'&&task.kind==='thumbnail'&&Boolean(task.photo.crypto);
  function pump(){
    if(document.hidden)return;
    const candidates=[...tasks.values()]
      .filter(task=>!task.started&&(!task.readyAt||task.readyAt<=performance.now())&&(task.eager||task.near!==false)&&(!task.image||task.image.isConnected))
      .map(task => ({ task, distance: distanceFromViewport(task) }))
      .filter(({ task, distance }) => (task.eager||distance<=(albumThumbnail(task)?albumMargin:prefetchMargin))&&(!task.visibleOnly||distance===0));
    const foreground=running.selected.size+running.visible.size>0||candidates.some(({task,distance})=>laneFor(task,distance)!=='nearby');
    if(foreground)for(const task of running.nearby) {
      if(task.extraPrefetch&&distanceFromViewport(task)>0) {
        task.preempted=true;
        task.controller.abort();
      }
    }
    candidates.sort((a, b) => Number(b.task.eager) - Number(a.task.eager)
      || Number(laneFor(a.task,a.distance)==='nearby') - Number(laneFor(b.task,b.distance)==='nearby')
      || Number(Boolean(a.task.visibleOnly)) - Number(Boolean(b.task.visibleOnly))
      || a.distance - b.distance);
    if(running.visible.size>=limits.visible&&candidates.some(({task,distance})=>laneFor(task,distance)==='visible')) {
      for(const task of running.visible) {
        if(distanceFromViewport(task)>0) {
          task.preempted=true;
          task.controller.abort();
        }
      }
    }
    for(const {task,distance} of candidates) {
      const lane=laneFor(task,distance);
      const boost=lane==='nearby'&&!foreground&&albumThumbnail(task);
      if(lane==='nearby'&&distance>prefetchMargin&&!boost)continue;
      if(running[lane].size>=(boost?idleAlbumSlots:limits[lane]))continue;
      if(lane==='nearby'&&(running.selected.size||running.visible.size>=4))continue;
      const version=generation;
      const controller=new AbortController();
      task.started=true;
      task.controller=controller;
      task.extraPrefetch=boost&&(distance>prefetchMargin||running.nearby.size>=limits.nearby);
      running[lane].add(task);
      const options={signal:controller.signal,priority:lane==='nearby'?'low':'high'};
      const load=task.image||!runtime.prefetchPhoto
        ? runtime.readPhoto(task.photo,task.kind,options)
        : runtime.prefetchPhoto(task.photo,task.kind,options);
      load.then(blob=>{
        if(version!==generation||controller.signal.aborted||task.image&&!task.image.isConnected)return;
        if(task.image){
          const url=URL.createObjectURL(blob),old=urls.get(task.image);if(old)URL.revokeObjectURL(old);
          urls.set(task.image,url);
          if(lane!=='nearby')task.image.loading='eager';
          task.image.src=url;task.loaded=true;
        }
      }).catch(error=>{
        if(error.name==='AbortError'||controller.signal.aborted||version!==generation)return;
        if(task.attempts++<2&&(!error.status||error.status===408||error.status===429||error.status>=500)&&!/Cipher|OperationError|Key|Session|Grant/.test(error.name+' '+error.message)){
          task.started=false;task.readyAt=performance.now()+500*task.attempts;setTimeout(schedule,500*task.attempts);
        }else{
          tasks.delete(task.image||task.key);task.observer?.unobserve(task.image);
          task.image?.dispatchEvent(new Event('error'));
        }
      }).finally(()=>{
        running[lane].delete(task);
        if(version===generation&&tasks.get(task.image||task.key)===task) {
          if(task.preempted){task.started=false;task.preempted=false;}
          else if(task.started&&!task.loaded){tasks.delete(task.image||task.key);task.observer?.unobserve(task.image);}
        }
        schedule();
      });
    }
  }
  function bind(image,photo,kind,{eager=false,root=null,visibleOnly=false}={}) {
    release(image);
    if(!runtime||photo.previewUrl&&!photo[`${kind}Url`]){image.src=photo[`${kind}Url`]||photo.previewUrl;return;}
    image.decoding='async';
    const observer = observerFor(root);
    const task={image,photo,kind,eager,root,visibleOnly,observer,near:undefined,started:false,attempts:0};
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
    if(!runtime||!photo||runtime.isPhotoCached?.(photo,kind))return;
    const key=`${photo.id}:${kind}`;
    if(tasks.has(key))return;
    tasks.set(key,{key,photo,kind,eager:false,near:true,started:false,attempts:0});
    schedule();
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
  return {bind,release,prefetch,isCached:(photo,kind)=>Boolean(runtime?.isPhotoCached?.(photo,kind)),download:runtime?download:null,reset,setRuntime:value=>{reset();runtime=value;if(runtime)mutations.observe(document.body,{subtree:true,childList:true});}};
}
