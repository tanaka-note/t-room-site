import { open,seal } from './crypto.mjs';
import { preferencesScope,publishedScope } from './policy.mjs';

// Only ciphertext is persisted. Synchronous UI callers see an in-memory facade;
// navigation awaits flush() so it never falls back to writing plaintext state.
export async function createPrivateNavigation(client,{storage=sessionStorage,history=window.history}={}) {
  const prefix=`diary-private:${client.actor.credentialId}:${client.household}:`;
  const scope=preferencesScope(client.household,client.actor.accountId),key=client.keys.get(scope),epoch=client.directory.epochs[scope];
  if(!key)throw new Error('GrantDenied');
  const values=new Map(),pending=new Set(),tags=new Map(),routes=new Map();
  let closed=false;
  const binding=id=>({household:client.household,scope,id,revision:1,epoch,kind:'navigation'});
  const safeId=name=>name.startsWith('history:')?name:'state:'+name;
  for(let i=0;i<storage.length;i++) {
    const name=storage.key(i);if(!name?.startsWith(prefix))continue;
    try{const original=name.slice(prefix.length);values.set(original,await open(key,JSON.parse(storage.getItem(name)),binding(safeId(original))));}catch{storage.removeItem(name);i--;}
  }
  // Remove snapshots made by the old plaintext UI before enabling the facade.
  for(const name of ['troom-diary-return-view-v1','troomDiaryReturnNavigation'])storage.removeItem(name);
  const set=(name,value)=>{
    if(closed)throw new Error('SessionExpired');values.set(name,String(value));
    const task=(async()=>{const envelope=await seal(key,String(value),binding(safeId(name)));if(!closed&&values.get(name)===String(value))storage.setItem(prefix+name,JSON.stringify(envelope));})();
    pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});
  };
  const privateStorage={getItem:name=>values.get(name)??null,setItem:set,removeItem:name=>{values.delete(name);storage.removeItem(prefix+name);}};
  const historyKey='troomDiaryReturnView';
  const privateHistory={
    get state(){const state={...history.state},reference=state[historyKey];if(reference?.encrypted){try{state[historyKey]=JSON.parse(values.get(`history:${reference.id}`)||'null');}catch{delete state[historyKey];}}return state;},
    get scrollRestoration(){return history.scrollRestoration;},set scrollRestoration(value){history.scrollRestoration=value;},
    replaceState(state,title,url){const copy={...state};if(copy[historyKey]&&!copy[historyKey].encrypted){const id=history.state?.[historyKey]?.encrypted?history.state[historyKey].id:crypto.randomUUID();set(`history:${id}`,JSON.stringify(copy[historyKey]));copy[historyKey]={encrypted:true,id};}history.replaceState(copy,title,url);},
    back:()=>history.back()
  };
  if(history.state?.[historyKey]&&!history.state[historyKey].encrypted){const state={...history.state};delete state[historyKey];history.replaceState(state,'',location.href);}
  const tagBinding={household:client.household,scope:publishedScope(client.household),id:'tag-route',revision:1,epoch:client.directory.epochs[publishedScope(client.household)],kind:'tag-route'};
  async function prepareTags() {
    const tagKey=client.keys.get(tagBinding.scope);
    for(const {value} of client.meta().tags)if(!tags.has(value)) {
      const box=await seal(tagKey,value,tagBinding);const segment=`e_${box.iv}.${box.ciphertext}`;tags.set(value,segment);routes.set(segment,value);
    }
    const segment=location.pathname.match(/^\/diary\/tag\/([^/]+)\/?$/)?.[1];
    if(segment?.startsWith('e_')&&!routes.has(segment)) {
      const [iv,ciphertext]=segment.slice(2).split('.');const tag=await open(tagKey,{version:1,iv,ciphertext},tagBinding);
      if(typeof tag!=='string'||tag.length>100)throw new Error('InvalidTagRoute');routes.set(segment,tag);tags.set(tag,segment);
    }else if(segment&&!segment.startsWith('e_')) {
      const tag=decodeURIComponent(segment),encoded=tags.get(tag);if(encoded)history.replaceState({},'',`/diary/tag/${encoded}/`);
    }
  }
  await prepareTags();
  return {storage:privateStorage,history:privateHistory,prepareTags,
    tagRoute:tag=>{const id=tags.get(tag);if(!id)throw new Error('UnknownTag');return `/diary/tag/${id}/`;},
    tagValue:segment=>routes.get(segment)||'',
    flush:async()=>{await Promise.allSettled([...pending]);},
    close(){closed=true;values.clear();tags.clear();routes.clear();}
  };
}
