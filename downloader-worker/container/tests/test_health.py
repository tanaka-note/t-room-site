import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

from server import DRAINING, Handler


class HealthEndpointTests(unittest.TestCase):
    def setUp(self):
        DRAINING.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        DRAINING.clear()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _health(self):
        url = f"http://127.0.0.1:{self.server.server_port}/health"
        try:
            with urlopen(url, timeout=5) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_healthy_definitions_are_ready(self, _status):
        status, body = self._health()
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    @patch("server.clamav_database_status", return_value={"healthy": False})
    def test_stale_definitions_are_unhealthy(self, _status):
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])

    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_draining_container_is_unhealthy(self, _status):
        DRAINING.set()
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertTrue(body["draining"])


if __name__ == "__main__":
    unittest.main()
