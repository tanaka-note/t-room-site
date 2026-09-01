import unittest

from media_pipeline import PlanKind, plan_mp4


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

    def test_video_without_audio_is_supported(self):
        self.assertEqual(plan_mp4(probe(audio_count=0)).kind, PlanKind.REMUX)

    def test_multiple_compatible_audio_streams_remain_stream_copy(self):
        plan = plan_mp4(probe(audio_count=3))
        self.assertEqual((plan.kind, plan.video_codec, plan.audio_codec), (PlanKind.REMUX, "copy", "copy"))

    def test_rotation_metadata_does_not_force_quality_loss(self):
        value = probe()
        value["streams"][0]["tags"] = {"rotate": "90"}
        self.assertEqual(plan_mp4(value).kind, PlanKind.REMUX)

    def test_limits_are_fail_closed(self):
        too_long = probe(duration=str(4 * 60 * 60))
        self.assertEqual(plan_mp4(too_long).kind, PlanKind.REJECT)
        no_video = {"format": {"duration": "60"}, "streams": [{"codec_type": "audio", "codec_name": "aac"}]}
        self.assertEqual(plan_mp4(no_video).kind, PlanKind.REJECT)


if __name__ == "__main__":
    unittest.main()
