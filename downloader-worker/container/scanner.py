from __future__ import annotations

import atexit
import hashlib
import json
import mimetypes
import os
import re
import socket
import struct
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path


class UnsafeFile(ValueError):
    pass


BLOCKED_EXTENSIONS = {
    ".7z", ".apk", ".app", ".bat", ".cmd", ".com", ".dll", ".dmg", ".exe",
    ".iso", ".jar", ".js", ".lnk", ".msi", ".ps1", ".rar", ".scr", ".sh",
    ".vbs", ".zip",
}
MEDIA_EXTENSIONS = {
    ".264", ".265", ".3g2", ".3gp", ".aac", ".ac3", ".aif", ".aifc", ".aiff",
    ".apng", ".asf", ".au", ".avi", ".avif", ".bmp", ".eac3",
    ".f4v", ".flac", ".flv", ".gif", ".h264", ".h265", ".hevc", ".ivf", ".jpeg",
    ".jpg", ".m1v", ".m2ts", ".m2v", ".m4a", ".m4v", ".mka", ".mjpeg", ".mjpg",
    ".mkv", ".mov", ".mp2", ".mp3", ".mp4", ".mpeg", ".mpg", ".mts", ".mxf",
    ".oga", ".ogg", ".ogv", ".opus", ".png", ".tif", ".tiff", ".ts", ".vob",
    ".wav", ".wave", ".webm", ".webp", ".wma", ".wmv", ".wtv", ".wv",
}
EXTENSION_FAMILIES = {
    **{suffix: "audio" for suffix in {
        ".aac", ".ac3", ".aif", ".aifc", ".aiff", ".au", ".eac3",
        ".flac", ".m4a", ".mka", ".mp2", ".mp3", ".oga", ".ogg", ".opus", ".wav",
        ".wave", ".wma", ".wv",
    }},
    **{suffix: "image" for suffix in {
        ".apng", ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
    }},
    **{suffix: "video" for suffix in MEDIA_EXTENSIONS if suffix not in {
        ".aac", ".ac3", ".aif", ".aifc", ".aiff", ".apng", ".au", ".avif",
        ".bmp", ".eac3", ".flac", ".gif", ".jpeg", ".jpg", ".m4a", ".mka", ".mp2", ".mp3",
        ".oga", ".ogg", ".opus", ".png", ".tif", ".tiff", ".wav", ".wave", ".webp", ".wma", ".wv",
    }},
}
EXECUTABLE_MAGIC = (
    b"MZ", b"\x7fELF", b"#!", b"\xca\xfe\xba\xbe", b"PK\x03\x04",
)
CLAMAV_DATABASE_DIR = Path(os.environ.get("CLAMAV_DATABASE_DIR", "/var/lib/clamav"))
DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS = 7 * 24 * 60 * 60
DEFAULT_CLAMAV_SCAN_TIMEOUT_SECONDS = 600
REQUIRED_CLAMAV_DATABASES = ("main", "daily", "bytecode")
CLAMD_CONFIG = Path(os.environ.get("CLAMD_CONFIG", "/app/clamd.conf"))
CLAMD_SOCKET = Path(os.environ.get("CLAMD_SOCKET", "/work/clamd.sock"))
CLAMD_WINDOW_BYTES = 64 * 1024 * 1024
CLAMD_WINDOW_OVERLAP_BYTES = 1024 * 1024
_DATABASE_VERIFY_CACHE: dict[tuple[str, int, int], bool] = {}
_DATABASE_VERIFY_LOCK = threading.Lock()
_CLAMD_LOCK = threading.Lock()
_CLAMD_PROCESS: subprocess.Popen | None = None
_CLAMD_ATEXIT_REGISTERED = False


@dataclass(frozen=True)
class ScanResult:
    sha256: str
    size: int
    mime_type: str
    filename: str
    media_kind: str


def inspect_file(path: Path, requested_name: str, declared_mime: str | None, max_bytes: int) -> ScanResult:
    size = path.stat().st_size
    if size <= 0 or size > max_bytes:
        raise UnsafeFile("size_limit")
    filename = safe_filename(requested_name or path.name)
    _reject_filename(filename)
    with path.open("rb") as source:
        prefix = source.read(16)
    if any(prefix.startswith(magic) for magic in EXECUTABLE_MAGIC):
        raise UnsafeFile("executable_content")

    detected = _detect_mime(path)
    if _mime_family(detected) not in {"audio", "image", "video"} and detected not in {
        "application/mxf", "application/octet-stream", "application/ogg", "application/x-matroska",
    }:
        raise UnsafeFile("unsupported_mime")
    # Keep complex media parsers behind the malware gate. libmagic performs the
    # minimal type check first; ClamAV then scans before ffprobe sees the file.
    _scan_malware(path)
    probe = probe_file(path)
    media_kind = _media_kind(detected, probe)
    if Path(filename).suffix.lower() in {".mjpeg", ".mjpg"} and any(_is_playable_video_stream(stream) for stream in probe.get("streams", [])):
        # libmagic reports a raw MJPEG stream as image/jpeg; ffprobe proves that
        # the complete payload is a video stream rather than a single JPEG.
        media_kind = "video"
    if media_kind is None:
        raise UnsafeFile("unsupported_mime")
    declared = (declared_mime or "").split(";", 1)[0].strip().lower()
    if declared and declared != "application/octet-stream" and _mime_family(declared) in {"audio", "image", "video"} and _mime_family(declared) != media_kind:
        raise UnsafeFile("mime_mismatch")
    expected, _ = mimetypes.guess_type(filename)
    expected_family = EXTENSION_FAMILIES.get(Path(filename).suffix.lower()) or (_mime_family(expected) if expected else "")
    ambiguous_ogg = Path(filename).suffix.lower() == ".ogg" and detected in {"application/ogg", "audio/ogg", "video/ogg"}
    if expected_family in {"audio", "image", "video"} and expected_family != media_kind and not ambiguous_ogg:
        raise UnsafeFile("extension_mismatch")

    _validate_media(path, probe)
    return ScanResult(_sha256(path), size, detected, filename, media_kind)


def clamav_database_status(database_dir: Path | None = None, now: float | None = None) -> dict:
    root = database_dir or CLAMAV_DATABASE_DIR
    current = time.time() if now is None else float(now)
    max_age = _clamav_max_definition_age_seconds()
    databases = {}
    for name in REQUIRED_CLAMAV_DATABASES:
        path = _clamav_database_path(root, name)
        built_at = _clamav_database_build_time(path) if path else None
        verified = bool(path and built_at is not None and _clamav_database_signature_is_valid(path))
        databases[name] = {
            "available": path is not None,
            "verified": verified,
            "buildUnix": int(built_at) if built_at is not None else None,
            "ageSeconds": max(0, int(current - built_at)) if built_at is not None else None,
        }
    daily = databases["daily"]
    available = all(value["available"] for value in databases.values())
    verified = all(value["verified"] for value in databases.values())
    daily_fresh = daily["ageSeconds"] is not None and daily["ageSeconds"] <= max_age
    return {
        "available": available,
        "healthy": available and verified and daily_fresh,
        "freshnessSource": "daily_database_build_time",
        "dailyDefinitionUnix": daily["buildUnix"],
        "dailyAgeSeconds": daily["ageSeconds"],
        "maxAgeSeconds": max_age,
        "databases": databases,
    }


def require_fresh_clamav_definitions(database_dir: Path | None = None, now: float | None = None) -> dict:
    status = clamav_database_status(database_dir, now)
    if not status["available"]:
        raise UnsafeFile("malware_definitions_missing")
    if not all(value["verified"] for value in status["databases"].values()):
        raise UnsafeFile("malware_definitions_invalid")
    if not status["healthy"]:
        raise UnsafeFile("malware_definitions_stale")
    return status


def safe_filename(value: str) -> str:
    name = str(value or "download").replace("\\", "_").replace("/", "_")
    name = "".join(character for character in name if ord(character) >= 32 and ord(character) != 127)
    name = re.sub(r"[<>:\"|?*]", "_", name).strip(" .")
    if not name:
        name = "download"
    suffix = Path(name).suffix.lower()[:11]
    stem = name[:-len(suffix)] if suffix else name
    return (stem[: max(1, 120 - len(suffix))] or "download") + suffix


def _reject_filename(filename: str) -> None:
    suffixes = [suffix.lower() for suffix in Path(filename).suffixes]
    if any(suffix in BLOCKED_EXTENSIONS for suffix in suffixes):
        raise UnsafeFile("blocked_extension")
    if len(suffixes) > 1 and suffixes[-1] not in MEDIA_EXTENSIONS:
        raise UnsafeFile("suspicious_double_extension")


def _detect_mime(path: Path) -> str:
    result = subprocess.run(
        ["file", "--brief", "--mime-type", "--", str(path)],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise UnsafeFile("magic_failed")
    return result.stdout.strip().lower()


def _media_kind(detected: str, probe: dict) -> str | None:
    if detected.startswith("image/"):
        return "image"
    streams = probe.get("streams", [])
    if any(_is_playable_video_stream(stream) for stream in streams):
        return "video"
    if any(stream.get("codec_type") == "audio" for stream in streams):
        return "audio"
    return None


def _mime_family(value: str) -> str:
    return value.split("/", 1)[0].lower() if "/" in value else ""


def probe_file(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,duration,bit_rate,sample_rate,channels:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation",
         "-of", "json", "--", str(path)],
        capture_output=True, text=True, timeout=90, check=False,
    )
    if result.returncode != 0:
        raise UnsafeFile("ffprobe_failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise UnsafeFile("ffprobe_invalid") from error


def _validate_media(path: Path, probe: dict) -> None:
    streams = probe.get("streams", [])
    stream_types = {stream.get("codec_type") for stream in streams}
    if "attachment" in stream_types or "data" in stream_types:
        raise UnsafeFile("unsafe_embedded_stream")
    if not streams or any(kind not in {"audio", "video", "subtitle"} for kind in stream_types):
        # Still images are accepted through libmagic and decoded by Chromium/OS,
        # but ffprobe must validate every audio/video container.
        mime = _detect_mime(path)
        if not mime.startswith("image/"):
            raise UnsafeFile("invalid_media_stream")


def _scan_malware(path: Path) -> None:
    require_fresh_clamav_definitions()
    start_clamav_daemon()
    deadline = time.monotonic() + _clamav_scan_timeout_seconds()
    command = [
        "clamdscan", f"--config-file={CLAMD_CONFIG}", "--fdpass", "--no-summary", "--", str(path),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise UnsafeFile("malware_scan_timeout") from error
    if result.returncode == 1:
        raise UnsafeFile("malware_detected")
    if result.returncode != 0:
        # A scanner/configuration failure is not treated as a clean result.
        raise UnsafeFile("malware_scan_failed")
    if path.stat().st_size > CLAMD_WINDOW_BYTES:
        _scan_large_file_windows(path, deadline)


def start_clamav_daemon() -> None:
    global _CLAMD_PROCESS, _CLAMD_ATEXIT_REGISTERED
    if clamav_daemon_ready():
        return
    with _CLAMD_LOCK:
        if clamav_daemon_ready():
            return
        if _CLAMD_PROCESS is not None and _CLAMD_PROCESS.poll() is None:
            stop_clamav_daemon()
        try:
            CLAMD_SOCKET.unlink(missing_ok=True)
            _CLAMD_PROCESS = subprocess.Popen(
                ["clamd", f"--config-file={CLAMD_CONFIG}"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise UnsafeFile("malware_scanner_unavailable") from error
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if _CLAMD_PROCESS.poll() is not None:
                break
            if clamav_daemon_ready():
                if not _CLAMD_ATEXIT_REGISTERED:
                    atexit.register(stop_clamav_daemon)
                    _CLAMD_ATEXIT_REGISTERED = True
                return
            time.sleep(0.1)
        stop_clamav_daemon()
        raise UnsafeFile("malware_scanner_unavailable")


def stop_clamav_daemon() -> None:
    global _CLAMD_PROCESS
    process = _CLAMD_PROCESS
    _CLAMD_PROCESS = None
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    try:
        CLAMD_SOCKET.unlink(missing_ok=True)
    except OSError:
        pass


def clamav_daemon_ready() -> bool:
    if not hasattr(socket, "AF_UNIX"):
        return False
    try:
        response = _clamd_command(b"zPING\0", timeout=2)
        return response.rstrip(b"\0") == b"PONG"
    except (OSError, TimeoutError, UnsafeFile):
        return False


def _scan_large_file_windows(path: Path, deadline: float | None = None) -> None:
    scan_deadline = deadline if deadline is not None else time.monotonic() + _clamav_scan_timeout_seconds()
    size = path.stat().st_size
    offset = 0
    with path.open("rb") as source:
        while offset < size:
            remaining_time = scan_deadline - time.monotonic()
            if remaining_time <= 0:
                raise UnsafeFile("malware_scan_timeout")
            source.seek(offset)
            length = min(CLAMD_WINDOW_BYTES, size - offset)
            result = _clamd_stream(source, length, remaining_time)
            if b"FOUND" in result:
                raise UnsafeFile("malware_detected")
            if not result.rstrip(b"\0").endswith(b"OK"):
                raise UnsafeFile("malware_scan_failed")
            if offset + length >= size:
                break
            offset += CLAMD_WINDOW_BYTES - CLAMD_WINDOW_OVERLAP_BYTES


def _clamd_stream(source, length: int, timeout: float | None = None) -> bytes:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(max(1, timeout if timeout is not None else _clamav_scan_timeout_seconds()))
            connection.connect(str(CLAMD_SOCKET))
            connection.sendall(b"zINSTREAM\0")
            remaining = length
            while remaining > 0:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise UnsafeFile("malware_scan_incomplete")
                connection.sendall(struct.pack("!I", len(chunk)))
                connection.sendall(chunk)
                remaining -= len(chunk)
            connection.sendall(struct.pack("!I", 0))
            return _receive_clamd_response(connection)
    except socket.timeout as error:
        raise UnsafeFile("malware_scan_timeout") from error
    except OSError as error:
        raise UnsafeFile("malware_scan_failed") from error


def _clamd_command(command: bytes, timeout: int) -> bytes:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(CLAMD_SOCKET))
        connection.sendall(command)
        return _receive_clamd_response(connection)


def _receive_clamd_response(connection: socket.socket) -> bytes:
    output = bytearray()
    while len(output) <= 8192:
        chunk = connection.recv(4096)
        if not chunk:
            break
        output.extend(chunk)
        if b"\0" in chunk:
            break
    if not output or len(output) > 8192:
        raise UnsafeFile("malware_scan_failed")
    return bytes(output)


def _clamav_max_definition_age_seconds() -> int:
    try:
        value = int(os.environ.get("CLAMAV_MAX_DEFINITION_AGE_SECONDS", DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS
    return value if 3600 <= value <= 30 * 24 * 60 * 60 else DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS


def _clamav_scan_timeout_seconds() -> int:
    try:
        value = int(os.environ.get("CLAMAV_SCAN_TIMEOUT_SECONDS", DEFAULT_CLAMAV_SCAN_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_CLAMAV_SCAN_TIMEOUT_SECONDS
    return value if 30 <= value <= 1800 else DEFAULT_CLAMAV_SCAN_TIMEOUT_SECONDS


def _clamav_database_path(root: Path, name: str) -> Path | None:
    for suffix in ("cld", "cvd"):
        candidate = root / f"{name}.{suffix}"
        if candidate.is_file():
            return candidate
    return None


def _clamav_database_signature_is_valid(path: Path) -> bool:
    try:
        stat = path.stat()
        key = (str(path.resolve()), int(stat.st_size), int(stat.st_mtime_ns))
    except OSError:
        return False
    with _DATABASE_VERIFY_LOCK:
        if key in _DATABASE_VERIFY_CACHE:
            return _DATABASE_VERIFY_CACHE[key]
    try:
        result = subprocess.run(
            ["sigtool", "--info", str(path)], capture_output=True, text=True, timeout=120, check=False,
        )
        output = f"{result.stdout}\n{result.stderr}".lower()
        valid = result.returncode == 0 and re.search(r"verification\s*:?\s*ok", output) is not None
    except (OSError, subprocess.TimeoutExpired):
        valid = False
    with _DATABASE_VERIFY_LOCK:
        if len(_DATABASE_VERIFY_CACHE) >= 16:
            _DATABASE_VERIFY_CACHE.clear()
        _DATABASE_VERIFY_CACHE[key] = valid
    return valid


def _clamav_database_build_time(path: Path | None) -> int | None:
    """Read the signed CVD/CLD header timestamp instead of mutable file mtime."""
    try:
        if path is None:
            return None
        with path.open("rb") as source:
            header = source.read(512).split(b"\x00", 1)[0].decode("ascii", "strict")
        fields = header.split(":")
        if fields[0] != "ClamAV-VDB" or len(fields) < 9:
            return None
        value = int(fields[8].strip().split()[0])
        return value if value >= 946_684_800 else None
    except (OSError, UnicodeDecodeError, ValueError, IndexError):
        return None


def _is_playable_video_stream(stream: dict) -> bool:
    disposition = stream.get("disposition") or {}
    return stream.get("codec_type") == "video" and str(disposition.get("attached_pic") or "0") != "1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
