import socket
import unittest

from ssrf import UnsafeUrl, validate_redirect, validate_url


def resolver_for(address):
    return lambda host, port, type=None: [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]


class SsrfTests(unittest.TestCase):
    def test_public_dns_is_allowed(self):
        self.assertEqual(validate_url("https://example.com/video", resolver=resolver_for("8.8.8.8")).hostname, "example.com")

    def test_private_and_reserved_dns_are_blocked(self):
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "fe80::1", "2001:db8::1"]:
            with self.subTest(address=address), self.assertRaises(UnsafeUrl):
                validate_url("https://example.com/video", resolver=resolver_for(address))

    def test_dns_rebinding_answer_set_is_blocked_if_any_answer_is_private(self):
        def rebinding(host, port, type=None):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", port)),
            ]
        with self.assertRaises(UnsafeUrl):
            validate_url("https://example.com/video", resolver=rebinding)

    def test_redirect_is_revalidated(self):
        with self.assertRaises(UnsafeUrl):
            validate_redirect("https://example.com/video", "http://127.0.0.1/admin", resolver=resolver_for("8.8.8.8"))

    def test_non_http_and_credentials_are_blocked(self):
        for value in ["file:///etc/passwd", "ftp://example.com/a", "https://u:p@example.com/a", "https://example.com:8443/a"]:
            with self.subTest(value=value), self.assertRaises(UnsafeUrl):
                validate_url(value, resolver=resolver_for("8.8.8.8"))


if __name__ == "__main__":
    unittest.main()
