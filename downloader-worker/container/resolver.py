from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
try:
    import resource
except ImportError:  # pragma: no cover - Windows unit tests; production is Linux
    resource = None
import subprocess
import tempfile
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree

from adapters import ADAPTERS
from ssrf import UnsafeUrl, validate_redirect, validate_url


class ResolverError(ValueError):
    pass


MEDIA_MIMES = ("audio/", "image/", "video/", "application/vnd.apple.mpegurl", "application/dash+xml")
MEDIA_SUFFIXES = (
    ".3g2", ".3gp", ".aac", ".asf", ".avi", ".f4v", ".flac", ".flv", ".gif", ".jpeg", ".jpg",
    ".m2ts", ".m2v", ".m3u8", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".mpd",
    ".mpeg", ".mpg", ".mts", ".ogg", ".ogv", ".opus", ".png", ".ts", ".vob", ".webm",
    ".webp", ".wmv",
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class MediaHtmlParser(HTMLParser):
    def __init__(self, base: str):
        super().__init__()
        self.base = base
        self.candidates: list[str] = []
        self.title = ""
        self._title = False
        self.metadata = {}

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag in {"video", "audio", "source", "iframe"} and values.get("src"):
            self.candidates.append(urljoin(self.base, values["src"]))
        if tag == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            content = values.get("content") or ""
            if key in {"og:video", "og:video:url", "og:audio", "twitter:player:stream"} and content:
                self.candidates.append(urljoin(self.base, content))
            if key in {"og:title", "twitter:title", "author"}:
                self.metadata[key] = content
        self._title = tag == "title"

    def handle_endtag(self, tag):
        if tag == "title":
            self._title = False

    def handle_data(self, data):
        if self._title:
            self.title += data


def analyze(source_url: str, max_bytes: int, policy_restricted: bool = False) -> dict:
    safe = validate_url(source_url)
    for adapter in ADAPTERS:
        if adapter.matches(safe.value):
            return adapter.analyze(safe.value, max_bytes=max_bytes)

    direct = _analyze_direct(safe.value, max_bytes)
    if direct:
        if policy_restricted:
            direct["warning"] = "このサイトは解析のみ対応しています。公式の保存機能をご利用ください。"
            for item in direct.get("media", []):
                item["downloadable"] = False
                item["unavailableReason"] = "このサイトは利用規約上、本体を取得できません。"
        return direct
    metadata = _yt_dlp_metadata(safe.value, timeout=90)
    if metadata:
        return _normalize_ytdlp(metadata, safe.hostname, policy_restricted)
    if policy_restricted:
        raise ResolverError("policy_restricted")
    generic = _analyze_html(safe.value, max_bytes, browser=False)
    if generic:
        return generic
    browser = _analyze_html(safe.value, max_bytes, browser=True)
    if browser:
        browser["browserFallbackUsed"] = True
        return browser
    raise ResolverError("media_not_found")


def download(source_url: str, media_id: str, workdir: Path, max_bytes: int, timeout_seconds: int) -> tuple[Path, str, str | None]:
    safe = validate_url(source_url)
    direct = _analyze_direct(safe.value, max_bytes)
    if direct and media_id == "direct" and direct["media"][0].get("delivery") == "direct":
        item = direct["media"][0]
        name = _name_from_url(safe.value, item.get("mime"))
        path = workdir / name
        _download_direct(safe.value, path, max_bytes, timeout_seconds)
        return path, name, item.get("mime")

    metadata = _yt_dlp_metadata(safe.value, timeout=min(120, timeout_seconds))
    if not metadata:
        raise ResolverError("media_not_found")
    if metadata.get("is_live") or metadata.get("live_status") in {"is_live", "is_upcoming"}:
        raise ResolverError("live_stream_not_supported")
    mapping = _ytdlp_choices(metadata)
    choice = next((choice for choice in mapping if choice["mediaId"] == media_id), None)
    if media_id == "direct" and direct and direct["media"][0].get("delivery") in {"hls", "dash"}:
        _validate_adaptive_source(safe.value, direct["media"][0]["delivery"])
        choice = mapping[0] if mapping else {
            "playlistIndex": None, "formatSelector": "bestvideo+bestaudio/best",
            "filename": _name_from_url(safe.value, "video/mp4"), "mime": "video/mp4",
        }
    if not choice:
        raise ResolverError("media_choice_missing")
    output = str(workdir / "media.%(ext)s")
    command = [
        "yt-dlp", "--ignore-config", "--no-cache-dir", "--no-cookies-from-browser", "--no-netrc",
        "--no-playlist" if choice["playlistIndex"] is None else "--yes-playlist",
        "--no-write-info-json", "--no-write-thumbnail", "--no-write-subs", "--no-write-comments",
        "--restrict-filenames", "--no-part", "--max-filesize", str(max_bytes),
        "--socket-timeout", "30", "--retries", "2", "--fragment-retries", "2",
        "--downloader-args", "ffmpeg_i:-protocol_whitelist http,https,tcp,tls",
        "-f", choice["formatSelector"], "-o", output,
    ]
    if choice["playlistIndex"] is not None:
        command += ["--playlist-items", str(choice["playlistIndex"])]
    command.append(safe.value)
    result = subprocess.run(
        command, capture_output=True, text=True, timeout=timeout_seconds, check=False,
        preexec_fn=(lambda: _subprocess_limits(max_bytes)) if resource is not None else None, env=_subprocess_environment(),
    )
    if result.returncode != 0:
        raise ResolverError("download_failed")
    files = [path for path in workdir.iterdir() if path.is_file()]
    if not files:
        raise ResolverError("download_missing")
    path = max(files, key=lambda candidate: candidate.stat().st_size)
    if path.stat().st_size > max_bytes:
        raise ResolverError("size_limit")
    return path, choice.get("filename") or path.name, choice.get("mime")


def _analyze_direct(url: str, max_bytes: int) -> dict | None:
    signature = b""
    try:
        response, final_url = _open(url, method="HEAD", timeout=20, max_redirects=5)
    except Exception:
        try:
            response, final_url = _open(url, method="GET", timeout=20, max_redirects=5, request_headers={"Range": "bytes=0-65535"})
            signature = response.read(65_536)
        except Exception:
            return None
    try:
        content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
        length = _safe_int(response.headers.get("Content-Length"))
        path_suffix = Path(urlsplit(final_url).path).suffix.lower()
        suffix = path_suffix
        if "mpegurl" in content_type or "dash+xml" in content_type or suffix in {".m3u8", ".mpd"}:
            signature = signature or _read_signature(final_url)
            detected = _signature_type(signature)
            if not detected:
                return None
            content_type, suffix = _refine_signature_type(detected, path_suffix)
        else:
            signature = signature or _read_signature(final_url)
            detected = _signature_type(signature)
            if not detected:
                return None
            content_type, suffix = _refine_signature_type(detected, path_suffix)
        media_type = _media_type(content_type, suffix)
        delivery = "hls" if suffix == ".m3u8" or "mpegurl" in content_type else "dash" if suffix == ".mpd" or "dash+xml" in content_type else "direct"
        encrypted = (delivery == "hls" and _encrypted_hls(signature)) or (delivery == "dash" and _drm_dash(signature))
        live = delivery == "hls" and _live_media_playlist(signature)
        downloadable = (length is None or length <= max_bytes) and not encrypted and not live
        return {
            "site": urlsplit(final_url).hostname,
            "hostname": urlsplit(url).hostname,
            "finalHostname": urlsplit(final_url).hostname,
            "title": _name_from_url(final_url, content_type),
            "extractor": "direct",
            "media": [{
                "mediaId": "direct", "title": _name_from_url(final_url, content_type),
                "mediaType": media_type, "container": suffix.lstrip(".") or None,
                "mime": content_type or None, "estimatedSize": length, "delivery": delivery,
                "drm": encrypted, "loginRequired": False, "downloadable": downloadable,
                "unavailableReason": None if downloadable else (
                    "暗号化またはDRMが使用されているため取得できません。" if encrypted else
                    "終了点を確認できないライブ配信は取得できません。" if live else
                    "ファイルサイズが上限を超えています。"
                ),
            }],
        }
    finally:
        response.close()


def _analyze_html(url: str, max_bytes: int, browser: bool) -> dict | None:
    final_url = url
    if browser:
        result = subprocess.run(
            ["chromium", "--headless", "--disable-gpu", "--disable-dev-shm-usage",
             "--disable-extensions", "--disable-sync", "--disable-background-networking", "--dump-dom", url],
            capture_output=True, text=True, timeout=60, check=False,
            env=_subprocess_environment(),
        )
        if result.returncode != 0 or len(result.stdout) > 5_000_000:
            return None
        html = result.stdout
    else:
        response, final_url = _open(url, method="GET", timeout=25, max_redirects=5, max_body=2_000_000)
        try:
            content_type = response.headers.get("Content-Type") or ""
            if "html" not in content_type.lower():
                return None
            html = response.read(2_000_001).decode("utf-8", "replace")
            if len(html) > 2_000_000:
                return None
        finally:
            response.close()
    parser = MediaHtmlParser(final_url)
    parser.feed(html)
    for candidate in parser.candidates[:20]:
        try:
            direct = _analyze_direct(validate_url(candidate).value, max_bytes)
        except (UnsafeUrl, OSError):
            continue
        if direct:
            direct["site"] = urlsplit(final_url).hostname
            direct["title"] = (parser.metadata.get("og:title") or parser.metadata.get("twitter:title") or parser.title.strip() or direct["title"])[:240]
            direct["extractor"] = "browser-generic" if browser else "html-generic"
            return direct
    return None


def _yt_dlp_metadata(url: str, timeout: int) -> dict | None:
    command = [
        "yt-dlp", "--ignore-config", "--no-cache-dir", "--no-cookies-from-browser", "--no-netrc",
        "--dump-single-json", "--skip-download", "--no-warnings", "--socket-timeout", "20",
        "--retries", "1", "--extractor-retries", "1", url,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False, env=_subprocess_environment())
    if result.returncode != 0 or len(result.stdout) > 10_000_000:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def _normalize_ytdlp(metadata: dict, hostname: str, policy_restricted: bool) -> dict:
    entries = metadata.get("entries") if isinstance(metadata.get("entries"), list) else [metadata]
    choices = _ytdlp_choices(metadata)
    downloadable = not policy_restricted
    return {
        "site": _text(metadata.get("extractor_key") or metadata.get("extractor") or hostname, 120),
        "hostname": hostname,
        "finalHostname": hostname,
        "title": _text(metadata.get("title"), 240),
        "uploader": _text(metadata.get("uploader") or metadata.get("channel"), 160),
        "publishedAt": _text(metadata.get("upload_date") or metadata.get("timestamp"), 40),
        "thumbnail": _text(metadata.get("thumbnail"), 1024),
        "extractor": _text(metadata.get("extractor"), 80) or "yt-dlp",
        "warning": "このサイトは解析のみ対応しています。公式の保存機能をご利用ください。" if policy_restricted else None,
        "media": [{
            **choice,
            "downloadable": downloadable and not choice["drm"] and not choice["loginRequired"],
            "unavailableReason": "このサイトは利用規約上、本体を取得できません。" if policy_restricted else None,
        } for choice in choices[:50]],
    }


def _ytdlp_choices(metadata: dict) -> list[dict]:
    entries = metadata.get("entries") if isinstance(metadata.get("entries"), list) else [metadata]
    result = []
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            continue
        formats = entry.get("formats") if isinstance(entry.get("formats"), list) else []
        candidates = _preferred_formats(formats) or [entry]
        for item in candidates:
            format_id = str(item.get("format_id") or "best")
            selector = f"{index}|{entry.get('id') or ''}|{format_id}"
            ext = str(item.get("ext") or entry.get("ext") or "mp4")[:12]
            media_type = "audio" if item.get("vcodec") == "none" else "video"
            result.append({
                "mediaId": hashlib.sha256(selector.encode()).hexdigest()[:32],
                "title": _text(entry.get("title"), 240) or f"メディア {index}",
                "mediaType": media_type,
                "container": ext,
                "mime": mimetypes.types_map.get(f".{ext}"),
                "estimatedSize": _safe_int(item.get("filesize") or item.get("filesize_approx")),
                "width": _safe_int(item.get("width")), "height": _safe_int(item.get("height")),
                "fps": _safe_int(item.get("fps")), "duration": _safe_int(entry.get("duration")),
                "videoCodec": _text(item.get("vcodec"), 80), "audioCodec": _text(item.get("acodec"), 80),
                "delivery": _delivery(item.get("protocol")),
                "drm": bool(entry.get("has_drm") or item.get("has_drm")),
                "loginRequired": bool(entry.get("availability") in {"needs_auth", "premium_only", "subscriber_only"}),
                "playlistIndex": index if len(entries) > 1 else None,
                "formatSelector": (
                    f"{format_id}+bestaudio/best" if item.get("vcodec") not in {None, "none"} and item.get("acodec") == "none"
                    else format_id if format_id != "best" else "bestvideo+bestaudio/best"
                ),
                "filename": f"{_text(entry.get('title'), 100) or 'download'}.{ext}",
            })
    return result


def _preferred_formats(formats: list[dict]) -> list[dict]:
    usable = [item for item in formats if item.get("url") and not item.get("has_drm")]
    muxed = [item for item in usable if item.get("vcodec") not in {None, "none"} and item.get("acodec") not in {None, "none"}]
    audio = [item for item in usable if item.get("vcodec") == "none" and item.get("acodec") not in {None, "none"}]
    chosen = []
    if muxed:
        chosen.append(max(muxed, key=lambda item: (_safe_int(item.get("height")) or 0, _safe_int(item.get("tbr")) or 0)))
    elif usable:
        chosen.append(max(usable, key=lambda item: (_safe_int(item.get("height")) or 0, _safe_int(item.get("tbr")) or 0)))
    if audio:
        best_audio = max(audio, key=lambda item: _safe_int(item.get("abr")) or 0)
        if best_audio not in chosen:
            chosen.append(best_audio)
    return chosen


def _download_direct(url: str, path: Path, max_bytes: int, timeout_seconds: int) -> None:
    response, _ = _open(url, method="GET", timeout=min(60, timeout_seconds), max_redirects=5)
    total = 0
    started = time.monotonic()
    try:
        with path.open("wb") as destination:
            while True:
                if time.monotonic() - started > timeout_seconds:
                    raise ResolverError("download_timeout")
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ResolverError("size_limit")
                destination.write(chunk)
    finally:
        response.close()


def _read_signature(url: str) -> bytes:
    response, _ = _open(url, method="GET", timeout=20, max_redirects=5, request_headers={"Range": "bytes=0-65535"})
    try:
        return response.read(65_536)
    finally:
        response.close()


def _signature_type(value: bytes) -> tuple[str, str] | None:
    sample = value.lstrip()
    upper = sample[:8192].upper()
    if sample.startswith(b"#EXTM3U"):
        return "application/vnd.apple.mpegurl", ".m3u8"
    if upper.startswith(b"<?XML") or upper.startswith(b"<MPD"):
        if b"<MPD" in upper:
            return "application/dash+xml", ".mpd"
    if len(value) >= 12 and value[4:8] == b"ftyp":
        return "video/mp4", ".mp4"
    if value.startswith(b"\x1aE\xdf\xa3"):
        return "video/x-matroska", ".mkv"
    if value.startswith(b"0&\xb2u\x8ef\xcf\x11\xa6\xd9\x00\xaa\x00b\xcel"):
        return "video/x-ms-wmv", ".wmv"
    if value.startswith(b"RIFF") and value[8:12] == b"AVI ":
        return "video/x-msvideo", ".avi"
    if value.startswith(b"FLV"):
        return "video/x-flv", ".flv"
    if len(value) > 188 and value[0] == 0x47 and value[188] == 0x47:
        return "video/mp2t", ".ts"
    if value.startswith(b"\x00\x00\x01\xba"):
        return "video/mpeg", ".mpeg"
    if value.startswith(b"\x00\x00\x01\xb3"):
        return "video/mpeg", ".mpeg"
    if len(value) > 196 and value[4] == 0x47 and value[196] == 0x47:
        return "video/mp2t", ".m2ts"
    if value.startswith(b"OggS"):
        return "application/ogg", ".ogg"
    if value.startswith(b"fLaC"):
        return "audio/flac", ".flac"
    if value.startswith(b"ID3") or (len(value) >= 2 and value[0] == 0xFF and value[1] & 0xE0 == 0xE0):
        return "audio/mpeg", ".mp3"
    if value.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if value.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if value.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", ".gif"
    if value.startswith(b"RIFF") and value[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def _refine_signature_type(detected: tuple[str, str], path_suffix: str) -> tuple[str, str]:
    mime, detected_suffix = detected
    suffix = str(path_suffix or "").lower()
    if detected_suffix == ".mp4" and suffix in {".3g2", ".3gp", ".m4v", ".mov", ".mp4"}:
        return ("video/quicktime" if suffix == ".mov" else "video/mp4", suffix)
    if detected_suffix == ".mkv" and suffix == ".webm":
        return "video/webm", suffix
    if detected_suffix == ".wmv" and suffix == ".asf":
        return "video/x-ms-asf", suffix
    if detected_suffix == ".ogg" and suffix == ".ogv":
        return "video/ogg", suffix
    if detected_suffix == ".ogg" and suffix in {".oga", ".ogg", ".opus"}:
        return "audio/ogg", suffix
    if detected_suffix in {".ts", ".m2ts"} and suffix in {".m2ts", ".mts", ".ts"}:
        return "video/mp2t", suffix
    if detected_suffix == ".mpeg" and suffix in {".m2v", ".mpeg", ".mpg", ".vob"}:
        return "video/mpeg", suffix
    return mime, detected_suffix


def _validate_adaptive_source(url: str, delivery: str) -> None:
    if delivery == "hls":
        _validate_hls_tree(url, set(), [0])
        return
    if delivery == "dash":
        _validate_dash_manifest(url)
        return
    raise ResolverError("adaptive_protocol_invalid")


def _read_manifest(url: str) -> tuple[bytes, str]:
    response, final_url = _open(url, method="GET", timeout=30, max_redirects=5, max_body=1_000_000)
    try:
        content = response.read(1_000_001)
    finally:
        response.close()
    if len(content) > 1_000_000:
        raise ResolverError("manifest_too_large")
    return content, final_url


def _validate_hls_tree(url: str, visited: set[str], segment_count: list[int]) -> None:
    safe = validate_url(url).value
    if safe in visited:
        return
    if len(visited) >= 16:
        raise ResolverError("manifest_playlist_limit")
    visited.add(safe)
    content, final_url = _read_manifest(safe)
    text = content.decode("utf-8", "replace")
    if not text.lstrip().startswith("#EXTM3U"):
        raise ResolverError("manifest_invalid")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    is_master = any(line.upper().startswith("#EXT-X-STREAM-INF:") for line in lines)
    has_media = any(line.upper().startswith("#EXTINF:") for line in lines)
    if has_media and not any(line.upper() == "#EXT-X-ENDLIST" for line in lines):
        raise ResolverError("live_stream_not_supported")

    next_is_playlist = False
    for line in lines:
        upper = line.upper()
        if upper.startswith("#EXT-X-STREAM-INF:"):
            next_is_playlist = True
            continue
        if line.startswith("#"):
            for match in re.finditer(r'URI=(?:"([^"]+)"|([^,]+))', line, flags=re.IGNORECASE):
                reference = (match.group(1) or match.group(2) or "").strip()
                target = validate_url(urljoin(final_url, reference)).value
                if upper.startswith("#EXT-X-MEDIA:"):
                    _validate_hls_tree(target, visited, segment_count)
            continue
        target = validate_url(urljoin(final_url, line)).value
        if next_is_playlist or is_master or urlsplit(target).path.lower().endswith(".m3u8"):
            _validate_hls_tree(target, visited, segment_count)
            next_is_playlist = False
            continue
        segment_count[0] += 1
        if segment_count[0] > 5000:
            raise ResolverError("manifest_segment_limit")
    if _encrypted_hls(content):
        raise ResolverError("encrypted_stream_not_supported")


def _validate_dash_manifest(url: str) -> None:
    content, final_url = _read_manifest(validate_url(url).value)
    if _drm_dash(content):
        raise ResolverError("drm_not_supported")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise ResolverError("manifest_invalid") from error
    if not root.tag.lower().endswith("mpd"):
        raise ResolverError("manifest_invalid")
    if str(root.attrib.get("type") or "static").lower() == "dynamic":
        raise ResolverError("live_stream_not_supported")
    for element in root.iter():
        local_name = element.tag.rsplit("}", 1)[-1].lower()
        if local_name in {"baseurl", "location"} and (element.text or "").strip():
            validate_url(urljoin(final_url, (element.text or "").strip()))
        for name, value in element.attrib.items():
            local_attribute = name.rsplit("}", 1)[-1].lower()
            if local_attribute in {"href", "sourceurl", "media", "initialization", "index"} and value:
                validate_url(urljoin(final_url, value))


def _encrypted_hls(value: bytes) -> bool:
    text = value.decode("utf-8", "replace").upper()
    return any(line.startswith("#EXT-X-KEY:") and "METHOD=NONE" not in line for line in text.splitlines())


def _drm_dash(value: bytes) -> bool:
    text = value.decode("utf-8", "replace").lower()
    return "<contentprotection" in text or "widevine" in text or "playready" in text


def _live_media_playlist(value: bytes) -> bool:
    text = value.decode("utf-8", "replace").upper()
    return "#EXTINF" in text and "#EXT-X-STREAM-INF" not in text and "#EXT-X-ENDLIST" not in text


def _open(url: str, *, method: str, timeout: int, max_redirects: int, max_body: int | None = None, request_headers: dict | None = None):
    opener = build_opener(NoRedirect)
    current = validate_url(url).value
    for _ in range(max_redirects + 1):
        headers = {"User-Agent": "T-lain-Downloader/1.0", "Accept": "*/*", **(request_headers or {})}
        request = Request(current, method=method, headers=headers)
        try:
            response = opener.open(request, timeout=timeout)
            if max_body is not None and _safe_int(response.headers.get("Content-Length")) not in {None} and int(response.headers["Content-Length"]) > max_body:
                response.close()
                raise ResolverError("response_too_large")
            return response, current
        except Exception as error:
            code = getattr(error, "code", None)
            if code not in {301, 302, 303, 307, 308}:
                raise
            current = validate_redirect(current, error.headers.get("Location")).value
    raise ResolverError("too_many_redirects")


def _subprocess_limits(max_bytes: int) -> None:
    if resource is None:
        return
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_bytes, max_bytes))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def _subprocess_environment() -> dict:
    env = {key: value for key, value in os.environ.items() if key not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}}
    ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
    if os.path.exists(ca):
        env.update({"SSL_CERT_FILE": ca, "REQUESTS_CA_BUNDLE": ca})
    return env


def _name_from_url(url: str, mime: str | None) -> str:
    name = Path(urlsplit(url).path).name or "download"
    if "." not in name:
        extension = mimetypes.guess_extension((mime or "").split(";", 1)[0]) or ""
        name += extension
    return _text(name, 120) or "download"


def _media_type(mime: str, suffix: str) -> str:
    if mime.startswith("audio/") or suffix in {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus"}:
        return "audio"
    if mime.startswith("image/") or suffix in {".gif", ".jpeg", ".jpg", ".png", ".webp"}:
        return "image"
    return "video"


def _delivery(protocol) -> str:
    value = str(protocol or "").lower()
    if "m3u8" in value or "hls" in value:
        return "hls"
    if "dash" in value or "http_dash" in value:
        return "dash"
    return "direct"


def _safe_int(value):
    try:
        number = int(float(value))
        return number if number >= 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _text(value, maximum: int) -> str | None:
    text = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return text[:maximum] or None
