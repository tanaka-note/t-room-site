from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit


class UnsafeUrl(ValueError):
    pass


@dataclass(frozen=True)
class SafeUrl:
    value: str
    hostname: str


BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal")
BLOCKED_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "metadata.aws.internal",
    "instance-data.ec2.internal",
}


def validate_url(value: str, *, resolver=socket.getaddrinfo) -> SafeUrl:
    try:
        parsed = urlsplit(str(value).strip())
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise UnsafeUrl("invalid_url") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise UnsafeUrl("unsupported_scheme")
    if parsed.username or parsed.password:
        raise UnsafeUrl("credentials_not_allowed")
    if port is not None and port not in {80, 443}:
        raise UnsafeUrl("blocked_port")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname in BLOCKED_HOSTS or hostname.endswith(BLOCKED_HOST_SUFFIXES):
        raise UnsafeUrl("blocked_hostname")
    try:
        literal_address = ipaddress.ip_address(hostname)
    except ValueError:
        literal_address = None
    if literal_address is not None and not literal_address.is_global:
        raise UnsafeUrl("blocked_address")
    addresses = _resolve(hostname, port or (443 if parsed.scheme == "https" else 80), resolver)
    intercepted_dns = literal_address is None and (
        bool(os.environ.get("CLOUDFLARE_APPLICATION_ID"))
        or os.path.exists("/etc/cloudflare/certs/cloudflare-containers-ca.crt")
    )
    if not addresses or (any(not address.is_global for address in addresses) and not intercepted_dns):
        raise UnsafeUrl("blocked_address")
    clean = urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))
    if len(clean) > 4096:
        raise UnsafeUrl("url_too_long")
    return SafeUrl(clean, hostname)


def validate_redirect(base: str, location: str, *, resolver=socket.getaddrinfo) -> SafeUrl:
    if not location:
        raise UnsafeUrl("redirect_without_location")
    return validate_url(urljoin(base, location), resolver=resolver)


def _resolve(hostname: str, port: int, resolver) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        literal = ipaddress.ip_address(hostname)
        return {literal}
    except ValueError:
        pass
    try:
        records = resolver(hostname, port, type=socket.SOCK_STREAM)
    except (OSError, socket.gaierror) as error:
        raise UnsafeUrl("dns_failed") from error
    addresses = set()
    for record in records:
        try:
            addresses.add(ipaddress.ip_address(record[4][0].split("%", 1)[0]))
        except ValueError as error:
            raise UnsafeUrl("invalid_dns_result") from error
    return addresses
