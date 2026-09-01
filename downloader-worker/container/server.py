from __future__ import annotations

import http.client
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from resolver import ResolverError, analyze, download
from scanner import UnsafeFile, inspect_file
from ssrf import UnsafeUrl
from media_pipeline import normalize_video


MAX_REQUEST_BYTES = 16 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "TlainDownloader/1"

    def do_POST(self):
        try:
            body = self._json_body()
            if self.path == "/analyze":
                result = analyze(str(body.get("url") or ""), _number(body.get("maxBytes"), 1, 2 * 1024**3), bool(body.get("policyRestricted")))
                return self._json(200, result)
            if self.path == "/download":
                return self._download(body)
            return self._json(404, {"error": "not_found"})
        except (UnsafeUrl, ResolverError) as error:
            return self._json(422, {"error": "このURLからメディアを確認できませんでした。", "errorCode": str(error)})
        except UnsafeFile as error:
            return self._json(422, {"error": "安全性を確認できなかったため取得を中止しました。", "errorCode": f"scan_{error}"})
        except (TimeoutError, ValueError) as error:
            return self._json(400, {"error": "入力内容を確認してください。", "errorCode": type(error).__name__})
        except Exception as error:
            # Never log source URLs, response bodies, or downloaded filenames.
            print(json.dumps({"event": "container_failed", "error": type(error).__name__}), flush=True)
            return self._json(500, {"error": "Downloaderで処理を完了できませんでした。", "errorCode": type(error).__name__})

    def _download(self, body):
        max_bytes = _number(body.get("maxBytes"), 1, 2 * 1024**3)
        timeout = _number(body.get("timeoutSeconds"), 60, 720)
        with tempfile.TemporaryDirectory(prefix="tlain-", dir="/work") as directory:
            path, name, declared_mime = download(
                str(body.get("url") or ""), str(body.get("mediaId") or ""), Path(directory), max_bytes, timeout,
            )
            initial_scan = inspect_file(path, name, declared_mime, max_bytes)
            plan = None
            if initial_scan.media_kind == "video":
                path, name, declared_mime, plan = normalize_video(path, name, max_bytes, timeout)
            scan = inspect_file(path, name, declared_mime, max_bytes) if plan else initial_scan
            _upload_to_r2(path, body, scan)
            return self._json(200, {
                "uploaded": True, "actualSize": scan.size, "sha256": scan.sha256,
                "mimeType": scan.mime_type, "scanMessage": "既知の脅威は検出されませんでした。",
                "normalization": plan.kind.value if plan else "NOT_APPLICABLE",
            })

    def _json_body(self):
        length = _number(self.headers.get("Content-Length"), 0, MAX_REQUEST_BYTES)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("invalid_length")
        return json.loads(self.rfile.read(length))

    def _json(self, status: int, value: dict):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Request targets can contain sensitive data; keep the access log silent.
        return


def _upload_to_r2(path: Path, body: dict, scan) -> None:
    grant = str(body.get("uploadGrant") or "")
    object_key = str(body.get("objectKey") or "")
    if not grant or not object_key.startswith("downloads/"):
        raise ValueError("missing_upload_grant")
    connection = http.client.HTTPConnection("r2.tlain.internal", 80, timeout=180)
    encoded_name = __import__("urllib.parse", fromlist=["quote"]).quote(scan.filename, safe="")
    connection.putrequest("PUT", "/upload", skip_accept_encoding=True)
    connection.putheader("Host", "r2.tlain.internal")
    connection.putheader("Authorization", f"Bearer {grant}")
    connection.putheader("Content-Type", scan.mime_type)
    connection.putheader("Content-Length", str(scan.size))
    connection.putheader("X-Content-SHA256", scan.sha256)
    connection.putheader("X-Filename", encoded_name)
    connection.endheaders()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            connection.send(chunk)
    response = connection.getresponse()
    response.read(64 * 1024)
    connection.close()
    if response.status != 200:
        raise RuntimeError(f"r2_upload_{response.status}")


def _number(value, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid_number") from error
    if number < minimum or number > maximum:
        raise ValueError("number_out_of_range")
    return number


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
