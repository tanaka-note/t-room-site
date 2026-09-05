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
        self.start_scanner = self.enterContext(patch("server.start_clamav_daemon"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        DRAINING.clear()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_analysis_readiness_does_not_initialize_scanners(self):
        with patch("server.clamav_database_status") as definitions, patch("server.yara_rules_status") as yara:
            with urlopen(f"http://127.0.0.1:{self.server.server_port}/ready", timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["mode"], "analysis")
            definitions.assert_not_called()
            yara.assert_not_called()
            self.start_scanner.assert_not_called()

    def test_analysis_readiness_rejects_draining(self):
        DRAINING.set()
        with self.assertRaises(HTTPError) as error:
            urlopen(f"http://127.0.0.1:{self.server.server_port}/ready", timeout=5)
        self.assertEqual(error.exception.code, 503)

    def _health(self):
        url = f"http://127.0.0.1:{self.server.server_port}/health"
        try:
            with urlopen(url, timeout=5) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    @patch("server.yara_rules_status", return_value={"healthy": True})
    @patch("server.clamav_daemon_ready", return_value=True)
    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_healthy_definitions_are_ready(self, _status, _daemon, _yara):
        status, body = self._health()
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    @patch("server.yara_rules_status", return_value={"healthy": True})
    @patch("server.clamav_daemon_ready", return_value=True)
    @patch("server.clamav_database_status", return_value={"healthy": False})
    def test_stale_definitions_are_unhealthy(self, _status, _daemon, _yara):
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])

    @patch("server.yara_rules_status", return_value={"healthy": True})
    @patch("server.clamav_daemon_ready", return_value=True)
    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_draining_container_is_unhealthy(self, _status, _daemon, _yara):
        DRAINING.set()
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertTrue(body["draining"])

    @patch("server.yara_rules_status", return_value={"healthy": True})
    @patch("server.clamav_daemon_ready", return_value=False)
    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_unavailable_daemon_is_unhealthy(self, _status, _daemon, _yara):
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])

    @patch("server.yara_rules_status", return_value={"healthy": False})
    @patch("server.clamav_daemon_ready", return_value=True)
    @patch("server.clamav_database_status", return_value={"healthy": True})
    def test_unavailable_yara_is_unhealthy(self, _status, _daemon, _yara):
        status, body = self._health()
        self.assertEqual(status, 503)
        self.assertFalse(body["ok"])


if __name__ == "__main__":
    unittest.main()
