"""Bounded, public-page-only supplemental discovery. No URL-bearing logs."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import re
from html.parser import HTMLParser
from html import escape
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from ssrf import validate_url, UnsafeUrl
from resolver import ResolverError, safe_diagnostic, http_diagnostic, MediaHtmlParser, MEDIA_USER_AGENT


def error_payload(error, stage=None):
    code = str(error)
    # Unexpected Playwright/OS errors can contain complete URLs or headers.
    if not isinstance(error, (ResolverError, ValueError)) or not re.fullmatch('[a-z][a-z0-9_]{0,79}', code):
        code = 'main_video_timeout' if isinstance(error, TimeoutError) else 'analysis_execution_failed'
    diagnostic = safe_diagnostic(getattr(error, 'diagnostic', None))
    if stage: diagnostic = safe_diagnostic({**diagnostic, 'stage': stage})
    return {'errorCode': code, 'diagnostic': diagnostic}


AD_MARKER = re.compile(r'(^|[\s_-])(ad|ads|advert|advertisement|sponsor|related|preview|trailer)([\s_-]|$)', re.I)
PLAYER_MARKER = re.compile(r'player|video|embed|watch', re.I)


def page_plan(html, url):
    """Only document-declared scripts and one main player, never arbitrary links.

    The Worker validates public DNS for every proposed exact host before it
    changes the job-local egress policy. URLs stay in memory, never in logs.
    """
    parser=MediaHtmlParser(url); parser.feed(html[:2_000_000])
    if parser.restricted: raise ResolverError('login_required')
    return parser.plan()


# Prefer page-level structured metadata; otherwise require a unique main
# player and an unambiguous source from that same frame.
METADATA = r"""() => {
  const values = [];
  const visit = x => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if ([x['@type']].flat().includes('VideoObject')) values.push(x);
    if (x['@graph']) visit(x['@graph']);
    if (x.mainEntity) visit(x.mainEntity);
  };
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (el.textContent.length > 65536) continue;
    try { visit(JSON.parse(el.textContent)); } catch {}
  }
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const key = value => { try { const u = new URL(value, location.href); u.hash=''; return u.href; } catch { return ''; } };
  if (values.some(x => x.requiresSubscription || x.isAccessibleForFree === false)) return {restricted:true};
  const candidates = values.filter(x => {
    const owner = x.mainEntityOfPage?.['@id'] || x.mainEntityOfPage || x.url;
    return typeof owner === 'string' && key(owner) === key(canonical) &&
      key(canonical) === key(location.href) && x.isAccessibleForFree !== false &&
      (typeof x.contentUrl === 'string' || typeof x.embedUrl === 'string') && !x.requiresSubscription;
  });
  if (candidates.length !== 1) return null;
  const x = candidates[0];
  return {url:x.contentUrl ? key(x.contentUrl) : '', embed:x.embedUrl ? key(x.embedUrl) : '',
    title:typeof x.name === 'string' ? x.name.slice(0,240) : ''};
}"""

PLAYER = r"""({candidate, embedded, play}) => {
  const ad = /(^|[\s_-])(ad|ads|advert|advertisement|sponsor|related|preview|trailer)([\s_-]|$)/i;
  const videos = [...document.querySelectorAll('video')].filter(v => {
    const r=v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90 || getComputedStyle(v).visibility==='hidden') return false;
    for (let e=v;e;e=e.parentElement) {
      if (ad.test(`${e.id} ${e.className} ${e.getAttribute('aria-label')||''}`)) return false;
    }
    return embedded || !!v.closest('main,[role="main"],[id*="player"],[class*="player"]') || document.querySelectorAll('video').length===1;
  });
  if (videos.length !== 1) return null;
  const v=videos[0], src=v.currentSrc || v.src;
  // An identified source must match the page's content URL. Blob is accepted
  // only later, when the same frame actually requested that exact content URL.
  if (candidate && src && src !== candidate && !src.startsWith('blob:')) return null;
  let clicked=false;
  if (play && v.paused) {
    // Only a unique, explicit button in this one player's own container.
    // Links, broad page text matches and invisible/advertising controls fail closed.
    const owner=v.closest('[id*="player"],[class*="player"],main,[role="main"]');
    const buttons=owner ? [...owner.querySelectorAll('button,[role="button"]')].filter(b=>{
      const label=(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim();
      const r=b.getBoundingClientRect();
      for(let e=b;e && e!==owner;e=e.parentElement) if(ad.test(`${e.id} ${e.className} ${e.getAttribute('aria-label')||''}`)) return false;
      return !b.closest('a,form') && !b.hasAttribute('href') && /^(play|play video|start video|再生|動画を再生)$/i.test(label) &&
        r.width>0 && r.height>0 && getComputedStyle(b).visibility!=='hidden' &&
        !ad.test(`${b.id} ${b.className}`) && !b.disabled;
    }) : [];
    if(buttons.length===1 && owner.querySelectorAll('video').length===1) { buttons[0].click(); clicked=true; }
    else { v.muted=true; v.play().catch(()=>{}); }
  }
  return {src, drm:!!v.mediaKeys, clicked};
}"""

RESTRICTED = r"""() => !!window.__mainVideoDRM || !!document.querySelector('input[type="password"]') ||
 /sign in to watch|log in to watch|login required|verify you are human|checking your browser|not available in your country|access denied|ログインが必要|ログインして視聴|地域制限|人間であることを確認/i.test((document.body?.innerText||'').slice(0,100000))"""


async def discover(url: str, allowed_hosts: list[str], timeout: float, browser_path=None, plan=None) -> dict:
    # Imported only in the extra child, never on existing successful paths.
    from playwright.async_api import async_playwright

    safe = validate_url(url)
    allowed = set(allowed_hosts)
    if safe.hostname not in allowed:
        raise ValueError('main_video_host_blocked')
    requests = []
    failed = None
    count = 0
    transferred = 0
    started = time.monotonic()
    plan = plan or {}
    page_origins={urlsplit(x).scheme+'://'+urlsplit(x).netloc for x in [url,plan.get('embed')] if x}
    contexts={}
    typed_media=set()

    def request_headers(req_headers):
        result={'User-Agent':MEDIA_USER_AGENT,'Accept':'*/*'}
        ref=urlsplit(req_headers.get('referer',''))
        origin=ref.scheme+'://'+ref.netloc
        if origin in page_origins:
            result['Referer']=origin+'/'
            if req_headers.get('origin') == origin: result['Origin']=origin
        return result

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=browser_path or '/usr/bin/chromium', headless=True,
            timeout=max(1, timeout * 1000),
            args=['--disable-dev-shm-usage', '--disable-background-networking',
                  '--disable-component-update', '--disable-extensions', '--disable-quic',
                  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        )
        try:
            context = await browser.new_context(
                service_workers='block', accept_downloads=False,
                ignore_https_errors=os.path.exists('/etc/cloudflare/certs/cloudflare-containers-ca.crt'),
            )
            await context.route_web_socket('**/*', lambda socket: socket.close())
            await context.add_init_script("""navigator.requestMediaKeySystemAccess = () => {
                window.__mainVideoDRM=true; return Promise.reject(new Error('unsupported'));
            }; document.addEventListener('encrypted', () => {window.__mainVideoDRM=true}, true);""")
            page = await context.new_page()

            async def intercept(route):
                nonlocal failed, count, transferred
                req = route.request
                count += 1
                try:
                    target = validate_url(req.url)
                    headers = await req.all_headers()
                    if failed or count > 32 or req.method not in {'GET', 'HEAD'} or headers.get('authorization') or headers.get('cookie'):
                        failed = ResolverError('main_video_request_rejected', {'source':'browser'})
                        return await route.abort()
                    if req.resource_type in {'media', 'fetch', 'xhr'}:
                        if len(requests) < 32:
                            requests.append((target.value, req.frame))
                            h=request_headers(headers)
                            contexts[target.value]={'refererOrigin':h.get('Referer','').rstrip('/'),'sendOrigin':'Origin' in h}
                    # Observe media discovery without downloading/playing bytes.
                    if req.resource_type == 'media' or target.hostname not in allowed or urlsplit(target.value).path.lower().endswith(('.m3u8','.mpd','.mp4','.webm')):
                        return await route.abort()
                    if req.resource_type not in {'document', 'script', 'stylesheet', 'fetch', 'xhr'}:
                        return await route.abort()
                    # No popup navigation, arbitrary form submission or cookies.
                    if req.frame.page != page:
                        return await route.abort()
                    if req.resource_type == 'document' and req.frame != page.main_frame:
                        owner = await page.evaluate(METADATA)
                        embed = (owner or {}).get('embed') or plan.get('embed')
                        if embed != target.value or req.frame.parent_frame != page.main_frame:
                            return await route.abort()
                    request_url=target.value
                    for hop in range(4):
                        response = await route.fetch(url=request_url,
                            headers=request_headers(headers), max_redirects=0,
                            timeout=max(1,(timeout-(time.monotonic()-started))*1000))
                        if response.status not in {301,302,303,307,308}: break
                        location=response.headers.get('location')
                        next_url=validate_url(urljoin(request_url,location or ''))
                        # First increment is counted by intercept; every extra
                        # hop shares both the request count and hard deadline.
                        if not location or hop==3 or urlsplit(next_url.value)[:2]!=urlsplit(request_url)[:2] or next_url.hostname not in allowed:
                            raise ResolverError('main_video_redirect_rejected',http_diagnostic(response.headers,response.status))
                        count+=1
                        if count>32: raise ResolverError('main_video_request_rejected',{'source':'browser'})
                        await response.dispose()
                        request_url=next_url.value
                    if response.status in {401, 403, 407, 429, 451} or response.headers.get('cf-mitigated') == 'challenge':
                        diagnostic = http_diagnostic(response.headers, response.status)
                        code = ('egress_denied' if diagnostic.get('source') == 'egress' else
                                'bot_challenge' if response.headers.get('cf-mitigated') == 'challenge' else 'access_denied')
                        failed = ResolverError(code, diagnostic)
                        await response.dispose()
                        return await route.abort()
                    if response.status >= 300 or int(response.headers.get('content-length', '0')) > 1_000_000:
                        failed = failed or ResolverError('main_video_redirect_rejected' if 300 <= response.status < 400 else
                            'main_video_http_failed' if response.status >= 400 else 'main_video_response_limit',
                            http_diagnostic(response.headers, response.status))
                        return await route.abort()
                    body = await response.body()
                    transferred += len(body)
                    if len(body) > 1_000_000 or transferred > 2_000_000:
                        failed = ResolverError('main_video_response_limit', {'source':'browser'})
                        return await route.abort()
                    mime=response.headers.get('content-type','').split(';',1)[0].lower()
                    if req.resource_type in {'fetch','xhr'} and (mime.startswith('video/') or 'mpegurl' in mime or 'dash+xml' in mime):
                        typed_media.add(target.value)
                        await response.dispose()
                        return await route.abort()
                    if request_url!=target.value and 'html' in mime:
                        # The browser keeps the original document URL. Preserve
                        # relative dependency resolution without native redirect
                        # following (which can bypass Playwright interception).
                        base=('<base href="'+escape(request_url,quote=True)+'">').encode()
                        body=re.sub(br'(<head\b[^>]*>)',lambda m:m[0]+base,body,count=1,flags=re.I)
                    headers = {k:v for k,v in response.headers.items() if k.lower() not in {'set-cookie','content-length','content-encoding','location'}}
                    await route.fulfill(status=response.status, headers=headers, body=body)
                    await response.dispose()
                except Exception as error:
                    failed = failed or (error if isinstance(error,ResolverError) else ResolverError(
                        'egress_denied' if isinstance(error,UnsafeUrl) else 'main_video_network_failed', {'source':'browser'}))
                    await route.abort()

            await context.route('**/*', intercept)
            try:
                await page.goto(safe.value, wait_until='domcontentloaded', timeout=max(1, timeout * 1000))
            except Exception:
                if failed: raise failed from None
                raise
            # Retain dump-dom's successful dynamic page metadata path in this
            # same browser, using exactly the static parser's main/ad rules.
            rendered=await page.content()
            if len(rendered)<=1_000_000:
                parser=MediaHtmlParser(page.url); parser.feed(rendered)
                if parser.restricted or await page.evaluate(RESTRICTED): raise ValueError('main_video_restricted')
                if not parser.groups and len(parser.candidates)==1:
                    candidate=validate_url(parser.candidates[0]).value
                    return {'url':candidate,'title':parser.title.strip()[:240],
                        'metrics':{'requests':count,'bodyBytes':transferred,'browserLaunches':1,'elapsedMs':round((time.monotonic()-started)*1000)}}
            played = False
            while time.monotonic() - started < timeout - 0.2:
                if failed: raise failed
                if await page.evaluate(RESTRICTED):
                    raise ValueError('main_video_restricted')
                metadata = await page.evaluate(METADATA) or {'url':'', 'embed':plan.get('embed',''), 'title':''}
                if metadata:
                    if metadata.get('restricted'):
                        raise ValueError('main_video_restricted')
                    candidate = validate_url(metadata['url']).value if metadata['url'] else ''
                    matches = []
                    for frame in page.frames[:8]:
                        embedded = bool(metadata['embed'] and frame.url == metadata['embed'])
                        if frame != page.main_frame and not embedded:
                            continue
                        if await frame.evaluate(RESTRICTED):
                            raise ValueError('main_video_restricted')
                        player = await frame.evaluate(PLAYER, {'candidate': candidate, 'embedded': embedded, 'play': not played})
                        if player:
                            played = True
                            if player['drm']:
                                raise ValueError('drm_not_supported')
                            observed = list(dict.fromkeys(value for value, owner in requests if owner == frame and
                                (value in typed_media or urlsplit(value).path.lower().endswith(('.m3u8','.mpd','.mp4','.webm'))) and
                                not MediaHtmlParser.is_ad_url(value)))
                            selected = candidate or (player['src'] if player['src'].startswith(('http://','https://')) else
                                                     observed[0] if len(observed) == 1 else '')
                            if selected and any(value == selected and owner == frame for value, owner in requests):
                                matches.append(validate_url(selected).value)
                    if len(matches) == 1:
                        return {'url': matches[0], 'title': metadata['title'], **contexts.get(matches[0],{}),
                                'metrics':{'requests':count,'bodyBytes':transferred,'browserLaunches':1,'elapsedMs':round((time.monotonic()-started)*1000)}}
                await page.wait_for_timeout(50)
            raise ValueError('main_video_not_found')
        finally:
            await browser.close()


def stop_process_tree(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        if process.poll() is None:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        return
    # Playwright deliberately starts Chromium in a separate process group.
    # Freeze the owned parent before walking /proc, then freeze descendants
    # before enumerating their children so none can fork past cleanup.
    owned = [process.pid]
    for pid in owned:
        try:
            os.kill(pid, signal.SIGSTOP)
        except ProcessLookupError:
            continue
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[1]) == pid and int(entry.name) not in owned:
                    owned.append(int(entry.name))
            except (OSError, ValueError, IndexError):
                continue
    for pid in reversed(owned):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_phase(body: dict) -> dict:
    """Hard wall-clock bound covers imports, browser and candidate validation.

    Own the process group and profile outside the child, so even a wedged
    Playwright driver is killed and cleaned on timeout/error/success. Container
    destroy on explicit cancellation also kills this entire group.
    """
    from resolver import ResolverError, _network_subprocess_environment
    analyzing = body.get('phase') == 'analyze'
    budget = min(120.0 if analyzing else 10.0, max(0.0, float(body.get('budgetSeconds', 0))))
    if body.get('expiresAtMs'):
        budget = min(budget, float(body['expiresAtMs']) / 1000 - time.time())
    if budget < 0.75:
        raise ResolverError('main_video_timeout')
    with tempfile.TemporaryDirectory(prefix='main-video-') as directory:
        env = _network_subprocess_environment()
        env.update({'TMPDIR': directory, 'TEMP': directory, 'TMP': directory, 'HOME': directory,
                    'XDG_CACHE_HOME': directory, 'XDG_CONFIG_HOME': directory})
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve())],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env, start_new_session=os.name != 'nt')
        try:
            output, _ = process.communicate(json.dumps({**body, 'budgetSeconds': budget - 0.5}), timeout=budget - 0.5)
            if process.returncode or len(output) > (1_000_000 if analyzing else 65536):
                raise ResolverError('main_video_failed')
            result = json.loads(output)
            if result.get('errorCode'):
                error = ResolverError(result['errorCode'], result.get('diagnostic'))
                error.page_plan = result.get('pagePlan')
                raise error
            return result
        except subprocess.TimeoutExpired:
            raise ResolverError('analysis_deadline_exceeded' if analyzing else 'main_video_timeout') from None
        finally:
            stop_process_tree(process)
            process.wait()


def main():
    from resolver import _analyze_direct, analyze, ANALYSIS_END, ANALYSIS_PLAN, DEFER_BROWSER, REQUEST_CONTEXT, _open
    body = json.loads(sys.stdin.read(16385))
    if body.get('phase') == 'analyze':
        ANALYSIS_END.set(time.monotonic() + float(body['budgetSeconds']) - 0.5)
        ANALYSIS_PLAN.set({})
        DEFER_BROWSER.set(body.get('deferBrowser') is True)
        try:
            return analyze(body['url'], int(body['maxBytes']), bool(body.get('policyRestricted')))
        except Exception as error:
            return {**error_payload(error), 'pagePlan':ANALYSIS_PLAN.get()}
    if body.get('phase') == 'prepare':
        ANALYSIS_END.set(time.monotonic() + float(body['budgetSeconds']) - 0.5)
        REQUEST_CONTEXT.set([])
        response, final_url = _open(body['url'], method='GET', timeout=5, max_redirects=3, max_body=1_000_000)
        try:
            if 'html' not in response.headers.get('Content-Type','').lower():
                raise ValueError('main_video_not_html')
            content = response.read(1_000_001)
            if len(content) > 1_000_000: raise ValueError('main_video_response_limit')
            return page_plan(content.decode('utf-8','replace'), final_url)
        finally: response.close()
    if body.get('phase') == 'validate':
        ANALYSIS_END.set(time.monotonic()+float(body['budgetSeconds'])-0.5)
        REQUEST_CONTEXT.set(body.get('requestContext') or [])
        result = _analyze_direct(body['url'], int(body['maxBytes']))
        if not result or any(not m.get('downloadable') or m.get('mediaType') != 'video' for m in result['media']):
            raise ValueError('main_video_candidate_rejected')
        result['extractor'] = 'main-video'
        result['browserFallbackUsed'] = body.get('browserUsed',True) is True
        for media in result['media']:
            media['_downloadRoute']['strictPublicEgress'] = True
            media['_downloadRoute']['requestContext'] = REQUEST_CONTEXT.get()
        return result
    async def bounded():
        return await asyncio.wait_for(discover(body['url'], body['allowedHosts'], float(body['budgetSeconds']) - 0.5, plan=body.get('plan')),
                                      max(0.05, float(body['budgetSeconds']) - 0.5))
    return asyncio.run(bounded())


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        # Neither browser error strings nor the source URL enter logs/output.
        print(json.dumps(error_payload(error)))
