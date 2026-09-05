from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from media_pipeline import MediaPlan, PlanKind
from server import Handler, JobDeadline, JobDeadlineExceeded


class ServerPipelineTests(unittest.TestCase):
    def _handler(self):
        handler = Handler.__new__(Handler)
        handler._json = lambda status, value: (status, value)
        return handler

    def _body(self):
        return {
            "route": {"version": 1},
            "maxBytes": 1024 * 1024,
            "timeoutSeconds": 120,
            "jobId": "job-deadline",
            "objectKey": "downloads/job-deadline/object",
            "uploadGrant": "grant",
        }

    def test_pass_through_runs_one_full_scan_on_the_final_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "source.mp4")
            source.write_bytes(b"media")
            initial = SimpleNamespace(media_kind="video", probe={"streams": []})
            final_scan = SimpleNamespace(size=5, sha256="a" * 64, mime_type="video/mp4", filename="source.mp4")
            plan = MediaPlan(PlanKind.PASS_THROUGH, "copy", "copy", "already_compatible_mp4")
            with patch("server.tempfile.TemporaryDirectory") as temporary, \
                 patch("server.download", return_value=(source, source.name, "video/mp4")), \
                 patch("server.validate_file", return_value=initial) as validate, \
                 patch("server.inspect_validated_file", return_value=final_scan) as inspect, \
                 patch("server.normalize_video", return_value=(source, source.name, "video/mp4", plan, initial.probe)) as normalize, \
                 patch("server._report_progress") as progress, \
                 patch("server._upload_to_r2") as upload:
                temporary.return_value.__enter__.return_value = directory
                temporary.return_value.__exit__.return_value = False
                status, value = self._handler()._download(self._body())

        self.assertEqual(status, 200)
        self.assertEqual(value["normalization"], "PASS_THROUGH")
        self.assertGreaterEqual(value["metrics"]["wallMs"], 0)
        self.assertGreaterEqual(value["metrics"]["observedWorkBytes"], 5)
        self.assertEqual(set(value["metrics"]["phaseMs"]), {"download", "validation", "processing", "securityScan", "upload"})
        self.assertEqual(validate.call_count, 1)
        self.assertEqual(inspect.call_count, 1)
        self.assertIs(normalize.call_args.kwargs["source_probe"], initial.probe)
        self.assertIs(inspect.call_args.args[1], initial)
        self.assertIs(upload.call_args.kwargs["deadline"], normalize.call_args.kwargs["deadline"])
        self.assertEqual([call.args[1] for call in progress.call_args_list], ["downloading", "validating", "processing", "scanning", "saving"])

    def test_changed_output_does_not_scan_the_discarded_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "source.mkv")
            output = Path(directory, "output.mp4")
            source.write_bytes(b"source")
            output.write_bytes(b"output")
            initial = SimpleNamespace(media_kind="video", probe={"streams": []})
            output_probe = {"streams": [{"codec_type": "video", "codec_name": "h264"}]}
            final_validation = SimpleNamespace(media_kind="video", probe=output_probe)
            final = SimpleNamespace(size=6, sha256="b" * 64, mime_type="video/mp4", filename="output.mp4")
            plan = MediaPlan(PlanKind.REMUX, "copy", "copy", "compatible_streams")
            with patch("server.tempfile.TemporaryDirectory") as temporary, \
                 patch("server.download", return_value=(source, source.name, "video/x-matroska")), \
                 patch("server.validate_file", side_effect=[initial, final_validation]) as validate, \
                 patch("server.inspect_validated_file", return_value=final) as inspect, \
                 patch("server.normalize_video", return_value=(output, output.name, "video/mp4", plan, output_probe)), \
                 patch("server._report_progress"), \
                 patch("server._upload_to_r2") as upload:
                temporary.return_value.__enter__.return_value = directory
                temporary.return_value.__exit__.return_value = False
                status, value = self._handler()._download(self._body())

        self.assertEqual(status, 200)
        self.assertEqual(value["normalization"], "REMUX")
        self.assertEqual(validate.call_count, 2)
        self.assertIs(validate.call_args.kwargs["probe"], output_probe)
        self.assertEqual(inspect.call_count, 1)
        self.assertEqual(inspect.call_args.args[0], output)
        self.assertIs(upload.call_args.args[2], final)

    def test_absolute_deadline_is_shared_and_fails_closed(self):
        now = [100.0]
        deadline = JobDeadline(10, clock=lambda: now[0])
        self.assertEqual(deadline.timeout(maximum_seconds=20, reserve_seconds=2), 8)
        now[0] = 108.5
        with self.assertRaisesRegex(JobDeadlineExceeded, "job_deadline_exceeded"):
            deadline.timeout(reserve_seconds=2)


if __name__ == "__main__":
    unittest.main()
