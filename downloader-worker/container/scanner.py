from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import subprocess
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
    ".3g2", ".3gp", ".aac", ".asf", ".avi", ".avif", ".f4v", ".flac", ".flv",
    ".gif", ".jpeg", ".jpg", ".m2ts", ".m2v", ".m4a", ".m4v", ".mkv", ".mov",
    ".mp3", ".mp4", ".mpeg", ".mpg", ".mts", ".oga", ".ogg", ".ogv", ".opus",
    ".png", ".ts", ".vob", ".webm", ".webp", ".wmv",
}
EXECUTABLE_MAGIC = (
    b"MZ", b"\x7fELF", b"#!", b"\xca\xfe\xba\xbe", b"PK\x03\x04",
)


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
    probe = probe_file(path)
    media_kind = _media_kind(detected, probe)
    if media_kind is None:
        raise UnsafeFile("unsupported_mime")
    declared = (declared_mime or "").split(";", 1)[0].strip().lower()
    if declared and declared != "application/octet-stream" and _mime_family(declared) in {"audio", "image", "video"} and _mime_family(declared) != media_kind:
        raise UnsafeFile("mime_mismatch")
    expected, _ = mimetypes.guess_type(filename)
    ambiguous_ogg = Path(filename).suffix.lower() == ".ogg" and detected in {"application/ogg", "audio/ogg", "video/ogg"}
    if expected and _mime_family(expected) in {"audio", "image", "video"} and _mime_family(expected) != media_kind and not ambiguous_ogg:
        raise UnsafeFile("extension_mismatch")

    _validate_media(path, probe)
    _scan_malware(path)
    return ScanResult(_sha256(path), size, detected, filename, media_kind)


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
    if any(stream.get("codec_type") == "video" for stream in streams):
        return "video"
    if any(stream.get("codec_type") == "audio" for stream in streams):
        return "audio"
    return None


def _mime_family(value: str) -> str:
    return value.split("/", 1)[0].lower() if "/" in value else ""


def probe_file(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,duration,bit_rate,sample_rate,channels:stream_tags=rotate:stream_side_data=rotation",
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
    if not streams or any(stream.get("codec_type") not in {"audio", "video"} for stream in streams):
        # Still images are accepted through libmagic and decoded by Chromium/OS,
        # but ffprobe must validate every audio/video container.
        mime = _detect_mime(path)
        if not mime.startswith("image/"):
            raise UnsafeFile("invalid_media_stream")


def _scan_malware(path: Path) -> None:
    result = subprocess.run(
        ["clamscan", "--no-summary", "--infected", "--", str(path)],
        capture_output=True, text=True, timeout=180, check=False,
    )
    if result.returncode == 1:
        raise UnsafeFile("malware_detected")
    if result.returncode != 0:
        # A scanner/configuration failure is not treated as a clean result.
        raise UnsafeFile("malware_scan_failed")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
