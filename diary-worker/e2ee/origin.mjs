const fail=()=>{throw Object.assign(new Error('DedicatedDiaryOriginRequired'),{status:503});};
export function diaryEncryptionOrigin(env) {
  let url;try{url=new URL(env.DIARY_ENCRYPTION_ORIGIN);}catch{fail();}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail();
  const local=env.DIARY_ENCRYPTION_LOCAL_TEST==='true'&&['127.0.0.1','localhost'].includes(url.hostname);
  if(!local&&(url.protocol!=='https:'||url.origin===String(env.SECURITY_ORIGIN||'https://tanaka-note.com')))fail();
  return url.origin;
}
export function assertDiaryEncryptionOrigin(env,requestUrl) {
  if(new URL(requestUrl).origin!==diaryEncryptionOrigin(env))throw Object.assign(new Error('OriginDenied'),{status:403});
}
export async function proxyDiaryAuthentication(request,env) {
  const url=new URL(request.url);if(!url.pathname.startsWith('/security/'))return null;
  if(env.DIARY_ENCRYPTION_ENABLED!=='true')return null;
  assertDiaryEncryptionOrigin(env,url);
  const api=['options','verify','handoff','cancelled'].map(name=>`/security/api/auth/${name}`);
  if(url.pathname==='/security/passkey-client.js'&&['GET','HEAD'].includes(request.method))return env.SECURITY.fetch(request);
  if(api.includes(url.pathname)&&request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin||!String(request.headers.get('Content-Type')||'').startsWith('application/json'))return new Response('Invalid request',{status:403});
    const chunks=[],reader=request.body?.getReader();let length=0;
    if(!reader)return new Response('Invalid request',{status:400});
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>100000){void reader.cancel();return new Response('Request too large',{status:413});}chunks.push(value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return new Response('Invalid request',{status:400});}
    if(body?.service!=='diary')return new Response('Service denied',{status:403});
    return env.SECURITY.fetch(new Request(request,{body:bytes}));
  }
  return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
}
