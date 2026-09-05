from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from resolver import _analyze_html
from server import _report_progress, _upload_to_r2


class _UploadResponse:
    status = 200

    def __init__(self, request):
        self.request = request
        self.body = request.data if isinstance(request.data, bytes) else b"".join(request.data)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b'{"stored":true}'


class _Deadline:
    def __init__(self):
        self.ensure_calls = 0

    def ensure(self, **_kwargs):
        self.ensure_calls += 1
        return 10

    def timeout(self, **_kwargs):
        return 7


@unittest.skipUnless(shutil.which("chromium"), "Chromium is tested in the Linux container")
class RuntimeIntegrationTests(unittest.TestCase):
    def test_r2_upload_uses_proxy_aware_streaming_request(self):
        content = b"streamed-media" * 1024
        scan = SimpleNamespace(
            filename="test video.mp4",
            mime_type="video/mp4",
            size=len(content),
            sha256="a" * 64,
        )
        captured = {}

        def open_request(request, timeout):
            captured["timeout"] = timeout
            captured["response"] = _UploadResponse(request)
            return captured["response"]

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "media.mp4")
            path.write_bytes(content)
            with patch("server.urlopen", side_effect=open_request):
                _upload_to_r2(path, {
                    "uploadGrant": "signed-grant",
                    "objectKey": "downloads/job/object",
                }, scan)

        request = captured["response"].request
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(request.full_url, "http://r2.tlain.internal/upload")
        self.assertEqual(request.method, "PUT")
        self.assertEqual(headers["authorization"], "Bearer signed-grant")
        self.assertEqual(headers["content-length"], str(len(content)))
        self.assertEqual(headers["x-content-sha256"], "a" * 64)
        self.assertEqual(headers["x-filename"], "test%20video.mp4")
        self.assertEqual(headers["x-normalization"], "NOT_APPLICABLE")
        self.assertEqual(headers["x-source-bytes"], "0")
        self.assertEqual(captured["response"].body, content)
        self.assertEqual(captured["timeout"], 180)

    def test_chromium_headless_runs_with_an_isolated_temporary_profile(self):
        # No media candidate is expected; a clean None proves Chromium rendered
        # the page instead of failing and the generic analyzer completed.
        self.assertIsNone(_analyze_html("data:text/html,<title>runtime-ok</title>", 1_000_000, True))

    def test_r2_upload_uses_the_shared_deadline(self):
        content = b"deadline-media" * 1024
        scan = SimpleNamespace(filename="media.mp4", mime_type="video/mp4", size=len(content), sha256="b" * 64)
        captured = {}
        deadline = _Deadline()

        def open_request(request, timeout):
            captured["timeout"] = timeout
            return _UploadResponse(request)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "media.mp4")
            path.write_bytes(content)
            with patch("server.urlopen", side_effect=open_request):
                _upload_to_r2(path, {"uploadGrant": "grant", "objectKey": "downloads/job/object"}, scan, deadline)

        self.assertEqual(captured["timeout"], 7)
        self.assertGreaterEqual(deadline.ensure_calls, 1)

    def test_r2_upload_carries_bounded_usage_metrics(self):
        content = b"measured-media"
        scan = SimpleNamespace(filename="media.mp4", mime_type="video/mp4", size=len(content), sha256="c" * 64)
        captured = {}

        def open_request(request, timeout):
            captured["request"] = request
            return _UploadResponse(request)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "media.mp4")
            path.write_bytes(content)
            with patch("server.urlopen", side_effect=open_request):
                _upload_to_r2(
                    path, {"uploadGrant": "grant", "objectKey": "downloads/job/object"}, scan,
                    normalization="REMUX", source_bytes=99,
                    metrics={
                        "wallMs": 12, "cpuUserMs": 3, "cpuSystemMs": 2,
                        "containerPeakRssBytes": 4, "observedWorkBytes": 5,
                        "phaseMs": {"download": 6, "validation": 7, "processing": 8, "securityScan": 9},
                    },
                )

        headers = {key.lower(): value for key, value in captured["request"].header_items()}
        self.assertEqual(headers["x-normalization"], "REMUX")
        self.assertEqual(headers["x-source-bytes"], "99")
        self.assertEqual(headers["x-container-wall-ms"], "12")
        self.assertEqual(headers["x-container-cpu-user-ms"], "3")
        self.assertEqual(headers["x-container-cpu-system-ms"], "2")
        self.assertEqual(headers["x-container-peak-rss-bytes"], "4")
        self.assertEqual(headers["x-container-work-bytes"], "5")
        self.assertEqual(headers["x-phase-download-ms"], "6")
        self.assertEqual(headers["x-phase-validation-ms"], "7")
        self.assertEqual(headers["x-phase-processing-ms"], "8")
        self.assertEqual(headers["x-phase-security-scan-ms"], "9")

    def test_progress_uses_the_signed_internal_route_without_job_details(self):
        captured = {}

        def open_request(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return _UploadResponse(request)

        with patch("server.urlopen", side_effect=open_request):
            _report_progress({"uploadGrant": "signed-grant"}, "scanning")

        request = captured["request"]
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(request.full_url, "http://r2.tlain.internal/progress")
        self.assertEqual(request.method, "POST")
        self.assertEqual(headers["authorization"], "Bearer signed-grant")
        self.assertEqual(request.data, b'{"stage":"scanning"}')
        self.assertEqual(captured["timeout"], 3)


if __name__ == "__main__":
    unittest.main()
