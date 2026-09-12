import { isIP } from 'node:net';
import { normalizeSourceUrl, isBlockedIpLiteral, isPolicyRestrictedHost } from './downloader-domain.js';

export function safeAnalysisDiagnostic(value) {
  const result={};
  if(['direct','html','metadata','chromium','prepare','discover','validate'].includes(value?.stage)) result.stage=value.stage;
  if(['upstream','egress','browser','resolver','unknown'].includes(value?.source)) result.source=value.source;
  if(Number.isInteger(value?.httpStatus) && value.httpStatus>=100 && value.httpStatus<=599) result.httpStatus=value.httpStatus;
  if(['claim','configuration','dependencies','configure_egress','prepare','discover','candidate','validate'].includes(value?.operation)) result.operation=value.operation;
  if(['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError','DataCloneError','InvalidStateError'].includes(value?.errorName)) result.errorName=value.errorName;
  return result;
}

export function markEgressResponse(response, source) {
  const headers=new Headers(response.headers);
  // Never trust an origin-supplied diagnostic marker.
  headers.set('X-Tlain-Egress-Source', source);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

const blocked = () => markEgressResponse(new Response('Blocked',{status:403}), 'egress');
export const MEDIA_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

export function normalizeRequestContext(value, hosts) {
  if(value == null) return [];
  if(!Array.isArray(value) || value.length>32) throw new Error('download_context_invalid');
  const seen=new Set();
  return value.map(entry=>{
    const target=normalizeSourceUrl(`${entry.origin}/`), ref=normalizeSourceUrl(`${entry.refererOrigin}/`);
    if(target.origin!==entry.origin || ref.origin!==entry.refererOrigin || !hosts.includes(target.hostname) ||
      isPolicyRestrictedHost(ref.hostname) || seen.has(target.origin) || (target.protocol==='http:' && ref.protocol==='https:')) throw new Error('download_context_invalid');
    seen.add(target.origin);
    return {origin:target.origin,refererOrigin:ref.origin,sendOrigin:entry.sendOrigin===true};
  });
}

export function canExploreAnalysis(code) {
  return new Set(['metadata_timeout','metadata_invalid','extractor_failed','media_not_found',
    'browser_execution_failed','download_timeout','download_network_failed','analysis_execution_failed']).has(code);
}

export function terminalAnalysisError(code) {
  return canExploreAnalysis(code) || new Set(['drm','drm_not_supported','encrypted_stream','encrypted_stream_not_supported',
    'login_required','premium_required','geo_restricted','policy_restricted','extractor_intentionally_unsupported',
    'bot_challenge','access_denied','egress_denied','analysis_deadline_exceeded','live_stream_not_supported']).has(code);
}

export function publicAddress(address) {
  if (!isIP(address) || isBlockedIpLiteral(address)) return false;
  if (isIP(address) === 6) {
    // Global unicast only; conservatively exclude special-purpose 2001::/23,
    // documentation and 6to4 (embedded addresses) rather than translate them.
    const first = parseInt(address.split(':')[0], 16);
    const second = parseInt(address.split(':')[1] || '0', 16);
    return first >= 0x2000 && first < 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return !/^(?:192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(address);
}

export async function assertPublicDestination(value, signal, fetcher = fetch) {
  const url = normalizeSourceUrl(value);
  if (isPolicyRestrictedHost(url.hostname)) throw new Error('main_video_policy_restricted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!publicAddress(host)) throw new Error('main_video_dns_blocked');
    return url;
  }
  const answers = await Promise.all(['A', 'AAAA'].map(async type => {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', host);
    endpoint.searchParams.set('type', type);
    // Workers rejects redirect:"error" before sending (Node accepts it).
    // Do not follow DNS redirects; the !ok check below rejects every 3xx.
    const response = await fetcher(endpoint, {headers: {Accept:'application/dns-json'}, signal, redirect:'manual'});
    if (!response.ok) throw new Error('main_video_dns_failed');
    const data = await response.json();
    if (data.Status !== 0) throw new Error('main_video_dns_failed');
    return (data.Answer || []).filter(x => x.type === 1 || x.type === 28).map(x => x.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(x => !publicAddress(x))) throw new Error('main_video_dns_blocked');
  return url;
}

// Named, instance-scoped ContainerProxy handler. The normal successful paths
// keep their existing handler. Recheck public DNS on each outbound request;
// redirects are returned, never followed here. No VPC/internal-service binding
// is used. Cloudflare's public fetch is the final origin connection boundary.
export async function mainVideoOutbound(request, _env, ctx) {
  try {
    const policy = ctx.params;
    if (!policy || Date.now() >= policy.until || !['GET','HEAD'].includes(request.method)) return blocked();
    const signal = AbortSignal.timeout(Math.max(1, policy.until-Date.now()));
    const url = normalizeSourceUrl(request.url);
    if (!policy.hosts.includes(url.hostname)) return blocked();
    await assertPublicDestination(url.href, signal);
    const headers = new Headers({'User-Agent':MEDIA_USER_AGENT,'X-Real-IP':'2a06:98c0:3600::103'});
    const contexts=normalizeRequestContext(policy.requestContext,policy.hosts);
    const context=contexts.find(x=>x.origin===url.origin);
    // The policy comes from validated frame relationships / an encrypted route,
    // never from request Referer, Origin or arbitrary client input.
    if(context) {
      headers.set('Referer',`${context.refererOrigin}/`);
      if(context.sendOrigin) headers.set('Origin',context.refererOrigin);
    } else if(policy.bounded && Array.isArray(policy.pageOrigins)) {
      const raw=request.headers.get('Referer');
      if(raw) {
        const ref=normalizeSourceUrl(raw);
        if(policy.pageOrigins.includes(ref.origin) && !(url.protocol==='http:' && ref.protocol==='https:')) {
          headers.set('Referer',`${ref.origin}/`);
          if(request.headers.get('Origin')===ref.origin) headers.set('Origin',ref.origin);
        }
      }
    }
    for (const name of ['Accept','Range','If-Range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value.slice(0,512));
    }
    const response = markEgressResponse(await fetch(url, {method:request.method, headers, redirect:'manual', signal}), 'upstream');
    if (!policy.bounded || !response.body) return response;
    let size=0;
    const body=response.body.pipeThrough(new TransformStream({transform(chunk, controller) {
      size+=chunk.byteLength;
      if(size>1_000_000) throw new Error('main_video_response_limit');
      controller.enqueue(chunk);
    }}));
    return new Response(body,{status:response.status,headers:response.headers});
  } catch (error) {
    const own = ['main_video_dns_blocked','main_video_policy_restricted'].includes(error?.message) || error?.name==='DomainError';
    return markEgressResponse(new Response('Blocked', {status:403}), own ? 'egress' : 'unknown');
  }
}

export async function configureMainVideoEgress(container, hosts, until, bounded = true, context = {}) {
  const exact = [...new Set(hosts.map(host => normalizeSourceUrl(`https://${host}/`).hostname))];
  if(exact.length>32) throw new Error('main_video_host_limit');
  await container.setAllowedHosts(bounded ? exact : ['r2.tlain.internal', ...exact]);
  await container.setOutboundHandler('mainVideo', {hosts:exact,until,bounded,
    requestContext:normalizeRequestContext(context.requestContext,exact),pageOrigins:context.pageOrigins || []});
}

export async function exploreMainVideo(env, container, sourceUrl, analysisEndsAt, maxBytes, pagePlan = null, onFailure = () => {}) {
  const started=Date.now();
  let operation='claim';
  const until = Math.min(analysisEndsAt, Date.now()+10_000);
  if (env.MAIN_VIDEO_FALLBACK !== 'true' || until-Date.now()<1000 || isPolicyRestrictedHost(sourceUrl.hostname)) return null;
  const remaining = () => {
    const ms=until-Date.now();
    if(ms<100) throw new Error('main_video_timeout');
    return ms;
  };
  const call = async body => {
    const response=await container.fetch(new Request('http://container/main-video', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...body,budgetSeconds:remaining()/1000,expiresAtMs:until}),signal:AbortSignal.timeout(remaining())
    }));
    const value=await response.json();
    if(!response.ok) {
      const error = new Error(/^[a-z][a-z0-9_]{0,79}$/.test(value.errorCode || '') ? value.errorCode : 'main_video_http_failed');
      error.diagnostic=safeAnalysisDiagnostic({...value.diagnostic,stage:body.phase});
      throw error;
    }
    return value;
  };
  const run = async () => { try {
    // Persistent per-analysis DO fence survives Queue redelivery and DO eviction.
    if (!await container.claimMainVideoExploration()) return null;
    remaining();
    operation='configuration';
    // Static configuration is optional. The trusted resolver can supply one
    // main iframe and scripts explicitly declared in that page; every exact
    // host is publicly resolved before it is added, and again at each send.
    const sites=JSON.parse(env.MAIN_VIDEO_PAGE_HOSTS || '{}');
    const dependencies=Array.isArray(sites[sourceUrl.hostname]) ? sites[sourceUrl.hostname].slice(0,8) : [];
    const hosts=[sourceUrl.hostname,...dependencies];
    const addUrls = async values => {
      for(const value of values) {
        const target=await assertPublicDestination(value,AbortSignal.timeout(remaining()));
        if(!hosts.includes(target.hostname)) hosts.push(target.hostname);
        if(hosts.length>12) throw new Error('main_video_host_limit');
      }
    };
    let plan={};
    operation='dependencies';
    if(pagePlan?.page && normalizeSourceUrl(pagePlan.page).origin===sourceUrl.origin) {
      plan={embed:pagePlan.embed || '',candidate:pagePlan.candidate || ''};
      if(plan.candidate) plan.embed='';
      else await addUrls([...(pagePlan.scripts || []).slice(0,8),...(plan.embed?[plan.embed]:[])]);
    }
    const context={pageOrigins:[sourceUrl.origin,...(plan.embed?[new URL(plan.embed).origin]:[])]};
    operation='configure_egress';
    await configureMainVideoEgress(container,hosts,until,true,context);
    remaining();
    if(plan.embed) {
      operation='prepare';
      const frame=await call({phase:'prepare',url:plan.embed});
      if(new URL(frame.page).origin!==new URL(plan.embed).origin) throw new Error('main_video_frame_redirect');
      operation='dependencies';
      await addUrls((frame.scripts || []).slice(0,8));
      operation='configure_egress';
      await configureMainVideoEgress(container,hosts,until,true,context);
    }
    // A sole main media element on an already-read page needs no browser.
    // No request to this CDN occurred before this public-DNS approval.
    operation='discover';
    const found=plan.candidate ? {url:plan.candidate,refererOrigin:sourceUrl.origin,sendOrigin:false,
      metrics:{requests:0,bodyBytes:0,browserLaunches:0}} :
      await call({phase:'discover',url:sourceUrl.href,allowedHosts:hosts,plan});
    operation='candidate';
    const candidate=await assertPublicDestination(found.url,AbortSignal.timeout(remaining()));
    // Only the single correlated candidate's exact CDN is admitted. Its
    // manifests must pass the existing validators before the route is sealed.
    const ref=found.refererOrigin;
    if(ref && !context.pageOrigins.includes(ref)) throw new Error('download_context_invalid');
    const requestContext=ref && !(candidate.protocol==='http:' && new URL(ref).protocol==='https:') ?
      [{origin:candidate.origin,refererOrigin:ref,sendOrigin:found.sendOrigin===true}] : [];
    operation='configure_egress';
    await configureMainVideoEgress(container,[...hosts,candidate.hostname],until,true,{...context,requestContext});
    operation='validate';
    const analysis=await call({phase:'validate',url:candidate.href,maxBytes,requestContext,browserUsed:!plan.candidate});
    remaining();
    if(found.title) analysis.title=String(found.title).slice(0,240);
    const metrics={};
    for(const [key,output,max] of [['requests','browserRequests',32],['bodyBytes','browserBodyBytes',2_000_000],['browserLaunches','browserLaunches',1]]) {
      const n=found.metrics?.[key]; if(Number.isInteger(n) && n>=0 && n<=max) metrics[output]=n;
    }
    console.log(JSON.stringify({event:'downloader_main_video',result:'found',elapsedMs:Date.now()-started,...metrics}));
    return analysis;
  } catch (error) {
    const errorCode=/^[a-z][a-z0-9_]{0,79}$/.test(error?.message || '') ? error.message : 'analysis_execution_failed';
    // Keep fixed classifications even when the exception message contains a
    // URL or credential and must be discarded. Never log the message/stack.
    const diagnostic=safeAnalysisDiagnostic({...error?.diagnostic,operation,errorName:error?.name});
    onFailure({errorCode,diagnostic});
    console.log(JSON.stringify({event:'downloader_main_video',result:'failed',errorCode,...diagnostic,elapsedMs:Date.now()-started}));
    return null;
  }};
  let timer;
  try {
    return await Promise.race([run(),new Promise(resolve => {timer=setTimeout(()=>resolve(null),Math.max(1,until-Date.now()));})]);
  } finally {clearTimeout(timer);}
}
