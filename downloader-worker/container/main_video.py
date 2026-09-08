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
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from ssrf import validate_url


AD_MARKER = re.compile(r'(^|[\s_-])(ad|ads|advert|advertisement|sponsor|related|preview|trailer)([\s_-]|$)', re.I)
PLAYER_MARKER = re.compile(r'player|video|embed|watch', re.I)


def page_plan(html, url):
    """Only document-declared scripts and one main player, never arbitrary links.

    The Worker validates public DNS for every proposed exact host before it
    changes the job-local egress policy. URLs stay in memory, never in logs.
    """
    class Parser(HTMLParser):
        def __init__(self):
            super().__init__(); self.stack = []; self.embeds = []; self.scripts = []
        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            marker = ' '.join(str(a.get(k, '')) for k in ('id', 'class', 'title', 'aria-label'))
            ad = bool(AD_MARKER.search(marker)) or any(x[1] for x in self.stack)
            main = tag == 'main' or a.get('role') == 'main' or bool(PLAYER_MARKER.search(marker)) or any(x[2] for x in self.stack)
            src = a.get('src') or a.get('data-src')
            if tag == 'iframe' and src and main and not ad:
                target = urljoin(url, src)
                if urlsplit(target).scheme in {'http', 'https'}: self.embeds.append(target)
            if tag == 'script' and a.get('src') and not ad:
                self.scripts.append(urljoin(url, a['src']))
            if tag not in {'meta','link','img','source','input','br','hr','area','base','embed','wbr','track'}:
                self.stack.append((tag, ad, main))
        def handle_endtag(self, tag):
            for i in range(len(self.stack)-1, -1, -1):
                if self.stack[i][0] == tag:
                    del self.stack[i:]; break
    parser = Parser(); parser.feed(html[:2_000_000])
    embeds = list(dict.fromkeys(parser.embeds))
    return {'page': url, 'embed': embeds[0] if len(embeds) == 1 else '',
            'scripts': list(dict.fromkeys(parser.scripts))[:8]}


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
    return embedded || !!v.closest('main,[role="main"]');
  });
  if (videos.length !== 1) return null;
  const v=videos[0], src=v.currentSrc || v.src;
  // An identified source must match the page's content URL. Blob is accepted
  // only later, when the same frame actually requested that exact content URL.
  if (candidate && src !== candidate && !src.startsWith('blob:')) return null;
  if (play && v.paused) { v.muted=true; v.play().catch(()=>{}); }
  return {src, drm:!!v.mediaKeys};
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
    failed = False
    count = 0
    transferred = 0
    started = time.monotonic()
    plan = plan or {}

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
                        failed = True
                        return await route.abort()
                    if req.resource_type in {'media', 'fetch', 'xhr'}:
                        if len(requests) < 32:
                            requests.append((target.value, req.frame))
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
                    response = await route.fetch(
                        headers={'User-Agent': 'Mozilla/5.0', 'Accept': '*/*'},
                        max_redirects=0, timeout=max(1, (timeout - (time.monotonic()-started)) * 1000),
                    )
                    if response.status in {401, 403, 407, 429, 451}:
                        failed = True
                    # Redirects are intentionally denied in this initial public
                    # subset: no unvalidated redirect is followed by the browser.
                    if response.status >= 300 or int(response.headers.get('content-length', '0')) > 1_000_000:
                        return await route.abort()
                    body = await response.body()
                    transferred += len(body)
                    if len(body) > 1_000_000 or transferred > 2_000_000:
                        failed = True
                        return await route.abort()
                    headers = {k:v for k,v in response.headers.items() if k.lower() not in {'set-cookie','content-length','content-encoding','location'}}
                    await route.fulfill(status=response.status, headers=headers, body=body)
                except Exception:
                    failed = True
                    await route.abort()

            await context.route('**/*', intercept)
            await page.goto(safe.value, wait_until='domcontentloaded', timeout=max(1, timeout * 1000))
            played = False
            while time.monotonic() - started < timeout - 0.2:
                if failed or await page.evaluate(RESTRICTED):
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
                                urlsplit(value).path.lower().endswith(('.m3u8','.mpd','.mp4','.webm')) and
                                not AD_MARKER.search(urlsplit(value).path.replace('/', ' '))))
                            selected = candidate or (player['src'] if player['src'].startswith(('http://','https://')) else
                                                     observed[0] if len(observed) == 1 else '')
                            if selected and any(value == selected and owner == frame for value, owner in requests):
                                matches.append(validate_url(selected).value)
                    if len(matches) == 1:
                        return {'url': matches[0], 'title': metadata['title']}
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
                error = ResolverError(result['errorCode'])
                error.page_plan = result.get('pagePlan')
                raise error
            return result
        except subprocess.TimeoutExpired:
            raise ResolverError('analysis_deadline_exceeded' if analyzing else 'main_video_timeout') from None
        finally:
            stop_process_tree(process)
            process.wait()


def main():
    from resolver import _analyze_direct, analyze, ANALYSIS_END, ANALYSIS_PLAN, _open
    body = json.loads(sys.stdin.read(16385))
    if body.get('phase') == 'analyze':
        ANALYSIS_END.set(time.monotonic() + float(body['budgetSeconds']) - 0.5)
        ANALYSIS_PLAN.set({})
        try:
            return analyze(body['url'], int(body['maxBytes']), bool(body.get('policyRestricted')))
        except Exception as error:
            code = str(error)
            return {'errorCode':code if re.fullmatch('[a-z][a-z0-9_]{0,79}',code) else 'analysis_execution_failed',
                    'pagePlan':ANALYSIS_PLAN.get()}
    if body.get('phase') == 'prepare':
        ANALYSIS_END.set(time.monotonic() + float(body['budgetSeconds']) - 0.5)
        response, final_url = _open(body['url'], method='GET', timeout=5, max_redirects=0, max_body=1_000_000)
        try:
            if 'html' not in response.headers.get('Content-Type','').lower():
                raise ValueError('main_video_not_html')
            content = response.read(1_000_001)
            if len(content) > 1_000_000: raise ValueError('main_video_response_limit')
            return page_plan(content.decode('utf-8','replace'), final_url)
        finally: response.close()
    if body.get('phase') == 'validate':
        result = _analyze_direct(body['url'], int(body['maxBytes']))
        if not result or any(not m.get('downloadable') or m.get('mediaType') != 'video' for m in result['media']):
            raise ValueError('main_video_candidate_rejected')
        result['extractor'] = 'main-video'
        result['browserFallbackUsed'] = True
        for media in result['media']:
            media['_downloadRoute']['strictPublicEgress'] = True
        return result
    async def bounded():
        return await asyncio.wait_for(discover(body['url'], body['allowedHosts'], float(body['budgetSeconds']) - 0.5, plan=body.get('plan')),
                                      max(0.05, float(body['budgetSeconds']) - 0.5))
    return asyncio.run(bounded())


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        # Neither browser error strings nor the source URL enter logs/output.
        print(json.dumps({'errorCode': 'main_video_unavailable'}))
