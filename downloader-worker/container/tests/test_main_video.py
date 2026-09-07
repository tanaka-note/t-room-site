import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

from main_video import discover, run_phase, stop_process_tree
from resolver import ResolverError, _drm_dash, analyze
from ssrf import SafeUrl


class MainVideoUnitTests(unittest.TestCase):
    def test_namespaced_drm_is_rejected(self):
        self.assertTrue(_drm_dash(b'<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011"><d:ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></d:MPD>'))
        self.assertFalse(_drm_dash(b'<MPD><Period/></MPD>'))

    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    def test_existing_successes_keep_routes_and_do_not_import_browser(self, _safe):
        result={'extractor':'existing','media':[{'downloadable':True}]}
        for stage in ['direct','yt-dlp','html','chromium']:
            with self.subTest(stage=stage), patch('resolver._analyze_direct',return_value=result if stage=='direct' else None), \
                 patch('resolver._yt_dlp_metadata',return_value=result if stage=='yt-dlp' else None), \
                 patch('resolver._normalize_ytdlp',return_value=result), \
                 patch('resolver._analyze_html',side_effect=[result] if stage=='html' else [None,result]), \
                 patch('main_video.discover') as extra:
                self.assertIs(analyze('https://example.com/watch',1024),result)
                extra.assert_not_called()

    @patch('resolver.validate_url', return_value=SafeUrl('https://example.com/watch','example.com'))
    @patch('resolver._analyze_direct',return_value=None)
    def test_restrictions_and_unknown_failures_never_reach_browser(self,*_):
        for code in ['drm','encrypted_stream','login_required','geo_restricted','extractor_failed','metadata_timeout']:
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
                root=f'http://127.0.0.1:{self.server.server_port}'
                iframe=self.path=='/iframe'
                embed='/frame' if iframe else ''
                metadata={'@type':'VideoObject','mainEntityOfPage':root+self.path,'contentUrl':root+'/main.m3u8','name':'Main','embedUrl':root+embed if embed else ''}
                player='<main><video width="640" height="360"></video></main>'
                if self.path=='/ambiguous': player+='<main><video width="640" height="360"></video></main>'
                if iframe: player='<main><iframe src="/frame" width="640" height="360"></iframe></main>'
                script="const v=document.querySelector('video'); if(v){v.src=URL.createObjectURL(new MediaSource()); fetch('/advert.mp4').catch(()=>{}); fetch('/main.m3u8').catch(()=>{});}"
                if self.path=='/ad-only': script=script.replace("fetch('/main.m3u8').catch(()=>{});",'')
                html=f'<html><head><script type="application/ld+json">{json.dumps(metadata)}</script></head><body>{player}<script>{script}</script></body></html>'
                if self.path=='/restricted': html=html.replace('<body>','<body><input type="password">')
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
            return asyncio.run(asyncio.wait_for(discover(root+path,['127.0.0.1'],8,os.environ['MAIN_VIDEO_TEST_BROWSER']),9))

    def test_js_blob_main_and_related_iframe(self):
        for path in ['/watch','/iframe']:
            with self.subTest(path=path): self.assertTrue(self.run_browser(path)['url'].endswith('/main.m3u8'))

    def test_ads_ambiguity_and_login_are_not_adopted(self):
        for path in ['/ad-only','/ambiguous','/restricted']:
            with self.subTest(path=path),self.assertRaises(ValueError): self.run_browser(path)
