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


if __name__ == "__main__":
    unittest.main()
