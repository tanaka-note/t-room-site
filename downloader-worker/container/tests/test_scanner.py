import unittest
import tempfile
import os
import time
from pathlib import Path
from unittest.mock import patch

from scanner import UnsafeFile, _reject_filename, _scan_large_file_windows, _scan_malware, clamav_database_status, inspect_file, require_fresh_clamav_definitions, safe_filename


def clamav_header(build_time: int) -> bytes:
    return f"ClamAV-VDB:01 Jan 2026 00-00 +0000:1:1:90:md5:sig:test:{build_time}".encode().ljust(512, b" ")


class ScannerPolicyTests(unittest.TestCase):
    def test_clamav_definitions_are_required_and_must_be_fresh(self):
        built_at = 1_800_000_000
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(UnsafeFile, "malware_definitions_missing"):
                require_fresh_clamav_definitions(root, now=built_at)
            for name in ("main", "daily", "bytecode"):
                definition = root / f"{name}.cvd"
                definition.write_bytes(clamav_header(built_at))
                os.utime(definition, (1, 1))
            with patch("scanner._clamav_database_signature_is_valid", return_value=True):
                status = clamav_database_status(root, now=built_at + 1)
                self.assertTrue(status["healthy"])
                self.assertEqual(status["dailyDefinitionUnix"], built_at)
                self.assertEqual(status["freshnessSource"], "daily_database_build_time")
                self.assertEqual(set(status["databases"]), {"main", "daily", "bytecode"})
                with self.assertRaisesRegex(UnsafeFile, "malware_definitions_stale"):
                    require_fresh_clamav_definitions(root, now=built_at + 8 * 24 * 60 * 60)

    def test_missing_or_invalid_individual_database_fails_closed(self):
        built_at = 1_800_000_000
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("main", "daily"):
                (root / f"{name}.cvd").write_bytes(clamav_header(built_at))
            with patch("scanner._clamav_database_signature_is_valid", return_value=True), self.assertRaisesRegex(UnsafeFile, "malware_definitions_missing"):
                require_fresh_clamav_definitions(root, now=built_at)
            (root / "bytecode.cvd").write_bytes(clamav_header(built_at))
            with patch("scanner._clamav_database_signature_is_valid", side_effect=lambda path: path.name != "main.cvd"), self.assertRaisesRegex(UnsafeFile, "malware_definitions_invalid"):
                require_fresh_clamav_definitions(root, now=built_at)

    def test_invalid_database_header_fails_closed_even_with_fresh_mtime(self):
        with tempfile.TemporaryDirectory() as directory:
            definition = Path(directory) / "daily.cvd"
            definition.write_bytes(b"not-a-clamav-database")
            os.utime(definition, (time.time(), time.time()))
            with self.assertRaisesRegex(UnsafeFile, "malware_definitions_missing"):
                require_fresh_clamav_definitions(Path(directory))

    @patch("scanner.require_fresh_clamav_definitions")
    @patch("scanner.start_clamav_daemon")
    @patch("scanner.subprocess.run")
    def test_scan_uses_the_fail_closed_daemon_configuration(self, run, _daemon, _definitions):
        run.return_value.returncode = 0
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.mp4"
            path.write_bytes(b"fixture")
            _scan_malware(path)
        command = run.call_args.args[0]
        self.assertEqual(command[0], "clamdscan")
        config_argument = next(value for value in command if value.startswith("--config-file="))
        self.assertEqual(Path(config_argument.split("=", 1)[1]).name, "clamd.conf")
        self.assertIn("--fdpass", command)

    @patch("scanner.require_fresh_clamav_definitions")
    @patch("scanner.start_clamav_daemon")
    @patch("scanner.subprocess.run", side_effect=__import__("subprocess").TimeoutExpired("clamdscan", 600))
    def test_scan_timeout_fails_closed(self, _run, _daemon, _definitions):
        with self.assertRaisesRegex(UnsafeFile, "malware_scan_timeout"):
            _scan_malware(Path("fixture.mp4"))

    @patch("scanner._clamd_stream", side_effect=[b"stream: OK\0", b"stream: OK\0", b"stream: Tail.Test FOUND\0"])
    def test_windowed_scan_rejects_a_signature_in_the_final_window(self, stream):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.bin"
            with path.open("wb") as output:
                output.seek(128 * 1024 * 1024 - 1)
                output.write(b"\0")
            with self.assertRaisesRegex(UnsafeFile, "malware_detected"):
                _scan_large_file_windows(path)
        self.assertEqual(stream.call_count, 3)

    def test_malware_scan_runs_before_ffprobe(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "movie.mp4"
            path.write_bytes(b"media")
            order = []
            with patch("scanner._detect_mime", side_effect=lambda _path: order.append("magic") or "video/mp4"), \
                 patch("scanner._scan_malware", side_effect=lambda _path: order.append("clamav")), \
                 patch("scanner.probe_file", side_effect=lambda _path: order.append("ffprobe") or {"streams": [{"codec_type": "video"}]}), \
                 patch("scanner._sha256", return_value="0" * 64):
                inspect_file(path, "movie.mp4", "video/mp4", 1024)
            self.assertEqual(order, ["magic", "clamav", "ffprobe"])

    def test_executable_archive_and_double_extension_are_rejected(self):
        for name in ["movie.mp4.exe", "archive.zip", "run.ps1", "movie.mp4.js"]:
            with self.subTest(name=name), self.assertRaises(UnsafeFile):
                _reject_filename(name)

    def test_media_filename_and_command_injection_text_are_data_only(self):
        _reject_filename("movie.test.mp4")
        name = safe_filename("$(touch hacked);movie.mp4\r\nX: y")
        self.assertNotIn("/", name)
        self.assertNotIn("\r", name)
        self.assertNotIn("\n", name)

    def test_html_disguised_as_mp4_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fake.mp4"
            path.write_text("<html>not media</html>", encoding="utf-8")
            with patch("scanner._detect_mime", return_value="text/html"), patch("scanner.probe_file", return_value={"streams": []}), self.assertRaisesRegex(UnsafeFile, "unsupported_mime"):
                inspect_file(path, "fake.mp4", "video/mp4", 1024)

    def test_executable_magic_is_rejected_before_external_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "movie.mp4"
            path.write_bytes(b"MZ" + b"\x00" * 64)
            with self.assertRaisesRegex(UnsafeFile, "executable_content"):
                inspect_file(path, "movie.mp4", "video/mp4", 1024)

    def test_oversized_file_is_rejected_before_external_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "movie.mp4"
            path.write_bytes(b"\x00" * 32)
            with self.assertRaisesRegex(UnsafeFile, "size_limit"):
                inspect_file(path, "movie.mp4", "video/mp4", 16)

    def test_ogv_uses_ffprobe_video_stream_for_mp4_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "movie.ogv"
            path.write_bytes(b"OggS" + b"\x00" * 64)
            probe = {"streams": [{"codec_type": "video", "codec_name": "theora"}]}
            with patch("scanner._detect_mime", return_value="application/ogg"), \
                 patch("scanner.probe_file", return_value=probe), \
                 patch("scanner._scan_malware"), \
                 patch("scanner._sha256", return_value="0" * 64):
                result = inspect_file(path, "movie.ogv", "video/ogg", 1024)
            self.assertEqual(result.media_kind, "video")

    def test_still_image_is_not_classified_as_video_from_ffprobe_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cover.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
            probe = {"streams": [{"codec_type": "video", "codec_name": "png"}]}
            with patch("scanner._detect_mime", return_value="image/png"), \
                 patch("scanner.probe_file", return_value=probe), \
                 patch("scanner._scan_malware"), \
                 patch("scanner._sha256", return_value="0" * 64):
                result = inspect_file(path, "cover.png", "image/png", 1024)
            self.assertEqual(result.media_kind, "image")

    def test_audio_cover_art_is_not_classified_as_video(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "song.m4a"
            path.write_bytes(b"media")
            probe = {"streams": [
                {"codec_type": "audio", "codec_name": "aac"},
                {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
            ]}
            with patch("scanner._detect_mime", return_value="audio/mp4"), \
                 patch("scanner.probe_file", return_value=probe), \
                 patch("scanner._scan_malware"), \
                 patch("scanner._sha256", return_value="0" * 64):
                result = inspect_file(path, "song.m4a", "audio/mp4", 1024)
            self.assertEqual(result.media_kind, "audio")

    def test_subtitle_is_allowed_but_attachment_and_data_are_rejected(self):
        base = [{"codec_type": "video", "codec_name": "h264", "index": 0}]
        for allowed in [base + [{"codec_type": "subtitle", "codec_name": "subrip"}]]:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "movie.mkv"
                path.write_bytes(b"media")
                with patch("scanner._detect_mime", return_value="video/x-matroska"), \
                     patch("scanner.probe_file", return_value={"streams": allowed}), \
                     patch("scanner._scan_malware"), patch("scanner._sha256", return_value="0" * 64):
                    self.assertEqual(inspect_file(path, path.name, None, 1024).media_kind, "video")
        for stream_type in ["attachment", "data"]:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "movie.mkv"
                path.write_bytes(b"media")
                with patch("scanner._detect_mime", return_value="video/x-matroska"), \
                     patch("scanner.probe_file", return_value={"streams": base + [{"codec_type": stream_type}]}), \
                     patch("scanner._scan_malware"), self.assertRaisesRegex(UnsafeFile, "unsafe_embedded_stream"):
                    inspect_file(path, path.name, None, 1024)


if __name__ == "__main__":
    unittest.main()
