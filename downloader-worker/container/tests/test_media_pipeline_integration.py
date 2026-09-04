import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from media_pipeline import PlanKind, normalize_video
from scanner import probe_file


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe integration runtime is not installed")
class MediaPipelineIntegrationTests(unittest.TestCase):
    def _generate(self, path: Path, video_codec: str, audio_codec: str, *extra: str):
        result = subprocess.run([
            FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
            "-shortest", "-c:v", video_codec, "-pix_fmt", "yuv420p", "-c:a", audio_codec, *extra,
            str(path),
        ], capture_output=True, text=True, check=False, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)

    def _normalize(self, source: Path, expected: PlanKind):
        output, name, mime, plan = normalize_video(source, source.name, 64 * 1024 * 1024, 120)
        self.assertEqual(plan.kind, expected)
        self.assertEqual(mime, "video/mp4")
        self.assertTrue(name.endswith(".mp4"))
        probe = probe_file(output)
        video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
        self.assertEqual((video["codec_name"], video["pix_fmt"]), ("h264", "yuv420p"))
        self.assertTrue(all(stream["codec_name"] == "aac" for stream in probe["streams"] if stream["codec_type"] == "audio"))

    def test_mp4_h264_aac_passes_through(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "compatible.mp4"
            self._generate(source, "libx264", "aac", "-movflags", "+faststart")
            self._normalize(source, PlanKind.PASS_THROUGH)

    def test_compatible_mp4_without_faststart_is_remuxed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "slow-start.mp4"
            self._generate(source, "libx264", "aac")
            self._normalize(source, PlanKind.REMUX)

    def test_mkv_h264_aac_is_remuxed_without_transcoding(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "compatible.mkv"
            self._generate(source, "libx264", "aac")
            self._normalize(source, PlanKind.REMUX)

    def test_mkv_h264_opus_transcodes_only_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "audio-incompatible.mkv"
            self._generate(source, "libx264", "libopus")
            self._normalize(source, PlanKind.PARTIAL_TRANSCODE)

    def test_webm_vp9_opus_is_fully_transcoded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "incompatible.webm"
            self._generate(source, "libvpx-vp9", "libopus")
            self._normalize(source, PlanKind.FULL_TRANSCODE)

    def test_h264_ten_bit_is_reencoded_and_checked_by_actual_probe_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "h264-ten-bit.mkv"
            result = subprocess.run([
                FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1",
                "-f", "lavfi", "-i", "sine=duration=1", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "aac", str(source),
            ], capture_output=True, text=True, check=False, timeout=90)
            self.assertEqual(result.returncode, 0, result.stderr)
            self._normalize(source, PlanKind.PARTIAL_TRANSCODE)

    def test_mov_h264_aac_is_preserved_when_already_compatible(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "compatible.mov"
            self._generate(source, "libx264", "aac", "-movflags", "+faststart")
            self._normalize(source, PlanKind.PASS_THROUGH)

    def test_avi_mpeg4_mp3_is_fully_transcoded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "legacy.avi"
            self._generate(source, "mpeg4", "libmp3lame")
            self._normalize(source, PlanKind.FULL_TRANSCODE)

    def test_transport_stream_h264_aac_is_remuxed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "broadcast.ts"
            self._generate(source, "libx264", "aac")
            self._normalize(source, PlanKind.REMUX)

    def test_ogv_theora_vorbis_is_fully_transcoded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "legacy.ogv"
            self._generate(source, "libtheora", "libvorbis")
            self._normalize(source, PlanKind.FULL_TRANSCODE)

    def test_subtitle_stream_is_safely_dropped_during_mp4_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subtitle = root / "caption.srt"
            subtitle.write_text("1\n00:00:00,000 --> 00:00:00,800\ncaption\n", encoding="utf-8")
            source = root / "subtitled.mkv"
            result = subprocess.run([
                FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=1",
                "-f", "lavfi", "-i", "sine=duration=1", "-i", str(subtitle),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "srt", str(source),
            ], capture_output=True, text=True, check=False, timeout=90)
            self.assertEqual(result.returncode, 0, result.stderr)
            output, _name, _mime, _plan = normalize_video(source, source.name, 64 * 1024 * 1024, 120)
            self.assertFalse(any(stream.get("codec_type") == "subtitle" for stream in probe_file(output)["streams"]))
