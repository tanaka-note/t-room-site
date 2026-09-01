import unittest
from unittest.mock import patch

from ssrf import SafeUrl, UnsafeUrl
from resolver import MEDIA_SUFFIXES, ResolverError, _drm_dash, _encrypted_hls, _live_media_playlist, _refine_signature_type, _signature_type, _validate_dash_manifest, _validate_hls_tree, analyze


class ResolverSignatureTests(unittest.TestCase):
    @patch("resolver.validate_url", return_value=SafeUrl("https://r3.googlevideo.com/videoplayback", "r3.googlevideo.com"))
    @patch("resolver._analyze_direct", return_value={"media": [{"downloadable": True}], "extractor": "direct"})
    def test_policy_restricted_direct_media_is_analysis_only(self, _direct, _validate):
        result = analyze("https://r3.googlevideo.com/videoplayback", 1024, policy_restricted=True)
        self.assertFalse(result["media"][0]["downloadable"])
        self.assertIn("利用規約", result["media"][0]["unavailableReason"])

    def test_declared_generic_video_inputs_are_all_routed_to_inspection(self):
        for extension in (".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".wmv", ".asf", ".ogv", ".3gp", ".3g2", ".vob"):
            self.assertIn(extension, MEDIA_SUFFIXES)

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

    def test_container_magic_keeps_a_compatible_url_format_hint(self):
        self.assertEqual(_refine_signature_type(("video/x-matroska", ".mkv"), ".webm"), ("video/webm", ".webm"))
        self.assertEqual(_refine_signature_type(("application/ogg", ".ogg"), ".ogv"), ("video/ogg", ".ogv"))
        self.assertEqual(_refine_signature_type(("video/mp4", ".mp4"), ".mov"), ("video/quicktime", ".mov"))
        self.assertEqual(_refine_signature_type(("video/mp2t", ".ts"), ".mts"), ("video/mp2t", ".mts"))

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
