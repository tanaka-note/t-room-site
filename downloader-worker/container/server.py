from __future__ import annotations

import json
import os
import signal
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from resolver import ResolverError, analyze, download
from scanner import UnsafeFile, clamav_database_status, inspect_file
from ssrf import UnsafeUrl
from media_pipeline import normalize_video


MAX_REQUEST_BYTES = 16 * 1024
DRAINING = threading.Event()


class Handler(BaseHTTPRequestHandler):
    server_version = "TlainDownloader/1"

    def do_POST(self):
        if DRAINING.is_set():
            return self._json(503, {"error": "Containerを安全に更新しています。", "errorCode": "container_draining"})
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

    def do_GET(self):
        if self.path != "/health":
            return self._json(404, {"error": "not_found"})
        status = clamav_database_status()
        return self._json(200 if status["healthy"] and not DRAINING.is_set() else 503, {
            "ok": status["healthy"] and not DRAINING.is_set(),
            "draining": DRAINING.is_set(),
            "clamav": status,
        })

    def _download(self, body):
        max_bytes = _number(body.get("maxBytes"), 1, 2 * 1024**3)
        timeout = _number(body.get("timeoutSeconds"), 60, 720)
        job_id = _safe_job_id(body.get("jobId"))
        _event("download_started", job_id)
        with tempfile.TemporaryDirectory(prefix="tlain-", dir="/work") as directory:
            path, name, declared_mime = download(
                str(body.get("url") or ""), str(body.get("mediaId") or ""), Path(directory), max_bytes, timeout,
            )
            _event("download_fetched", job_id)
            initial_scan = inspect_file(path, name, declared_mime, max_bytes)
            _event("download_initial_scan_passed", job_id)
            plan = None
            if initial_scan.media_kind == "video":
                path, name, declared_mime, plan = normalize_video(path, name, max_bytes, timeout)
                _event("download_video_normalized", job_id, normalization=plan.kind.value)
            scan = inspect_file(path, name, declared_mime, max_bytes) if plan else initial_scan
            if plan:
                _event("download_final_scan_passed", job_id)
            _event("download_upload_started", job_id)
            _upload_to_r2(path, body, scan)
            _event("download_completed", job_id)
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
    # urlopen deliberately uses the runtime's configured HTTP proxy. Cloudflare
    # Containers route virtual outbound hosts through that proxy to
    # DownloaderContainer.outboundByHost; a raw HTTPConnection bypasses it.
    with path.open("rb") as source:
        request = Request(
            "http://r2.tlain.internal/upload",
            data=iter(lambda: source.read(1024 * 1024), b""),
            method="PUT",
            headers={
                "Authorization": f"Bearer {grant}",
                "Content-Type": scan.mime_type,
                "Content-Length": str(scan.size),
                "X-Content-SHA256": scan.sha256,
                "X-Filename": quote(scan.filename, safe=""),
            },
        )
        try:
            with urlopen(request, timeout=180) as response:
                response.read(64 * 1024)
                status = response.status
        except HTTPError as error:
            error.read(64 * 1024)
            status = error.code
    if status != 200:
        raise RuntimeError(f"r2_upload_{status}")


def _number(value, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid_number") from error
    if number < minimum or number > maximum:
        raise ValueError("number_out_of_range")
    return number


def _safe_job_id(value) -> str:
    candidate = str(value or "")
    return candidate if 0 < len(candidate) <= 128 and all(character.isalnum() or character in "-_" for character in candidate) else "invalid"


def _event(event: str, job_id: str, **details) -> None:
    # Job IDs and processing stages are safe operational metadata. Source URLs,
    # response bodies, and filenames are intentionally excluded.
    print(json.dumps({"event": event, "jobId": job_id, **details}, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.daemon_threads = False
    server.block_on_close = True

    def begin_drain(_signum, _frame):
        if DRAINING.is_set():
            return
        DRAINING.set()
        # shutdown() must run outside the serve_forever thread. Existing request
        # threads are joined by server_close(), so in-flight ffmpeg/scan/upload
        # work can finish during Cloudflare's SIGTERM grace window.
        threading.Thread(target=server.shutdown, name="container-drain", daemon=True).start()

    signal.signal(signal.SIGTERM, begin_drain)
    signal.signal(signal.SIGINT, begin_drain)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        DRAINING.set()
        server.server_close()
