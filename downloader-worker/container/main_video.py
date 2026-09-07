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
from pathlib import Path
from urllib.parse import urlsplit

from ssrf import validate_url


# Require one page-level VideoObject and a matching player. A large player or
# the first media request alone is deliberately insufficient evidence.
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
  const candidates = values.filter(x => {
    const owner = x.mainEntityOfPage?.['@id'] || x.mainEntityOfPage || x.url;
    return typeof owner === 'string' && key(owner) === key(canonical) &&
      key(canonical) === key(location.href) && x.isAccessibleForFree !== false &&
      typeof x.contentUrl === 'string' && !x.requiresSubscription;
  });
  if (candidates.length !== 1) return null;
  const x = candidates[0];
  return {url:key(x.contentUrl), embed:x.embedUrl ? key(x.embedUrl) : '',
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
  if (src !== candidate && !src.startsWith('blob:')) return null;
  if (play && v.paused) { v.muted=true; v.play().catch(()=>{}); }
  return {src, drm:!!v.mediaKeys};
}"""

RESTRICTED = r"""() => !!window.__mainVideoDRM || !!document.querySelector('input[type="password"]') ||
 /sign in to watch|log in to watch|login required|verify you are human|checking your browser|not available in your country|access denied|ログインが必要|ログインして視聴|地域制限|人間であることを確認/i.test((document.body?.innerText||'').slice(0,100000))"""


async def discover(url: str, allowed_hosts: list[str], timeout: float, browser_path=None) -> dict:
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
                        if not owner or owner['embed'] != target.value:
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
                metadata = await page.evaluate(METADATA)
                if metadata:
                    candidate = validate_url(metadata['url']).value
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
                            if any(value == candidate and owner == frame for value, owner in requests):
                                matches.append(frame)
                    if len(matches) == 1:
                        return {'url': candidate, 'title': metadata['title']}
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
    budget = min(10.0, max(0.0, float(body.get('budgetSeconds', 0))))
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
            if process.returncode or len(output) > 65536:
                raise ResolverError('main_video_failed')
            result = json.loads(output)
            if result.get('errorCode'):
                raise ResolverError(result['errorCode'])
            return result
        except subprocess.TimeoutExpired:
            raise ResolverError('main_video_timeout') from None
        finally:
            stop_process_tree(process)
            process.wait()


def main():
    from resolver import _analyze_direct
    body = json.loads(sys.stdin.read(16385))
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
        return await asyncio.wait_for(discover(body['url'], body['allowedHosts'], float(body['budgetSeconds']) - 0.5),
                                      max(0.05, float(body['budgetSeconds']) - 0.5))
    return asyncio.run(bounded())


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        # Neither browser error strings nor the source URL enter logs/output.
        print(json.dumps({'errorCode': 'main_video_unavailable'}))
