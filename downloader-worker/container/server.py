from __future__ import annotations

import json
import os
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from resolver import ResolverError, analyze, download
from scanner import UnsafeFile, clamav_daemon_ready, clamav_database_status, inspect_file, start_clamav_daemon, stop_clamav_daemon
from ssrf import UnsafeUrl
from media_pipeline import PlanKind, normalize_video


MAX_REQUEST_BYTES = 16 * 1024
DRAINING = threading.Event()


class JobDeadlineExceeded(TimeoutError):
    pass


class JobDeadline:
    def __init__(self, timeout_seconds: int, clock=time.monotonic):
        self.total_seconds = float(timeout_seconds)
        self._clock = clock
        self._expires_at = clock() + self.total_seconds

    def remaining(self) -> float:
        return self._expires_at - self._clock()

    def ensure(self, reserve_seconds: float = 0, minimum_seconds: float = 0) -> float:
        remaining = self.remaining() - max(0.0, float(reserve_seconds))
        if remaining <= max(0.0, float(minimum_seconds)):
            raise JobDeadlineExceeded("job_deadline_exceeded")
        return remaining

    def timeout(self, maximum_seconds: float | None = None, reserve_seconds: float = 0) -> float:
        remaining = self.ensure(reserve_seconds=reserve_seconds)
        if maximum_seconds is not None:
            remaining = min(remaining, max(0.1, float(maximum_seconds)))
        return max(0.1, remaining)


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
        except TimeoutError:
            return self._json(503, {"error": "安全な処理時間を超えたため取得を中止しました。", "errorCode": "job_deadline_exceeded"})
        except ValueError as error:
            return self._json(400, {"error": "入力内容を確認してください。", "errorCode": type(error).__name__})
        except Exception as error:
            # Never log source URLs, response bodies, or downloaded filenames.
            print(json.dumps({"event": "container_failed", "error": type(error).__name__}), flush=True)
            return self._json(500, {"error": "Downloaderで処理を完了できませんでした。", "errorCode": type(error).__name__})

    def do_GET(self):
        if self.path != "/health":
            return self._json(404, {"error": "not_found"})
        status = clamav_database_status()
        daemon_ready = clamav_daemon_ready()
        healthy = status["healthy"] and daemon_ready and not DRAINING.is_set()
        return self._json(200 if healthy else 503, {
            "ok": healthy,
            "draining": DRAINING.is_set(),
            "clamav": {**status, "daemonReady": daemon_ready},
        })

    def _download(self, body):
        max_bytes = _number(body.get("maxBytes"), 1, 2 * 1024**3)
        timeout = _number(body.get("timeoutSeconds"), 60, 720)
        deadline = JobDeadline(timeout)
        job_id = _safe_job_id(body.get("jobId"))
        _event("download_started", job_id)
        with tempfile.TemporaryDirectory(prefix="tlain-", dir="/work") as directory:
            path, name, declared_mime = download(
                body.get("route"), Path(directory), max_bytes, timeout,
                deadline=deadline, reserve_seconds=_phase_reserve(timeout, 90, 0.25),
            )
            _event("download_fetched", job_id)
            initial_scan = inspect_file(
                path, name, declared_mime, max_bytes,
                deadline=deadline, reserve_seconds=_phase_reserve(timeout, 60, 0.15),
            )
            _event("download_initial_scan_passed", job_id)
            plan = None
            if initial_scan.media_kind == "video":
                path, name, declared_mime, plan = normalize_video(
                    path, name, max_bytes, timeout,
                    deadline=deadline, reserve_seconds=_phase_reserve(timeout, 45, 0.10),
                    source_probe=initial_scan.probe,
                )
                _event("download_video_normalized", job_id, normalization=plan.kind.value)
            changed = plan is not None and plan.kind != PlanKind.PASS_THROUGH
            scan = inspect_file(
                path, name, declared_mime, max_bytes,
                deadline=deadline, reserve_seconds=_phase_reserve(timeout, 30, 0.05),
            ) if changed else initial_scan
            if changed:
                _event("download_final_scan_passed", job_id)
            _event("download_upload_started", job_id)
            deadline.ensure(minimum_seconds=1)
            _upload_to_r2(path, body, scan, deadline=deadline)
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


def _upload_to_r2(path: Path, body: dict, scan, deadline: JobDeadline | None = None) -> None:
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
            data=_deadline_chunks(source, deadline),
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
            timeout = 180 if deadline is None else deadline.timeout(maximum_seconds=180)
            with urlopen(request, timeout=timeout) as response:
                response.read(64 * 1024)
                status = response.status
        except HTTPError as error:
            error.read(64 * 1024)
            status = error.code
    if status != 200:
        raise RuntimeError(f"r2_upload_{status}")


def _deadline_chunks(source, deadline: JobDeadline | None):
    while True:
        if deadline is not None:
            deadline.ensure()
        chunk = source.read(1024 * 1024)
        if not chunk:
            return
        yield chunk


def _phase_reserve(total_seconds: int, maximum_seconds: int, fraction: float) -> float:
    return min(float(maximum_seconds), max(1.0, float(total_seconds) * fraction))


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
    start_clamav_daemon()
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
        stop_clamav_daemon()
