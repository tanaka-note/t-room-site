from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import subprocess
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
    definitions = [
        path for pattern in ("*.cvd", "*.cld")
        for path in root.glob(pattern)
        if path.is_file()
    ]
    current = time.time() if now is None else float(now)
    build_times = [_clamav_database_build_time(path) for path in definitions]
    newest = max((value for value in build_times if value is not None), default=None)
    max_age = _clamav_max_definition_age_seconds()
    age = None if newest is None else max(0, int(current - newest))
    return {
        "available": newest is not None,
        "healthy": newest is not None and age <= max_age,
        "latestDefinitionUnix": int(newest) if newest is not None else None,
        "freshnessSource": "database_build_time",
        "ageSeconds": age,
        "maxAgeSeconds": max_age,
    }


def require_fresh_clamav_definitions(database_dir: Path | None = None, now: float | None = None) -> dict:
    status = clamav_database_status(database_dir, now)
    if not status["available"]:
        raise UnsafeFile("malware_definitions_missing")
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
    result = subprocess.run(
        ["clamscan", "--no-summary", "--infected", "--", str(path)],
        capture_output=True, text=True, timeout=180, check=False,
    )
    if result.returncode == 1:
        raise UnsafeFile("malware_detected")
    if result.returncode != 0:
        # A scanner/configuration failure is not treated as a clean result.
        raise UnsafeFile("malware_scan_failed")


def _clamav_max_definition_age_seconds() -> int:
    try:
        value = int(os.environ.get("CLAMAV_MAX_DEFINITION_AGE_SECONDS", DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS
    return value if 3600 <= value <= 30 * 24 * 60 * 60 else DEFAULT_CLAMAV_MAX_DEFINITION_AGE_SECONDS


def _clamav_database_build_time(path: Path) -> int | None:
    """Read the signed CVD/CLD header timestamp instead of mutable file mtime."""
    try:
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
