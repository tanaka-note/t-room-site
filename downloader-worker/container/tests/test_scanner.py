import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from scanner import UnsafeFile, _reject_filename, inspect_file, safe_filename


class ScannerPolicyTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
