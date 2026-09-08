import asyncio
import json
import importlib.util
import os
import subprocess
import sys
import threading
import time
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.error import HTTPError

from main_video import discover, run_phase, stop_process_tree, page_plan, error_payload
from resolver import ResolverError, _drm_dash, analyze, ANALYSIS_END, ANALYSIS_PLAN, DEFER_BROWSER, REQUEST_CONTEXT, MediaHtmlParser, media_request_headers, download, _analysis_command, _open, _at_stage
from ssrf import SafeUrl


class MainVideoUnitTests(unittest.TestCase):
    def test_related_cdn_is_deferred_before_any_candidate_request(self):
        from resolver import _analyze_html
        token=DEFER_BROWSER.set(True); plan=ANALYSIS_PLAN.set({})
        response=SimpleNamespace(headers={'Content-Type':'text/html'},read=lambda n:b'<main><video src="https://cdn.example/media"></video></main>',close=lambda:None)
        try:
            with patch('resolver._open',return_value=(response,'https://example.com/watch')),patch('resolver._analyze_direct') as direct:
                self.assertIsNone(_analyze_html('https://example.com/watch',1024,False))
                direct.assert_not_called();self.assertEqual(ANALYSIS_PLAN.get()['candidate'],'https://cdn.example/media')
        finally: DEFER_BROWSER.reset(token);ANALYSIS_PLAN.reset(plan)

    def test_static_main_selection_data_src_metadata_ads_and_ambiguity(self):
        cases=[
            ('<aside class="ads"><video src="/first.mp4"></video></aside><main><video data-src="/main.mp4"></video></main>',['https://example.com/main.mp4']),
            ('<main><video><source data-src="/main.mp4"></video></main><section class="related"><video src="/other.mp4"></video></section>',['https://example.com/main.mp4']),
            ('<video src="/one.mp4"></video><video src="/two.mp4"></video>',[]),
            ('<main><video src="/preview.mp4"></video></main>',[]),
            ('<script type="application/ld+json">{"@type":"VideoObject","mainEntityOfPage":"/watch","contentUrl":"/media"}</script>',['https://example.com/media']),
            ('<script type="application/ld+json">{"@type":"VideoObject","mainEntityOfPage":"/other","contentUrl":"/media"}</script>',[]),
            ('<script type="application/ld+json">{"@type":"VideoObject","mainEntityOfPage":"/watch","contentUrl":"/media","embedUrl":"/frame"}</script>',[]),
        ]
        for html,expected in cases:
            parser=MediaHtmlParser('https://example.com/watch');parser.feed(html)
            self.assertEqual(parser.candidates,expected)

    def test_single_browser_policy_keeps_direct_and_specialized_success(self):
        token=DEFER_BROWSER.set(True); plan=ANALYSIS_PLAN.set({})
        try:
            with patch('resolver.validate_url',return_value=SafeUrl('https://example.com/watch','example.com')), \
                 patch('resolver._analyze_direct',return_value=None),patch('resolver.has_specialized_extractor',return_value=False), \
                 patch('resolver._analyze_html',return_value=None) as html,patch('resolver._yt_dlp_metadata',return_value=None):
                with self.assertRaisesRegex(ResolverError,'media_not_found'): analyze('https://example.com/watch',1024)
                self.assertEqual(html.call_args_list[0].kwargs,{'browser':False})
                self.assertEqual(html.call_count,1)
        finally: DEFER_BROWSER.reset(token); ANALYSIS_PLAN.reset(plan)

    def test_declared_player_skips_generic_extractor_ad_selection(self):
        token=DEFER_BROWSER.set(True); plan=ANALYSIS_PLAN.set({'hasPlayers':True})
        try:
            with patch('resolver.validate_url',return_value=SafeUrl('https://example.com/watch','example.com')), \
                 patch('resolver._analyze_direct',return_value=None),patch('resolver.has_specialized_extractor',return_value=False), \
                 patch('resolver._analyze_html',return_value=None),patch('resolver._yt_dlp_metadata') as metadata:
                with self.assertRaisesRegex(ResolverError,'media_not_found'): analyze('https://example.com/watch',1024)
                metadata.assert_not_called()
        finally: DEFER_BROWSER.reset(token); ANALYSIS_PLAN.reset(plan)

    def test_header_scope_and_download_context_reset(self):
        context=[{'origin':'https://cdn.example','refererOrigin':'https://page.example','sendOrigin':True}]
        with patch('resolver.validate_url',side_effect=lambda x:SafeUrl(x,urlsplit(x).hostname)):
            headers=media_request_headers('https://cdn.example/media?secret',context)
            self.assertEqual(headers['Referer'],'https://page.example/')
            self.assertEqual(headers['Origin'],'https://page.example')
            self.assertNotIn('Referer',media_request_headers('https://other.example/media',context))
            with self.assertRaisesRegex(ResolverError,'download_context_invalid'):
                media_request_headers('https://cdn.example/media',[{**context[0],'refererOrigin':'https://page.example/?secret'}])
            with patch('resolver._download_direct') as direct, tempfile.TemporaryDirectory() as directory:
                route={'version':1,'kind':'direct','url':'https://cdn.example/media','strictPublicEgress':True,'requestContext':context}
                direct.side_effect=lambda *a,**k:self.assertEqual(REQUEST_CONTEXT.get(),context)
                download(route,Path(directory),1024,5)
                self.assertIsNone(REQUEST_CONTEXT.get())

    def test_strict_redirect_checks_every_hop_and_strips_context_on_unlisted_origin(self):
        token=REQUEST_CONTEXT.set([])
        seen=[]
        def opening(req,**kw):
            seen.append(req.full_url)
            if len(seen)==1: raise HTTPError(req.full_url,302,'redirect',{'Location':'/final'},None)
            return SimpleNamespace(headers={},close=lambda:None)
        safe=lambda x:SafeUrl(x,urlsplit(x).hostname)
        try:
            with patch('resolver.validate_url',side_effect=safe),patch('ssrf.validate_url',side_effect=lambda x,**kw:safe(x)), \
                 patch('resolver.build_opener',return_value=SimpleNamespace(open=opening)):
                _,final=_open('https://example.com/start',method='GET',timeout=1,max_redirects=3)
                self.assertEqual(final,'https://example.com/final');self.assertEqual(len(seen),2)
            attempts=[]
            def redirects(req,**kw):
                attempts.append(req.full_url)
                raise HTTPError(req.full_url,302,'redirect',{'Location':'/next'},None)
            with patch('resolver.validate_url',side_effect=safe),patch('ssrf.validate_url',side_effect=lambda x,**kw:safe(x)), \
                 patch('resolver.build_opener',return_value=SimpleNamespace(open=redirects)):
                with self.assertRaisesRegex(ResolverError,'main_video_redirect_rejected'):
                    _open('https://example.com/start',method='GET',timeout=1,max_redirects=5)
                self.assertEqual(len(attempts),4)
            with patch('resolver.validate_url',side_effect=safe), \
                 patch('resolver.validate_redirect',return_value=SafeUrl('https://elsewhere.example/','elsewhere.example')), \
                 patch('resolver.build_opener',return_value=SimpleNamespace(open=lambda *a,**kw:(_ for _ in ()).throw(HTTPError('https://example.com/',302,'redirect',{'Location':'https://elsewhere.example/'},None)))):
                with self.assertRaisesRegex(ResolverError,'main_video_redirect_rejected'):
                    _open('https://example.com/start',method='GET',timeout=1,max_redirects=3)
        finally: REQUEST_CONTEXT.reset(token)

    def test_http_provenance_stage_and_challenge_survive_without_secrets(self):
        token=ANALYSIS_END.set(time.monotonic()+10)
        try:
            for source,expected in [('upstream','bot_challenge'),('egress','egress_denied')]:
                headers={'x-tlain-egress-source':source,'cf-mitigated':'challenge','Set-Cookie':'secret'}
                upstream=HTTPError('https://example.com/?secret',403,'private text',headers,None)
                with patch('resolver.validate_url',return_value=SafeUrl('https://example.com/','example.com')), \
                     patch('resolver.build_opener',return_value=SimpleNamespace(open=lambda *a,**kw: (_ for _ in ()).throw(upstream))):
                    with self.assertRaises(ResolverError) as raised:
                        _at_stage('direct',lambda:_open('https://example.com/',method='GET',timeout=1,max_redirects=0))
                    payload=error_payload(raised.exception)
                    self.assertEqual(payload,{'errorCode':expected,'diagnostic':{'stage':'direct','source':source,'httpStatus':403}})
                    self.assertNotIn('secret',json.dumps(payload))
            self.assertEqual(error_payload(RuntimeError('https://example.com/?secret'))['errorCode'],'analysis_execution_failed')
        finally: ANALYSIS_END.reset(token)

    def test_child_error_metadata_is_preserved_and_sanitized_before_server(self):
        payload={'errorCode':'bot_challenge','diagnostic':{'stage':'direct','source':'upstream','httpStatus':403,'cookie':'secret'}}
        proc=SimpleNamespace(returncode=0,communicate=lambda *a,**kw:(json.dumps(payload),None),wait=lambda:None)
        with patch('main_video.subprocess.Popen',return_value=proc),patch('main_video.stop_process_tree') as stop:
            with self.assertRaises(ResolverError) as raised: run_phase({'phase':'analyze','budgetSeconds':2})
            self.assertEqual(raised.exception.diagnostic,{'stage':'direct','source':'upstream','httpStatus':403})
            stop.assert_called_once_with(proc)

    @unittest.skipUnless(importlib.util.find_spec('yt_dlp'), 'installed in production runtime')
    def test_actual_extractor_selection_is_offline_and_keeps_youtube(self):
        from resolver import has_specialized_extractor
        self.assertTrue(has_specialized_extractor('https://www.youtube.com/watch?v=BaW_jenozKc'))
        self.assertFalse(has_specialized_extractor('https://example.com/watch/123'))

    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    @patch('resolver._analyze_direct', return_value=None)
    def test_recoverable_metadata_errors_continue_and_known_budget_is_preserved(self, *_):
        result={'extractor':'html-generic','media':[]}
        for specialized in [True, False]:
            for code in ['metadata_timeout','extractor_failed',None]:
                with self.subTest(specialized=specialized,code=code), \
                     patch('resolver.has_specialized_extractor',return_value=specialized), \
                     patch('resolver._yt_dlp_metadata',side_effect=ResolverError(code) if code else None,return_value=None) as metadata, \
                     patch('resolver._analyze_html',side_effect=[result] if specialized else [None,result]) as html:
                    self.assertIs(analyze('https://example.com/watch',1024),result)
                    self.assertEqual(metadata.call_args.kwargs['timeout'],90 if specialized else 8)
                    self.assertEqual(html.call_count,1 if specialized else 2)

    def test_unique_main_iframe_and_only_declared_dependencies(self):
        plan=page_plan('<iframe class="advert" src="https://ads.example/ad"></iframe><main><div class="player"><iframe data-src="https://player.example/embed/123"></iframe></div></main><script src="https://static.example/player.js"></script>', 'https://example.com/watch/123')
        self.assertEqual(plan['embed'],'https://player.example/embed/123')
        self.assertEqual(plan['scripts'],['https://static.example/player.js'])
        self.assertEqual(page_plan('<main><iframe src="/a"></iframe><iframe src="/b"></iframe></main>', 'https://example.com')['embed'],'')

    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    @patch('resolver._analyze_direct', return_value=None)
    @patch('resolver.has_specialized_extractor', return_value=False)
    def test_iframe_skips_dump_dom_and_deadline_prevents_another_stage(self, *_):
        plan_token=ANALYSIS_PLAN.set({'embed':'https://player.example/embed'})
        try:
            with patch('resolver._analyze_html',return_value=None) as html,patch('resolver._yt_dlp_metadata',return_value=None):
                with self.assertRaisesRegex(ResolverError,'media_not_found'): analyze('https://example.com/watch',1024)
                html.assert_called_once()
            deadline=ANALYSIS_END.set(time.monotonic()-1)
            try:
                with patch('resolver._analyze_html') as html:
                    with self.assertRaisesRegex(ResolverError,'analysis_deadline_exceeded'): analyze('https://example.com/watch',1024)
                    html.assert_not_called()
            finally: ANALYSIS_END.reset(deadline)
        finally: ANALYSIS_PLAN.reset(plan_token)

    def test_runtime_command_timeout_kills_owned_process_before_return(self):
        class Fake:
            returncode=None
            stdout=SimpleNamespace(close=lambda:None)
            stderr=SimpleNamespace(close=lambda:None)
            def communicate(self,**kwargs): raise subprocess.TimeoutExpired('fixture',1)
            def wait(self): pass
        proc=Fake();token=ANALYSIS_END.set(time.monotonic()+1)
        try:
            with patch('resolver.subprocess.Popen',return_value=proc),patch('main_video.stop_process_tree') as stop:
                with self.assertRaises(subprocess.TimeoutExpired): _analysis_command(['fixture'],1,{})
                stop.assert_called_once_with(proc)
        finally: ANALYSIS_END.reset(token)

    def test_namespaced_drm_is_rejected(self):
        self.assertTrue(_drm_dash(b'<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011"><d:ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></d:MPD>'))
        self.assertFalse(_drm_dash(b'<MPD><Period/></MPD>'))

    @patch('resolver.has_specialized_extractor', return_value=True)
    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    def test_existing_successes_keep_routes_and_do_not_import_browser(self, *_):
        result={'extractor':'existing','media':[{'downloadable':True}]}
        for stage in ['direct','yt-dlp','html','chromium']:
            with self.subTest(stage=stage), patch('resolver._analyze_direct',return_value=result if stage=='direct' else None), \
                 patch('resolver._yt_dlp_metadata',return_value=result if stage=='yt-dlp' else None), \
                 patch('resolver._normalize_ytdlp',return_value=result), \
                 patch('resolver._analyze_html',side_effect=[result] if stage=='html' else [None,result]), \
                 patch('main_video.discover') as extra:
                self.assertIs(analyze('https://example.com/watch',1024),result)
                extra.assert_not_called()

    @patch('resolver.has_specialized_extractor', return_value=True)
    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    @patch('resolver._analyze_direct',return_value=None)
    def test_restrictions_and_unknown_failures_never_reach_browser(self,*_):
        for code in ['drm','encrypted_stream','login_required','geo_restricted','bot_challenge','access_denied']:
            with patch('resolver._yt_dlp_metadata',side_effect=ResolverError(code)),patch('resolver._analyze_html') as html:
                with self.assertRaisesRegex(ResolverError,code): analyze('https://example.com/watch',1024)
                html.assert_not_called()

    def test_budget_rejection_and_hard_timeout_cleanup(self):
        with self.assertRaisesRegex(ResolverError,'timeout'): run_phase({'budgetSeconds':0})
        proc=SimpleNamespace(pid=123,returncode=None,communicate=lambda *a,**k: (_ for _ in ()).throw(subprocess.TimeoutExpired('safe',1)),wait=lambda:None)
        with patch('main_video.subprocess.Popen',return_value=proc),patch('main_video.stop_process_tree') as stop:
            with self.assertRaisesRegex(ResolverError,'timeout'): run_phase({'budgetSeconds':100})
            stop.assert_called_once_with(proc)

    def test_real_owned_child_tree_stops(self):
        # Small sleeping processes only, never a download or scan.
        code='import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"]); print(p.pid,flush=True); time.sleep(30)'
        proc=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,text=True,start_new_session=os.name!='nt')
        child=int(proc.stdout.readline())
        try:
            stop_process_tree(proc)
            proc.wait(timeout=3)
            if os.name=='nt':
                result=subprocess.run(['tasklist','/FI',f'PID eq {child}','/FO','CSV','/NH'],capture_output=True,text=True)
                self.assertNotIn(f'"{child}"',result.stdout)
            else:
                stat=Path(f'/proc/{child}/stat')
                self.assertTrue(not stat.exists() or stat.read_text().rsplit(')',1)[1].split()[0]=='Z')
        finally:
            if proc.poll() is None: stop_process_tree(proc)
            proc.stdout.close()


@unittest.skipUnless(os.environ.get('MAIN_VIDEO_TEST_BROWSER'),'explicit small real-browser suite')
class MainVideoBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                if self.path=='/alias':
                    self.send_response(302);self.send_header('Location','/watch');self.end_headers();return
                if self.path=='/cross-redirect':
                    self.send_response(302);self.send_header('Location','https://example.invalid/private');self.end_headers();return
                if self.path=='/media-endpoint':
                    root=f'http://127.0.0.1:{self.server.server_port}'
                    if self.headers.get('Referer')!=root+'/':
                        self.send_response(403);self.end_headers();return
                    body=b'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n'
                    self.send_response(200);self.send_header('Content-Type','application/vnd.apple.mpegurl');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
                if self.path=='/media-file':
                    root=f'http://127.0.0.1:{self.server.server_port}'
                    if self.headers.get('Referer')!=root+'/':
                        self.send_response(403);self.end_headers();return
                    body=b'\x00\x00\x00\x18ftypisom'+b'\0'*20
                    self.send_response(200);self.send_header('Content-Type','video/mp4');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
                if self.path in {'/challenge','/challenge200','/egress'}:
                    self.send_response(200 if self.path=='/challenge200' else 403)
                    self.send_header('cf-mitigated','challenge')
                    self.send_header('x-tlain-egress-source','egress' if self.path=='/egress' else 'upstream')
                    self.end_headers();return
                root=f'http://127.0.0.1:{self.server.server_port}'
                iframe=self.path in {'/iframe','/embedded','/iframe-restricted'}
                embed=('/frame-restricted' if self.path=='/iframe-restricted' else '/frame') if iframe else ''
                metadata={'@type':'VideoObject','mainEntityOfPage':root+self.path,'contentUrl':root+'/main.m3u8','name':'Main','embedUrl':root+embed if embed else ''}
                player='<main><video width="640" height="360"></video></main>'
                if self.path=='/ambiguous': player+='<main><video width="640" height="360"></video></main>'
                if iframe: player=f'<main><iframe src="{embed}" width="640" height="360"></iframe></main>'
                script="const v=document.querySelector('video'); if(v){v.src=URL.createObjectURL(new MediaSource()); fetch('/advert.mp4').catch(()=>{}); fetch('/main.m3u8').catch(()=>{});}"
                if self.path=='/ad-only': script=script.replace("fetch('/main.m3u8').catch(()=>{});",'')
                if self.path=='/embedded' or self.path=='/frame':
                    metadata={}
                    script=script.replace("fetch('/advert.mp4').catch(()=>{});",'')
                html=f'<html><head><script type="application/ld+json">{json.dumps(metadata)}</script></head><body>{player}<script>{script}</script></body></html>'
                if self.path in {'/restricted','/frame-restricted'}: html=html.replace('<body>','<body><input type="password">')
                if self.path=='/button-extensionless':
                    html='''<html><head></head><body><main id="player"><video width="640" height="360"></video><button aria-label="Play video">Play</button></main><script>
                    document.querySelector('button').onclick=()=>{const v=document.querySelector('video');v.src=URL.createObjectURL(new MediaSource());fetch('/media-endpoint').catch(()=>{});};
                    </script></body></html>'''
                if self.path=='/data-source':
                    html='<html><head></head><body><main><video width="640" height="360" src="/main.m3u8"></video></main></body></html>'
                if self.path=='/dynamic-metadata':
                    html='<html><head></head><body><script>const m=document.createElement("meta");m.setAttribute("property","og:video");m.content="/main.mp4";document.head.append(m)</script></body></html>'
                self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode())
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()

    @classmethod
    def tearDownClass(cls): cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def run_browser(self,path):
        root=f'http://127.0.0.1:{self.server.server_port}'
        # Only these test-owned local fixture sockets bypass public-IP policy.
        def safe(url):
            parsed=urlsplit(url)
            if parsed.hostname!='127.0.0.1' or parsed.port!=self.server.server_port: raise ValueError('fixture_host_blocked')
            return SafeUrl(url,parsed.hostname)
        with patch('main_video.validate_url',side_effect=safe):
            plan={'embed':root+'/frame'} if path in {'/iframe','/embedded'} else None
            return asyncio.run(asyncio.wait_for(discover(root+path,['127.0.0.1'],8,os.environ['MAIN_VIDEO_TEST_BROWSER'],plan),9))

    def test_js_blob_main_and_related_iframe(self):
        for path in ['/watch','/iframe','/embedded']:
            with self.subTest(path=path): self.assertTrue(self.run_browser(path)['url'].endswith('/main.m3u8'))

    def test_ads_ambiguity_and_login_are_not_adopted(self):
        for path in ['/ad-only','/ambiguous','/restricted']:
            with self.subTest(path=path),self.assertRaises(ValueError): self.run_browser(path)

    def test_browser_navigation_reports_upstream_challenge_and_own_denial(self):
        for path,code,source in [('/challenge','bot_challenge','upstream'),('/challenge200','bot_challenge','upstream'),('/egress','egress_denied','egress')]:
            with self.subTest(path=path),self.assertRaises(ResolverError) as raised: self.run_browser(path)
            self.assertEqual(str(raised.exception),code)
            self.assertEqual(raised.exception.diagnostic,{'source':source,'httpStatus':200 if path=='/challenge200' else 403})

    def test_explicit_button_extensionless_mime_referrer_and_same_origin_redirect(self):
        for path,suffix in [('/button-extensionless','/media-endpoint'),('/alias','/main.m3u8'),('/data-source','/main.m3u8'),('/dynamic-metadata','/main.mp4')]:
            with self.subTest(path=path):
                result=self.run_browser(path)
                self.assertTrue(result['url'].endswith(suffix))
                self.assertEqual(result['metrics']['browserLaunches'],1)
                self.assertLessEqual(result['metrics']['requests'],32)
                self.assertLessEqual(result['metrics']['bodyBytes'],2_000_000)
                self.assertLess(result['metrics']['elapsedMs'],8000)
                if path=='/button-extensionless': self.assertTrue(result['refererOrigin'].startswith('http://127.0.0.1:'))

    def test_context_survives_manifest_revalidation_and_actual_small_download(self):
        from resolver import _analyze_direct
        root=f'http://127.0.0.1:{self.server.server_port}'
        def safe(value):
            p=urlsplit(value)
            if p.hostname!='127.0.0.1' or p.port!=self.server.server_port: raise ValueError('fixture_host_blocked')
            return SafeUrl(value,p.hostname)
        context=[{'origin':root,'refererOrigin':root,'sendOrigin':False}]
        with patch('resolver.validate_url',side_effect=safe):
            token=REQUEST_CONTEXT.set(context)
            try:
                # HEAD is intentionally unsupported by this fixture: range GET,
                # signature read and the HLS tree must all preserve context.
                adaptive=_analyze_direct(root+'/media-endpoint',1024)
                self.assertEqual(adaptive['media'][0]['delivery'],'hls')
                self.assertTrue(adaptive['media'][0]['downloadable'])
                direct=_analyze_direct(root+'/media-file',1024)['media'][0]['_downloadRoute']
            finally: REQUEST_CONTEXT.reset(token)
            with tempfile.TemporaryDirectory() as directory:
                path,_,_=download({**direct,'strictPublicEgress':True,'requestContext':context},Path(directory),1024,5)
                self.assertEqual(path.read_bytes(),b'\x00\x00\x00\x18ftypisom'+b'\0'*20)
            self.assertIsNone(REQUEST_CONTEXT.get())

    def test_structured_url_never_skips_restricted_embedded_player(self):
        with self.assertRaisesRegex(ValueError,'main_video_restricted'):
            self.run_browser('/iframe-restricted')
