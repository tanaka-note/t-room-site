import { isIP } from 'node:net';
import { normalizeSourceUrl, isBlockedIpLiteral, isPolicyRestrictedHost } from './downloader-domain.js';

export function safeAnalysisDiagnostic(value) {
  const result={};
  if(['direct','html','metadata','chromium','prepare','discover','validate'].includes(value?.stage)) result.stage=value.stage;
  if(['upstream','egress','browser','resolver','unknown'].includes(value?.source)) result.source=value.source;
  if(Number.isInteger(value?.httpStatus) && value.httpStatus>=100 && value.httpStatus<=599) result.httpStatus=value.httpStatus;
  return result;
}

export function markEgressResponse(response, source) {
  const headers=new Headers(response.headers);
  // Never trust an origin-supplied diagnostic marker.
  headers.set('X-Tlain-Egress-Source', source);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

const blocked = () => markEgressResponse(new Response('Blocked',{status:403}), 'egress');

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
    const response = await fetcher(endpoint, {headers: {Accept:'application/dns-json'}, signal, redirect:'error'});
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
    const headers = new Headers({'User-Agent':'Mozilla/5.0','X-Real-IP':'2a06:98c0:3600::103'});
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

export async function configureMainVideoEgress(container, hosts, until, bounded = true) {
  const exact = [...new Set(hosts.map(host => normalizeSourceUrl(`https://${host}/`).hostname))];
  if(exact.length>32) throw new Error('main_video_host_limit');
  await container.setAllowedHosts(bounded ? exact : ['r2.tlain.internal', ...exact]);
  await container.setOutboundHandler('mainVideo', {hosts:exact,until,bounded});
}

export async function exploreMainVideo(env, container, sourceUrl, analysisEndsAt, maxBytes, pagePlan = null, onFailure = () => {}) {
  const started=Date.now();
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
    if(pagePlan?.page && normalizeSourceUrl(pagePlan.page).href===sourceUrl.href) {
      plan={embed:pagePlan.embed || ''};
      await addUrls([...(pagePlan.scripts || []).slice(0,8),...(plan.embed?[plan.embed]:[])]);
    }
    await configureMainVideoEgress(container,hosts,until);
    remaining();
    if(plan.embed) {
      const frame=await call({phase:'prepare',url:plan.embed});
      if(frame.page!==plan.embed) throw new Error('main_video_frame_redirect');
      await addUrls((frame.scripts || []).slice(0,8));
      await configureMainVideoEgress(container,hosts,until);
    }
    const found=await call({phase:'discover',url:sourceUrl.href,allowedHosts:hosts,plan});
    const candidate=await assertPublicDestination(found.url,AbortSignal.timeout(remaining()));
    // Only the single correlated candidate's exact CDN is admitted. Its
    // manifests must pass the existing validators before the route is sealed.
    await configureMainVideoEgress(container,[...hosts,candidate.hostname],until);
    const analysis=await call({phase:'validate',url:candidate.href,maxBytes});
    remaining();
    if(found.title) analysis.title=String(found.title).slice(0,240);
    console.log(JSON.stringify({event:'downloader_main_video',result:'found',elapsedMs:Date.now()-started}));
    return analysis;
  } catch (error) {
    const errorCode=/^[a-z][a-z0-9_]{0,79}$/.test(error?.message || '') ? error.message : 'analysis_execution_failed';
    const diagnostic=safeAnalysisDiagnostic(error?.diagnostic);
    onFailure({errorCode,diagnostic});
    console.log(JSON.stringify({event:'downloader_main_video',result:'failed',errorCode,...diagnostic,elapsedMs:Date.now()-started}));
    return null;
  }};
  let timer;
  try {
    return await Promise.race([run(),new Promise(resolve => {timer=setTimeout(()=>resolve(null),Math.max(1,until-Date.now()));})]);
  } finally {clearTimeout(timer);}
}
