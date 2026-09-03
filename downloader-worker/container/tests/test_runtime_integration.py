from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from resolver import _analyze_html
from server import _upload_to_r2


class _UploadResponse:
    status = 200

    def __init__(self, request):
        self.request = request
        self.body = b"".join(request.data)

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


if __name__ == "__main__":
    unittest.main()
