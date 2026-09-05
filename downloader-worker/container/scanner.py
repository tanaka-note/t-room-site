from __future__ import annotations

import atexit
import hashlib
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from contextlib import contextmanager


def cgroup_cpu():
    try:
        values = dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
        return int(values['user_usec']) / 1_000_000, int(values['system_usec']) / 1_000_000
    except (OSError, ValueError, KeyError):
        return None


@contextmanager
def measure_phase(wall, name, cpu=None):
    started = time.monotonic()
    before = cgroup_cpu() if cpu is not None else None
    try:
        yield
    finally:
        wall[name] = wall.get(name, 0) + max(0, round((time.monotonic() - started) * 1000))
        after = cgroup_cpu() if before is not None else None
        if before is not None and after is not None:
            cpu[name] = cpu.get(name, 0) + max(0, round((sum(after) - sum(before)) * 1000))


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
_DATABASE_VERIFY_CACHE: dict[tuple, bool] = {}
_DATABASE_VERIFY_LOCK = threading.Lock()
_CLAMD_LOCK = threading.Lock()
_CLAMD_PROCESS: subprocess.Popen | None = None
_CLAMD_ATEXIT_REGISTERED = False
YARA_BINARY = os.environ.get("YARA_BINARY", "yara")
YARA_RULES_FILE = Path(os.environ.get("YARA_RULES_FILE", "/app/yara-rules/compiled.yarc"))
YARA_RULES_SHA256_FILE = Path(os.environ.get("YARA_RULES_SHA256_FILE", "/app/yara-rules/compiled.yarc.sha256"))
DEFAULT_YARA_SCAN_TIMEOUT_SECONDS = 180


@dataclass(frozen=True)
class ScanResult:
    sha256: str
    size: int
    mime_type: str
    filename: str
    media_kind: str
    probe: dict


@dataclass(frozen=True)
class FileValidation:
    size: int
    mime_type: str
    filename: str
    media_kind: str
    probe: dict
    file_identity: tuple[int, int, int, int]


def validate_file(
    path: Path,
    requested_name: str,
    declared_mime: str | None,
    max_bytes: int,
    deadline=None,
    reserve_seconds: float = 0,
    probe: dict | None = None,
) -> FileValidation:
    """Validate untrusted media without performing the final malware scan.

    This stage deliberately stays inside the disposable Container. It rejects
    obvious executable/archive payloads, MIME/extension mismatches, malformed
    media and unsafe streams before normalization. ffprobe is restricted to
    local file/pipe protocols. The heavier ClamAV/YARA pass is reserved for the
    exact artifact that will be persisted.
    """
    file_identity = _file_identity(path)
    size = file_identity[2]
    if size <= 0 or size > max_bytes:
        raise UnsafeFile("size_limit")
    filename = safe_filename(requested_name or path.name)
    _reject_filename(filename)
    with path.open("rb") as source:
        prefix = source.read(16)
    if any(prefix.startswith(magic) for magic in EXECUTABLE_MAGIC):
        raise UnsafeFile("executable_content")

    detected = _detect_mime(path, deadline, reserve_seconds)
    if _mime_family(detected) not in {"audio", "image", "video"} and detected not in {
        "application/mxf", "application/octet-stream", "application/ogg", "application/x-matroska",
    }:
        raise UnsafeFile("unsupported_mime")
    probe = probe if probe is not None else probe_file(path, deadline, reserve_seconds)
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

    _validate_media(detected, probe)
    if _file_identity(path) != file_identity:
        raise UnsafeFile("file_changed_during_validation")
    return FileValidation(size, detected, filename, media_kind, probe, file_identity)


def inspect_validated_file(
    path: Path,
    validation: FileValidation,
    deadline=None,
    reserve_seconds: float = 0,
    phase_ms=None, phase_cpu_ms=None,
) -> ScanResult:
    """Run the single fail-closed full scan on the artifact to be persisted."""
    phases = phase_ms if phase_ms is not None else {}
    _require_same_file(path, validation)
    _scan_malware(path, deadline, reserve_seconds, phases, phase_cpu_ms)
    _require_same_file(path, validation)
    with measure_phase(phases, "yara", phase_cpu_ms):
        _scan_yara(path, deadline, reserve_seconds)
    _require_same_file(path, validation)
    with measure_phase(phases, "sha256", phase_cpu_ms):
        sha256 = _sha256(path, deadline, reserve_seconds)
    _require_same_file(path, validation)
    return ScanResult(
        sha256, validation.size, validation.mime_type, validation.filename,
        validation.media_kind, validation.probe,
    )


def inspect_file(path: Path, requested_name: str, declared_mime: str | None, max_bytes: int, deadline=None, reserve_seconds: float = 0) -> ScanResult:
    """Compatibility wrapper for callers that need validation plus one scan."""
    validation = validate_file(path, requested_name, declared_mime, max_bytes, deadline, reserve_seconds)
    return inspect_validated_file(path, validation, deadline, reserve_seconds)


def clamav_database_status(database_dir: Path | None = None, now: float | None = None, deadline=None, reserve_seconds: float = 0) -> dict:
    root = database_dir or CLAMAV_DATABASE_DIR
    current = time.time() if now is None else float(now)
    max_age = _clamav_max_definition_age_seconds()
    databases = {}
    for name in REQUIRED_CLAMAV_DATABASES:
        if deadline is not None:
            deadline.ensure(reserve_seconds=reserve_seconds)
        path = _clamav_database_path(root, name)
        built_at = _clamav_database_build_time(path) if path else None
        verified = bool(path and built_at is not None and _clamav_database_signature_is_valid(path, deadline, reserve_seconds))
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


def require_fresh_clamav_definitions(database_dir: Path | None = None, now: float | None = None, deadline=None, reserve_seconds: float = 0) -> dict:
    status = clamav_database_status(database_dir, now, deadline, reserve_seconds)
    if not status["available"]:
        raise UnsafeFile("malware_definitions_missing")
    if not all(value["verified"] for value in status["databases"].values()):
        raise UnsafeFile("malware_definitions_invalid")
    if not status["healthy"]:
        raise UnsafeFile("malware_definitions_stale")
    return status


def yara_rules_status(rules_file: Path | None = None, checksum_file: Path | None = None, deadline=None, reserve_seconds: float = 0) -> dict:
    rules = rules_file or YARA_RULES_FILE
    checksum = checksum_file or YARA_RULES_SHA256_FILE
    binary = shutil.which(YARA_BINARY)
    available = bool(binary and rules.is_file() and checksum.is_file())
    if not available:
        return {"available": False, "verified": False, "healthy": False, "version": None}
    try:
        if deadline is not None:
            deadline.ensure(reserve_seconds=reserve_seconds)
        expected = checksum.read_text(encoding="ascii").split()[0].strip().lower()
        actual = _sha256(rules, deadline, reserve_seconds)
        version_result = subprocess.run(
            [binary, "--version"], capture_output=True, text=True,
            timeout=_phase_timeout(deadline, 10, reserve_seconds), check=False,
        )
        verify_result = subprocess.run(
            [binary, "-C", "-w", "-a", "10", "-l", "1", str(rules), os.devnull],
            capture_output=True, text=True, timeout=_phase_timeout(deadline, 15, reserve_seconds), check=False,
        )
        version = version_result.stdout.strip()[:40] if version_result.returncode == 0 else None
        verified = bool(re.fullmatch(r"[0-9a-f]{64}", expected)) and expected == actual and verify_result.returncode == 0
        return {"available": True, "verified": verified, "healthy": verified and version is not None, "version": version}
    except subprocess.TimeoutExpired as error:
        if deadline is not None:
            _raise_phase_timeout(deadline, reserve_seconds, "yara_rules_check_timeout", error)
        return {"available": True, "verified": False, "healthy": False, "version": None}
    except (OSError, UnicodeError, IndexError):
        return {"available": True, "verified": False, "healthy": False, "version": None}


def require_yara_rules(deadline=None, reserve_seconds: float = 0) -> dict:
    status = yara_rules_status(deadline=deadline, reserve_seconds=reserve_seconds)
    if not status["available"]:
        raise UnsafeFile("yara_unavailable")
    if not status["healthy"]:
        raise UnsafeFile("yara_rules_invalid")
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


def _detect_mime(path: Path, deadline=None, reserve_seconds: float = 0) -> str:
    try:
        result = subprocess.run(
            ["file", "--brief", "--mime-type", "--", str(path)],
            capture_output=True, text=True, timeout=_phase_timeout(deadline, 30, reserve_seconds), check=False,
        )
    except subprocess.TimeoutExpired as error:
        _raise_phase_timeout(deadline, reserve_seconds, "magic_timeout", error)
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


def probe_file(path: Path, deadline=None, reserve_seconds: float = 0) -> dict:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-max_alloc", "268435456", "-protocol_whitelist", "file,pipe", "-show_entries",
             "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,duration,bit_rate,sample_rate,channels:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation",
             "-of", "json", "--", str(path)],
            capture_output=True, text=True, timeout=_phase_timeout(deadline, 90, reserve_seconds), check=False,
            env=_local_parser_environment(),
        )
    except subprocess.TimeoutExpired as error:
        _raise_phase_timeout(deadline, reserve_seconds, "ffprobe_timeout", error)
    if result.returncode != 0:
        raise UnsafeFile("ffprobe_failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise UnsafeFile("ffprobe_invalid") from error


def _validate_media(detected_mime: str, probe: dict) -> None:
    streams = probe.get("streams", [])
    stream_types = {stream.get("codec_type") for stream in streams}
    if "attachment" in stream_types or "data" in stream_types:
        raise UnsafeFile("unsafe_embedded_stream")
    if not streams or any(kind not in {"audio", "video", "subtitle"} for kind in stream_types):
        # Still images are accepted through libmagic and decoded by Chromium/OS,
        # but ffprobe must validate every audio/video container.
        if not detected_mime.startswith("image/"):
            raise UnsafeFile("invalid_media_stream")


def _file_identity(path: Path) -> tuple[int, int, int, int]:
    try:
        stat = path.stat()
    except OSError as error:
        raise UnsafeFile("file_unavailable") from error
    return int(stat.st_dev), int(stat.st_ino), int(stat.st_size), int(stat.st_mtime_ns)


def _require_same_file(path: Path, validation: FileValidation) -> None:
    if _file_identity(path) != validation.file_identity:
        raise UnsafeFile("file_changed_after_validation")


def _scan_malware(path: Path, deadline=None, reserve_seconds: float = 0, phase_ms=None, phase_cpu_ms=None) -> None:
    phases = phase_ms if phase_ms is not None else {}
    with measure_phase(phases, "scannerReady", phase_cpu_ms):
        require_fresh_clamav_definitions(deadline=deadline, reserve_seconds=reserve_seconds)
        start_clamav_daemon(deadline=deadline, reserve_seconds=reserve_seconds)
    scan_deadline = time.monotonic() + _phase_timeout(deadline, _clamav_scan_timeout_seconds(), reserve_seconds)
    command = [
        "clamdscan", f"--config-file={CLAMD_CONFIG}", "--fdpass", "--no-summary", "--", str(path),
    ]
    try:
        with measure_phase(phases, "clamavNormal", phase_cpu_ms):
            result = subprocess.run(
                command, capture_output=True, text=True, timeout=max(0.1, scan_deadline - time.monotonic()), check=False,
            )
    except subprocess.TimeoutExpired as error:
        _raise_phase_timeout(deadline, reserve_seconds, "malware_scan_timeout", error)
    if result.returncode == 1:
        raise UnsafeFile("malware_detected")
    if result.returncode != 0 or result.stdout.strip() != f"{path}: OK" or result.stderr.strip():
        # Require an explicit clean result for this file, not just exit zero.
        # A scanner/configuration failure is not treated as a clean result.
        raise UnsafeFile("malware_scan_failed")
    if path.stat().st_size > CLAMD_WINDOW_BYTES:
        with measure_phase(phases, "clamavWindows", phase_cpu_ms):
            _scan_large_file_windows(path, scan_deadline, deadline, reserve_seconds)


def _scan_yara(path: Path, deadline=None, reserve_seconds: float = 0) -> None:
    require_yara_rules(deadline=deadline, reserve_seconds=reserve_seconds)
    phase_timeout = _phase_timeout(deadline, _yara_scan_timeout_seconds(), reserve_seconds)
    command = [
        YARA_BINARY, "-C", "-w", "-a", str(max(1, int(phase_timeout))), "-l", "1",
        str(YARA_RULES_FILE), str(path),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=phase_timeout, check=False,
            env=_local_parser_environment(),
        )
    except (OSError, subprocess.SubprocessError) as error:
        if isinstance(error, subprocess.TimeoutExpired):
            _raise_phase_timeout(deadline, reserve_seconds, "yara_scan_timeout", error)
        raise UnsafeFile("yara_scan_failed") from error
    if result.returncode != 0:
        if "timeout" in result.stderr.lower():
            _raise_phase_timeout(deadline, reserve_seconds, "yara_scan_timeout")
        raise UnsafeFile("yara_scan_failed")
    if result.stdout.strip():
        raise UnsafeFile("yara_detected")


def start_clamav_daemon(deadline=None, reserve_seconds: float = 0) -> None:
    global _CLAMD_PROCESS, _CLAMD_ATEXIT_REGISTERED
    if clamav_daemon_ready(deadline, reserve_seconds):
        return
    with _CLAMD_LOCK:
        if clamav_daemon_ready(deadline, reserve_seconds):
            return
        if _CLAMD_PROCESS is not None and _CLAMD_PROCESS.poll() is None:
            stop_clamav_daemon(deadline=deadline, reserve_seconds=reserve_seconds)
        startup_timeout = _phase_timeout(deadline, 45, reserve_seconds)
        try:
            CLAMD_SOCKET.unlink(missing_ok=True)
            _CLAMD_PROCESS = subprocess.Popen(
                ["clamd", f"--config-file={CLAMD_CONFIG}"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise UnsafeFile("malware_scanner_unavailable") from error
        startup_deadline = time.monotonic() + startup_timeout
        while time.monotonic() < startup_deadline:
            if deadline is not None:
                deadline.ensure(reserve_seconds=reserve_seconds)
            if _CLAMD_PROCESS.poll() is not None:
                break
            if clamav_daemon_ready(deadline, reserve_seconds):
                if not _CLAMD_ATEXIT_REGISTERED:
                    atexit.register(stop_clamav_daemon)
                    _CLAMD_ATEXIT_REGISTERED = True
                return
            time.sleep(0.1)
        stop_clamav_daemon(deadline=deadline, reserve_seconds=reserve_seconds)
        if deadline is not None:
            deadline.ensure(reserve_seconds=reserve_seconds)
        raise UnsafeFile("malware_scanner_unavailable")


def stop_clamav_daemon(deadline=None, reserve_seconds: float = 0) -> None:
    global _CLAMD_PROCESS
    process = _CLAMD_PROCESS
    _CLAMD_PROCESS = None
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=_bounded_cleanup_timeout(deadline, reserve_seconds, 10))
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=_bounded_cleanup_timeout(deadline, reserve_seconds, 5))
            except subprocess.TimeoutExpired:
                pass
    try:
        CLAMD_SOCKET.unlink(missing_ok=True)
    except OSError:
        pass


def clamav_daemon_ready(deadline=None, reserve_seconds: float = 0) -> bool:
    if not hasattr(socket, "AF_UNIX"):
        return False
    timeout = 2 if deadline is None else deadline.timeout(maximum_seconds=2, reserve_seconds=reserve_seconds)
    try:
        response = _clamd_command(b"zPING\0", timeout=timeout)
        return response.rstrip(b"\0") == b"PONG"
    except (OSError, TimeoutError, UnsafeFile):
        return False


def _scan_large_file_windows(path: Path, scan_deadline: float | None = None, job_deadline=None, reserve_seconds: float = 0) -> None:
    scan_deadline = scan_deadline if scan_deadline is not None else time.monotonic() + _clamav_scan_timeout_seconds()
    size = path.stat().st_size
    offset = 0
    with path.open("rb") as source:
        while offset < size:
            remaining_time = scan_deadline - time.monotonic()
            if job_deadline is not None:
                remaining_time = min(remaining_time, job_deadline.timeout(reserve_seconds=reserve_seconds))
            if remaining_time <= 0:
                raise UnsafeFile("malware_scan_timeout")
            source.seek(offset)
            length = min(CLAMD_WINDOW_BYTES, size - offset)
            try:
                result = _clamd_stream(source, length, remaining_time)
            except UnsafeFile as error:
                if str(error) == "malware_scan_timeout":
                    _raise_phase_timeout(job_deadline, reserve_seconds, "malware_scan_timeout", error)
                raise
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
            connection.settimeout(max(0.1, timeout if timeout is not None else _clamav_scan_timeout_seconds()))
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


def _yara_scan_timeout_seconds() -> int:
    try:
        value = int(os.environ.get("YARA_SCAN_TIMEOUT_SECONDS", DEFAULT_YARA_SCAN_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_YARA_SCAN_TIMEOUT_SECONDS
    return value if 10 <= value <= 600 else DEFAULT_YARA_SCAN_TIMEOUT_SECONDS


def _clamav_database_path(root: Path, name: str) -> Path | None:
    for suffix in ("cld", "cvd"):
        candidate = root / f"{name}.{suffix}"
        if candidate.is_file():
            return candidate
    return None


def _clamav_database_signature_is_valid(path: Path, deadline=None, reserve_seconds: float = 0) -> bool:
    try:
        stat = path.stat()
        key = (str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    except OSError:
        return False
    with _DATABASE_VERIFY_LOCK:
        if key in _DATABASE_VERIFY_CACHE:
            return _DATABASE_VERIFY_CACHE[key]
    try:
        result = subprocess.run(
            ["sigtool", "--info", str(path)], capture_output=True, text=True,
            timeout=_phase_timeout(deadline, 120, reserve_seconds), check=False,
        )
        output = f"{result.stdout}\n{result.stderr}".lower()
        valid = result.returncode == 0 and re.search(r"verification\s*:?\s*ok", output) is not None
    except subprocess.TimeoutExpired as error:
        if deadline is not None:
            _raise_phase_timeout(deadline, reserve_seconds, "malware_definitions_invalid", error)
        valid = False
    except OSError:
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


def _sha256(path: Path, deadline=None, reserve_seconds: float = 0) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            if deadline is not None:
                deadline.ensure(reserve_seconds=reserve_seconds)
            digest.update(chunk)
    return digest.hexdigest()


def _local_parser_environment() -> dict:
    return {key: value for key, value in os.environ.items() if key not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}}


def _raise_phase_timeout(deadline, reserve_seconds: float, code: str, cause=None) -> None:
    if deadline is not None:
        try:
            deadline.ensure(reserve_seconds=reserve_seconds)
        except TimeoutError:
            raise
    if cause is None:
        raise UnsafeFile(code)
    raise UnsafeFile(code) from cause


def _bounded_cleanup_timeout(deadline, reserve_seconds: float, maximum_seconds: float) -> float:
    if deadline is None:
        return maximum_seconds
    remaining = deadline.remaining() - max(0.0, float(reserve_seconds))
    return max(0.05, min(float(maximum_seconds), remaining))


def _phase_timeout(deadline, maximum_seconds: float, reserve_seconds: float = 0) -> float:
    if deadline is None:
        return float(maximum_seconds)
    return deadline.timeout(maximum_seconds=maximum_seconds, reserve_seconds=reserve_seconds)
