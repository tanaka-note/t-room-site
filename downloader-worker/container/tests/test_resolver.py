import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest.mock import patch

from ssrf import SafeUrl, UnsafeUrl
from resolver import MEDIA_SUFFIXES, ResolverError, _classify_ytdlp_failure, _drm_dash, _encrypted_hls, _live_media_playlist, _media_type, _normalize_ytdlp, _open, _refine_direct_type, _refine_signature_type, _signature_type, _validate_dash_manifest, _validate_hls_tree, _yt_dlp_metadata, analyze, download


class ResolverSignatureTests(unittest.TestCase):
    @patch("resolver.validate_url", return_value=SafeUrl("https://cdn.example/resolved.mp4", "cdn.example"))
    @patch("resolver._download_direct")
    def test_download_uses_exact_analyzed_direct_route_without_rediscovery(self, direct_download, _validate):
        with tempfile.TemporaryDirectory() as directory:
            path, name, mime = download({
                "version": 1, "kind": "direct", "url": "https://cdn.example/resolved.mp4",
                "delivery": "direct", "filename": "resolved.mp4", "mime": "video/mp4",
            }, Path(directory), 1024, 60)
        self.assertEqual(path.name, "resolved.mp4")
        self.assertEqual((name, mime), ("resolved.mp4", "video/mp4"))
        direct_download.assert_called_once()

    @patch("resolver.build_opener")
    @patch("resolver.validate_url", return_value=SafeUrl("https://media.example/video.mp4", "media.example"))
    def test_direct_request_uses_only_allowlisted_headers(self, _validate, build_opener):
        response = SimpleNamespace(headers={}, close=lambda: None)
        build_opener.return_value.open.return_value = response
        _open(
            "https://media.example/video.mp4", method="GET", timeout=5, max_redirects=0,
            request_headers={
                "Range": "bytes=0-10", "Cookie": "secret", "Authorization": "Bearer secret",
                "Referer": "https://tanaka-note.com/", "Origin": "https://tanaka-note.com",
                "X-Forwarded-For": "203.0.113.2", "User-Agent": "user-browser",
            },
        )
        request = build_opener.return_value.open.call_args.args[0]
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["user-agent"], "Mozilla/5.0")
        self.assertEqual(headers["range"], "bytes=0-10")
        for forbidden in ("cookie", "authorization", "referer", "origin", "x-forwarded-for"):
            self.assertNotIn(forbidden, headers)

    @patch("resolver.validate_url", return_value=SafeUrl("https://r3.googlevideo.com/videoplayback", "r3.googlevideo.com"))
    @patch("resolver._analyze_direct", return_value={"media": [{"downloadable": True}], "extractor": "direct"})
    def test_policy_restricted_direct_media_is_analysis_only(self, _direct, _validate):
        result = analyze("https://r3.googlevideo.com/videoplayback", 1024, policy_restricted=True)
        self.assertFalse(result["media"][0]["downloadable"])
        self.assertIn("利用規約", result["media"][0]["unavailableReason"])

    def test_declared_generic_video_inputs_are_all_routed_to_inspection(self):
        for extension in (".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".wmv", ".asf", ".ogv", ".3gp", ".3g2", ".vob"):
            self.assertIn(extension, MEDIA_SUFFIXES)

    def test_expanded_safe_media_suffixes_are_routed_to_inspection(self):
        extensions = {
            ".wav", ".wave", ".aiff", ".aif", ".aifc", ".ac3", ".eac3", ".wma", ".mka",
            ".wv", ".au", ".mp2", ".h264", ".264", ".h265", ".hevc", ".265", ".m1v",
            ".ivf", ".mxf", ".mjpeg", ".mjpg", ".wtv", ".bmp", ".tiff", ".tif", ".avif", ".apng",
        }
        self.assertTrue(extensions.issubset(set(MEDIA_SUFFIXES)))

    def test_extensionless_hls_and_dash_signatures(self):
        self.assertEqual(_signature_type(b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8")[1], ".m3u8")
        self.assertEqual(_signature_type(b"<?xml version='1.0'?><MPD></MPD>")[1], ".mpd")

    def test_common_video_magic(self):
        self.assertEqual(_signature_type(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00")[1], ".mp4")
        self.assertEqual(_signature_type(b"RIFF\x00\x00\x00\x00AVI ")[1], ".avi")
        self.assertEqual(_signature_type(b"FLV\x01\x05"), ("video/x-flv", ".flv"))
        self.assertEqual(_signature_type(b"0&\xb2u\x8ef\xcf\x11\xa6\xd9\x00\xaa\x00b\xcel"), ("video/x-ms-wmv", ".wmv"))
        self.assertEqual(_signature_type(b"OggS\x00\x02"), ("application/ogg", ".ogg"))
        m2ts = bytearray(197)
        m2ts[4] = 0x47
        m2ts[196] = 0x47
        self.assertEqual(_signature_type(bytes(m2ts)), ("video/mp2t", ".m2ts"))

    def test_common_audio_and_image_magic(self):
        self.assertEqual(_signature_type(b"ID3\x04\x00"), ("audio/mpeg", ".mp3"))
        self.assertEqual(_signature_type(b"fLaC\x00\x00"), ("audio/flac", ".flac"))
        self.assertEqual(_signature_type(b"\x89PNG\r\n\x1a\n"), ("image/png", ".png"))
        self.assertEqual(_signature_type(b"RIFF\x00\x00\x00\x00WAVE"), ("audio/wav", ".wav"))
        self.assertEqual(_signature_type(b"FORM\x00\x00\x00\x00AIFF"), ("audio/aiff", ".aiff"))
        self.assertEqual(_signature_type(b"BM" + b"\x00" * 20), ("image/bmp", ".bmp"))
        self.assertEqual(_signature_type(b"II*\x00" + b"\x00" * 20), ("image/tiff", ".tiff"))

    def test_m4a_mka_wma_avif_signature_refinement(self):
        self.assertEqual(_refine_signature_type(("video/mp4", ".mp4"), ".m4a"), ("audio/mp4", ".m4a"))
        self.assertEqual(_refine_signature_type(("video/x-matroska", ".mkv"), ".mka"), ("audio/x-matroska", ".mka"))
        self.assertEqual(_refine_signature_type(("video/x-ms-wmv", ".wmv"), ".wma"), ("audio/x-ms-wma", ".wma"))
        self.assertEqual(_signature_type(b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00"), ("image/avif", ".avif"))

    def test_live_metadata_is_non_downloadable_before_queueing(self):
        result = _normalize_ytdlp({
            "id": "live", "title": "live", "is_live": True,
            "formats": [{"format_id": "1", "url": "https://media.example/live", "ext": "mp4", "vcodec": "h264", "acodec": "aac"}],
        }, "media.example", False)
        self.assertTrue(result["media"])
        self.assertTrue(all(not item["downloadable"] for item in result["media"]))
        self.assertTrue(all("ライブ" in item["unavailableReason"] for item in result["media"]))

    def test_ytdlp_route_records_only_validated_media_hosts(self):
        def validate(value):
            hostname = urlsplit(value).hostname
            if not hostname:
                raise UnsafeUrl("invalid_url")
            return SafeUrl(value, hostname)

        metadata = {
            "id": "clip", "title": "clip", "webpage_url": "https://media.example/watch/1",
            "formats": [
                {"format_id": "v", "url": "https://video-cdn.example/v", "ext": "mp4", "vcodec": "h264", "acodec": "none"},
                {"format_id": "a", "url": "https://audio-cdn.example/a", "ext": "m4a", "vcodec": "none", "acodec": "aac"},
            ],
        }
        with patch("resolver.validate_url", side_effect=validate):
            result = _normalize_ytdlp(metadata, "media.example", False, "https://media.example/watch/1")
        self.assertEqual(result["media"][0]["_downloadRoute"]["egressHosts"], ["video-cdn.example", "audio-cdn.example"])

    def test_ytdlp_policy_failures_do_not_fall_through_to_generic_extractors(self):
        cases = {
            "DRM protected": "drm",
            "Please log in to continue": "login_required",
            "This video is not available in your country": "geo_restricted",
            "Extractor is disabled by policy": "extractor_intentionally_unsupported",
            "Upcoming premiere has not yet started": "live_stream_not_supported",
        }
        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(_classify_ytdlp_failure(message), expected)
        self.assertIsNone(_classify_ytdlp_failure("Unable to parse an ordinary public page"))
        self.assertIsNone(_classify_ytdlp_failure("This URL is not supported"))

    @patch("resolver.subprocess.run")
    def test_ytdlp_blocking_and_unknown_failures_are_closed_but_unsupported_can_fallback(self, run):
        run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Please log in to continue")
        with self.assertRaisesRegex(ResolverError, "login_required"):
            _yt_dlp_metadata("https://media.example/private", 5)
        command = run.call_args.args[0]
        self.assertIn("--ignore-config", command)
        self.assertIn("--no-cookies-from-browser", command)
        self.assertIn("--js-runtimes", command)
        self.assertNotIn("--netrc", command)
        self.assertNotIn("--netrc-cmd", command)

        run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Unable to parse an ordinary public page")
        with self.assertRaisesRegex(ResolverError, "extractor_failed"):
            _yt_dlp_metadata("https://media.example/public", 5)

        run.return_value = SimpleNamespace(returncode=1, stdout="", stderr="Unsupported URL: https://media.example/public")
        self.assertIsNone(_yt_dlp_metadata("https://media.example/public", 5))

    @patch("resolver._analyze_direct", return_value=None)
    @patch("resolver._yt_dlp_metadata", return_value=None)
    @patch("resolver.validate_url", side_effect=lambda value: SafeUrl(value, "media.example"))
    def test_html_analysis_preserves_the_exact_resolved_download_route(self, _validate, _metadata, _direct):
        resolved = {
            "site": "cdn.example", "title": "clip", "extractor": "direct",
            "media": [{
                "mediaId": "direct", "downloadable": True,
                "_downloadRoute": {"version": 1, "kind": "direct", "url": "https://cdn.example/resolved.mp4", "delivery": "direct"},
            }],
        }
        with patch("resolver._analyze_html", side_effect=[resolved, None]):
            result = analyze("https://media.example/page", 1024)
        self.assertEqual(result["media"][0]["_downloadRoute"]["url"], "https://cdn.example/resolved.mp4")

    def test_container_magic_keeps_a_compatible_url_format_hint(self):
        self.assertEqual(_refine_signature_type(("video/x-matroska", ".mkv"), ".webm"), ("video/webm", ".webm"))
        self.assertEqual(_refine_signature_type(("application/ogg", ".ogg"), ".ogv"), ("video/ogg", ".ogv"))
        self.assertEqual(_refine_signature_type(("video/mp4", ".mp4"), ".mov"), ("video/quicktime", ".mov"))
        self.assertEqual(_refine_signature_type(("video/mp2t", ".ts"), ".mts"), ("video/mp2t", ".mts"))

    def test_explicit_ogg_mime_wins_over_ambiguous_extension(self):
        self.assertEqual(_media_type("video/ogg", ".ogg"), "video")
        self.assertEqual(_media_type("audio/ogg", ".ogg"), "audio")
        self.assertEqual(_media_type("application/ogg", ".ogg"), "audio")
        self.assertEqual(
            _refine_direct_type(("application/ogg", ".ogg"), ".ogg", "video/ogg"),
            ("video/ogg", ".ogg"),
        )

    def test_encrypted_and_live_playlists_are_detected(self):
        self.assertTrue(_encrypted_hls(b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI='key'"))
        self.assertFalse(_encrypted_hls(b"#EXTM3U\n#EXT-X-KEY:METHOD=NONE"))
        self.assertTrue(_live_media_playlist(b"#EXTM3U\n#EXTINF:10,\na.ts"))
        self.assertFalse(_live_media_playlist(b"#EXTM3U\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST"))
        self.assertTrue(_drm_dash(b"<MPD><ContentProtection schemeIdUri='widevine'/></MPD>"))

    @patch("resolver.validate_url", side_effect=lambda value: SafeUrl(value, "media.example"))
    @patch("resolver._read_manifest")
    def test_nested_hls_encryption_is_rejected_before_download(self, read_manifest, _validate):
        read_manifest.side_effect = [
            (b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8", "https://media.example/master.m3u8"),
            (b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=key.bin\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST", "https://media.example/child.m3u8"),
        ]
        with self.assertRaisesRegex(ResolverError, "encrypted_stream_not_supported"):
            _validate_hls_tree("https://media.example/master.m3u8", set(), [0])

    @patch("resolver.validate_url", side_effect=lambda value: SafeUrl(value, "media.example"))
    @patch("resolver._read_manifest", return_value=(b"<MPD type='dynamic'></MPD>", "https://media.example/live.mpd"))
    def test_dynamic_dash_is_rejected_before_download(self, _read, _validate):
        with self.assertRaisesRegex(ResolverError, "live_stream_not_supported"):
            _validate_dash_manifest("https://media.example/live.mpd")

    @patch("resolver._read_manifest", return_value=(b"#EXTM3U\n#EXTINF:10,\nhttp://127.0.0.1/private.ts\n#EXT-X-ENDLIST", "https://media.example/vod.m3u8"))
    def test_hls_segment_private_address_is_rejected(self, _read):
        def policy(value):
            if "127.0.0.1" in value:
                raise UnsafeUrl("blocked_address")
            return SafeUrl(value, "media.example")
        with patch("resolver.validate_url", side_effect=policy), self.assertRaisesRegex(UnsafeUrl, "blocked_address"):
            _validate_hls_tree("https://media.example/vod.m3u8", set(), [0])

    @patch("resolver._read_manifest", return_value=(b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=http://169.254.169.254/key\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST", "https://media.example/vod.m3u8"))
    def test_hls_private_key_address_is_rejected_before_encryption_policy(self, _read):
        def policy(value):
            if "169.254.169.254" in value:
                raise UnsafeUrl("blocked_address")
            return SafeUrl(value, "media.example")
        with patch("resolver.validate_url", side_effect=policy), self.assertRaisesRegex(UnsafeUrl, "blocked_address"):
            _validate_hls_tree("https://media.example/vod.m3u8", set(), [0])

    @patch("resolver._read_manifest", return_value=(b"<MPD><BaseURL>http://169.254.169.254/latest/</BaseURL></MPD>", "https://media.example/vod.mpd"))
    def test_dash_private_base_url_is_rejected(self, _read):
        def policy(value):
            if "169.254.169.254" in value:
                raise UnsafeUrl("blocked_address")
            return SafeUrl(value, "media.example")
        with patch("resolver.validate_url", side_effect=policy), self.assertRaisesRegex(UnsafeUrl, "blocked_address"):
            _validate_dash_manifest("https://media.example/vod.mpd")


if __name__ == "__main__":
    unittest.main()
