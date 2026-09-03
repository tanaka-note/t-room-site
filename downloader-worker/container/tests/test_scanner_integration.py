import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from scanner import UnsafeFile, _scan_malware, inspect_file


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
CLAMSCAN = shutil.which("clamscan")
FILE = shutil.which("file")


@unittest.skipUnless(FFMPEG and FFPROBE and CLAMSCAN and FILE, "container media tools are not installed")
class ScannerIntegrationTests(unittest.TestCase):
    def _run(self, *arguments):
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_audio_and_image_fixtures_are_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = [
                ("tone.mp3", ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "libmp3lame"], "audio/mpeg", "audio"),
                ("tone.aac", ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "aac", "-f", "adts"], "audio/aac", "audio"),
                ("tone.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "aac"], "audio/mp4", "audio"),
                ("image.png", ["-f", "lavfi", "-i", "color=green:size=32x32", "-frames:v", "1"], "image/png", "image"),
                ("image.jpg", ["-f", "lavfi", "-i", "color=blue:size=32x32", "-frames:v", "1"], "image/jpeg", "image"),
                ("image.webp", ["-f", "lavfi", "-i", "color=red:size=32x32", "-frames:v", "1"], "image/webp", "image"),
            ]
            for name, encoder, declared, expected_kind in fixtures:
                with self.subTest(name=name):
                    path = root / name
                    self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *encoder, str(path))
                    result = inspect_file(path, name, declared, 8 * 1024 * 1024)
                    self.assertEqual(result.media_kind, expected_kind)

    def test_expanded_audio_video_and_image_fixtures_are_scanned(self):
        audio_input = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2"]
        video_input = ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5:duration=0.4", "-an"]
        fixtures = [
            ("tone.wav", audio_input + ["-c:a", "pcm_s16le"], "audio"),
            ("tone.wave", audio_input + ["-c:a", "pcm_s16le", "-f", "wav"], "audio"),
            ("tone.aiff", audio_input + ["-c:a", "pcm_s16be"], "audio"),
            ("tone.aif", audio_input + ["-c:a", "pcm_s16be", "-f", "aiff"], "audio"),
            ("tone.aifc", audio_input + ["-c:a", "pcm_s16be", "-f", "aiff"], "audio"),
            ("tone.ac3", audio_input + ["-c:a", "ac3"], "audio"),
            ("tone.eac3", audio_input + ["-c:a", "eac3"], "audio"),
            ("tone.wma", audio_input + ["-c:a", "wmav2", "-f", "asf"], "audio"),
            ("tone.mka", audio_input + ["-c:a", "flac", "-f", "matroska"], "audio"),
            ("tone.wv", audio_input + ["-c:a", "wavpack"], "audio"),
            ("tone.au", audio_input + ["-c:a", "pcm_s16be"], "audio"),
            ("tone.mp2", audio_input + ["-c:a", "mp2"], "audio"),
            ("video.h264", video_input + ["-c:v", "libx264", "-f", "h264"], "video"),
            ("video.264", video_input + ["-c:v", "libx264", "-f", "h264"], "video"),
            ("video.h265", video_input + ["-c:v", "libx265", "-x265-params", "log-level=error", "-f", "hevc"], "video"),
            ("video.hevc", video_input + ["-c:v", "libx265", "-x265-params", "log-level=error", "-f", "hevc"], "video"),
            ("video.265", video_input + ["-c:v", "libx265", "-x265-params", "log-level=error", "-f", "hevc"], "video"),
            ("video.m1v", ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=0.4", "-an", "-c:v", "mpeg1video", "-f", "mpeg1video"], "video"),
            ("video.ivf", video_input + ["-c:v", "libvpx-vp9", "-f", "ivf"], "video"),
            ("video.mxf", ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=0.4", "-an", "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-f", "mxf"], "video"),
            ("video.mjpeg", video_input + ["-c:v", "mjpeg", "-f", "mjpeg"], "video"),
            ("video.mjpg", video_input + ["-c:v", "mjpeg", "-f", "mjpeg"], "video"),
            ("video.wtv", ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=0.4", "-f", "lavfi", "-i", "sine=duration=0.4", "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "wtv"], "video"),
            ("image.bmp", ["-f", "lavfi", "-i", "color=green:size=32x32", "-frames:v", "1", "-c:v", "bmp"], "image"),
            ("image.tiff", ["-f", "lavfi", "-i", "color=blue:size=32x32", "-frames:v", "1", "-c:v", "tiff"], "image"),
            ("image.tif", ["-f", "lavfi", "-i", "color=red:size=32x32", "-frames:v", "1", "-c:v", "tiff", "-f", "image2"], "image"),
            ("image.apng", ["-f", "lavfi", "-i", "testsrc2=size=32x32:rate=5:duration=0.4", "-plays", "0", "-f", "apng"], "image"),
            ("image.avif", ["-f", "lavfi", "-i", "color=yellow:size=32x32", "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1"], "image"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, arguments, expected_kind in fixtures:
                with self.subTest(name=name):
                    path = root / name
                    self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *arguments, str(path))
                    result = inspect_file(path, name, None, 32 * 1024 * 1024)
                    self.assertEqual(result.media_kind, expected_kind)

    def test_embedded_cover_art_remains_audio_and_subtitle_mkv_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "audio.mp3"
            cover = root / "cover.jpg"
            song = root / "song-with-cover.mp3"
            self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "libmp3lame", str(audio))
            self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=32x32", "-frames:v", "1", str(cover))
            self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio), "-i", str(cover), "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic", str(song))
            self.assertEqual(inspect_file(song, song.name, "audio/mpeg", 8 * 1024 * 1024).media_kind, "audio")

            subtitle = root / "caption.srt"
            subtitle.write_text("1\n00:00:00,000 --> 00:00:00,300\ncaption\n", encoding="utf-8")
            movie = root / "subtitled.mkv"
            self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5:duration=0.4", "-i", str(subtitle), "-c:v", "libx264", "-c:s", "srt", str(movie))
            self.assertEqual(inspect_file(movie, movie.name, "video/x-matroska", 8 * 1024 * 1024).media_kind, "video")

    def test_reject_fixtures_cover_corruption_spoofing_limits_and_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            oversized = root / "oversized.mp4"
            oversized.write_bytes(b"0" * 4097)
            with self.assertRaisesRegex(UnsafeFile, "size_limit"):
                inspect_file(oversized, oversized.name, "video/mp4", 4096)

            executable = root / "executable.mp4"
            executable.write_bytes(b"MZ" + b"0" * 128)
            with self.assertRaisesRegex(UnsafeFile, "executable_content"):
                inspect_file(executable, executable.name, "video/mp4", 4096)

            archive = root / "archive.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("harmless.txt", "fixture")
            with self.assertRaisesRegex(UnsafeFile, "blocked_extension"):
                inspect_file(archive, archive.name, "application/zip", 4096)

            double_extension = root / "photo.png.exe"
            double_extension.write_bytes(b"fixture")
            with self.assertRaisesRegex(UnsafeFile, "blocked_extension"):
                inspect_file(double_extension, double_extension.name, "image/png", 4096)

            corrupt = root / "corrupt.mp4"
            corrupt.write_bytes(b"not a media container")
            with self.assertRaises(UnsafeFile):
                inspect_file(corrupt, corrupt.name, "video/mp4", 4096)

            png = root / "real-image.png"
            self._run(FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                      "-f", "lavfi", "-i", "color=white:size=32x32", "-frames:v", "1", str(png))
            with self.assertRaisesRegex(UnsafeFile, "extension_mismatch"):
                inspect_file(png, "disguised.mp4", "application/octet-stream", 4096)

    def test_eicar_fixture_is_rejected_by_real_clamav(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "eicar.txt"
            path.write_text("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", encoding="ascii")
            with self.assertRaisesRegex(UnsafeFile, "malware_detected"):
                _scan_malware(path)

    def test_real_clamav_detects_signature_near_tail_beyond_default_pcre_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large-tail-eicar.bin"
            signature = Path(directory) / "tail-test.ndb"
            signature.write_text(
                "Tlain.Test.Tail:0:*:544c61696e446f776e6c6f616465725461696c4d616c7761726546697874757265\n",
                encoding="ascii",
            )
            with path.open("wb") as output:
                output.seek(128 * 1024 * 1024)
                output.write(b"TLainDownloaderTailMalwareFixture")
            result = subprocess.run([
                CLAMSCAN, "--database=/var/lib/clamav", f"--database={signature}",
                "--no-summary", "--infected", "--alert-exceeds-max=yes",
                "--max-filesize=2147483648", "--max-scansize=2147483648",
                "--pcre-max-filesize=2147483648", "--max-scantime=0", "--", str(path),
            ], capture_output=True, text=True, timeout=600, check=False)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Tlain.Test.Tail", result.stdout)


if __name__ == "__main__":
    unittest.main()
