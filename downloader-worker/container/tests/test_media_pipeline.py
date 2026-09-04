import unittest

from media_pipeline import PlanKind, enforce_video_transcode_budget, plan_mp4
from scanner import UnsafeFile


def probe(container="matroska,webm", video="h264", audio="aac", pix="yuv420p", audio_count=1, duration="60"):
    streams = [{"codec_type": "video", "codec_name": video, "pix_fmt": pix, "width": 1920, "height": 1080, "duration": duration}]
    streams += [{"codec_type": "audio", "codec_name": audio, "duration": duration} for _ in range(audio_count)]
    return {"format": {"format_name": container, "duration": duration}, "streams": streams}


class MediaPlannerTests(unittest.TestCase):
    def test_compatible_mp4_passes_through(self):
        self.assertEqual(plan_mp4(probe(container="mov,mp4,m4a,3gp,3g2,mj2")).kind, PlanKind.PASS_THROUGH)

    def test_compatible_streams_are_remuxed(self):
        self.assertEqual(plan_mp4(probe()).kind, PlanKind.REMUX)

    def test_only_incompatible_audio_is_transcoded(self):
        plan = plan_mp4(probe(audio="opus"))
        self.assertEqual(plan.kind, PlanKind.PARTIAL_TRANSCODE)
        self.assertEqual((plan.video_codec, plan.audio_codec), ("copy", "aac"))

    def test_only_incompatible_video_is_transcoded(self):
        plan = plan_mp4(probe(video="vp9"))
        self.assertEqual(plan.kind, PlanKind.PARTIAL_TRANSCODE)
        self.assertEqual((plan.video_codec, plan.audio_codec), ("libx264", "copy"))

    def test_both_incompatible_stream_types_are_transcoded(self):
        self.assertEqual(plan_mp4(probe(video="av1", audio="opus")).kind, PlanKind.FULL_TRANSCODE)

    def test_10_bit_h264_is_transcoded_for_compatibility(self):
        self.assertEqual(plan_mp4(probe(pix="yuv420p10le")).kind, PlanKind.PARTIAL_TRANSCODE)

    def test_actual_probe_budget_rejects_special_h264_pixel_format(self):
        value = probe(pix="yuv420p10le", duration="241")
        plan = plan_mp4(value)
        with self.assertRaisesRegex(UnsafeFile, "video_transcode_budget"):
            enforce_video_transcode_budget(value, plan)

    def test_actual_probe_budget_keeps_audio_only_transcode(self):
        value = probe(audio="opus", duration="3600")
        plan = plan_mp4(value)
        self.assertEqual(enforce_video_transcode_budget(value, plan), 0)

    def test_actual_probe_budget_uses_resolution_and_frame_rate(self):
        value = probe(video="vp9", duration="300")
        value["streams"][0].update({"width": 1280, "height": 720, "r_frame_rate": "30000/1001"})
        plan = plan_mp4(value)
        self.assertLess(enforce_video_transcode_budget(value, plan), 240)

    def test_video_without_audio_is_supported(self):
        self.assertEqual(plan_mp4(probe(audio_count=0)).kind, PlanKind.REMUX)

    def test_multiple_compatible_audio_streams_remain_stream_copy(self):
        plan = plan_mp4(probe(audio_count=3))
        self.assertEqual((plan.kind, plan.video_codec, plan.audio_codec), (PlanKind.REMUX, "copy", "copy"))

    def test_rotation_metadata_does_not_force_quality_loss(self):
        value = probe()
        value["streams"][0]["tags"] = {"rotate": "90"}
        self.assertEqual(plan_mp4(value).kind, PlanKind.REMUX)

    def test_cover_art_and_subtitles_do_not_replace_the_playable_video(self):
        value = probe()
        value["streams"] = [
            {"index": 0, "codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
            {"index": 1, "codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "width": 320, "height": 240, "duration": "60"},
            {"index": 2, "codec_type": "audio", "codec_name": "aac", "duration": "60"},
            {"index": 3, "codec_type": "subtitle", "codec_name": "subrip", "duration": "60"},
        ]
        self.assertEqual(plan_mp4(value).kind, PlanKind.REMUX)

    def test_attachment_and_data_streams_are_rejected(self):
        for stream_type in ["attachment", "data"]:
            value = probe()
            value["streams"].append({"codec_type": stream_type})
            with self.subTest(stream_type=stream_type):
                self.assertEqual(plan_mp4(value).reason, "unsafe_embedded_stream")

    def test_limits_are_fail_closed(self):
        too_long = probe(duration=str(4 * 60 * 60))
        self.assertEqual(plan_mp4(too_long).kind, PlanKind.REJECT)
        no_video = {"format": {"duration": "60"}, "streams": [{"codec_type": "audio", "codec_name": "aac"}]}
        self.assertEqual(plan_mp4(no_video).kind, PlanKind.REJECT)


if __name__ == "__main__":
    unittest.main()
