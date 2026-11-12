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
  if(url.pathname==='/security/passkey-client.js'&&['GET','HEAD'].includes(request.method)||api.includes(url.pathname)&&request.method==='POST')return env.SECURITY.fetch(request);
  return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
}
