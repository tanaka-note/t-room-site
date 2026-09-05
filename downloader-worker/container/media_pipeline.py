from __future__ import annotations

import json
import os
try:
    import resource
except ImportError:  # pragma: no cover - Windows unit tests; production is Linux
    resource = None
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from scanner import UnsafeFile, _is_playable_video_stream, probe_file, safe_filename


class PlanKind(str, Enum):
    PASS_THROUGH = "PASS_THROUGH"
    REMUX = "REMUX"
    PARTIAL_TRANSCODE = "PARTIAL_TRANSCODE"
    FULL_TRANSCODE = "FULL_TRANSCODE"
    REJECT = "REJECT"


@dataclass(frozen=True)
class MediaPlan:
    kind: PlanKind
    video_codec: str
    audio_codec: str
    reason: str


MAX_DURATION_SECONDS = 3 * 60 * 60
MAX_WIDTH = 7680
MAX_HEIGHT = 4320
MAX_STREAMS = 16
H264_PIXEL_FORMATS = {"yuv420p", "yuvj420p"}
VIDEO_TRANSCODE_BUDGET_EQUIVALENT_1080P30_SECONDS = 240.0


def plan_mp4(probe: dict) -> MediaPlan:
    streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
    videos = [stream for stream in streams if _is_playable_video_stream(stream)]
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if not videos:
        return MediaPlan(PlanKind.REJECT, "none", "none", "video_stream_missing")
    if any(stream.get("codec_type") in {"attachment", "data"} for stream in streams):
        return MediaPlan(PlanKind.REJECT, "unknown", "unknown", "unsafe_embedded_stream")
    if len(streams) > MAX_STREAMS or len(videos) != 1:
        return MediaPlan(PlanKind.REJECT, "unknown", "unknown", "stream_limit")
    video = videos[0]
    if int(video.get("width") or 0) > MAX_WIDTH or int(video.get("height") or 0) > MAX_HEIGHT:
        return MediaPlan(PlanKind.REJECT, str(video.get("codec_name") or "unknown"), "unknown", "resolution_limit")
    duration = _duration(probe, streams)
    if duration is None or duration <= 0 or duration > MAX_DURATION_SECONDS:
        return MediaPlan(PlanKind.REJECT, str(video.get("codec_name") or "unknown"), "unknown", "duration_limit")

    video_compatible = video.get("codec_name") == "h264" and video.get("pix_fmt") in H264_PIXEL_FORMATS
    audio_compatible = all(stream.get("codec_name") == "aac" for stream in audios)
    format_names = set(str(probe.get("format", {}).get("format_name") or "").split(","))
    mp4_input = bool(format_names & {"mov", "mp4", "m4a", "3gp", "3g2", "mj2"})
    video_codec = "copy" if video_compatible else "libx264"
    audio_codec = "copy" if audio_compatible else "aac"
    if mp4_input and video_compatible and audio_compatible:
        return MediaPlan(PlanKind.PASS_THROUGH, video_codec, audio_codec, "already_compatible_mp4")
    if video_compatible and audio_compatible:
        return MediaPlan(PlanKind.REMUX, video_codec, audio_codec, "compatible_streams")
    if video_compatible != audio_compatible:
        return MediaPlan(PlanKind.PARTIAL_TRANSCODE, video_codec, audio_codec, "one_incompatible_stream_type")
    return MediaPlan(PlanKind.FULL_TRANSCODE, video_codec, audio_codec, "incompatible_video_and_audio")


def normalize_video(path: Path, requested_name: str, max_bytes: int, timeout_seconds: int, deadline=None, reserve_seconds: float = 0, source_probe: dict | None = None) -> tuple[Path, str, str, MediaPlan, dict]:
    source_probe = source_probe or probe_file(path, deadline, reserve_seconds)
    plan = plan_mp4(source_probe)
    if plan.kind == PlanKind.REJECT:
        raise UnsafeFile(plan.reason)
    enforce_video_transcode_budget(source_probe, plan)
    if plan.kind == PlanKind.PASS_THROUGH and not _has_faststart(path, deadline, reserve_seconds):
        plan = MediaPlan(PlanKind.REMUX, "copy", "copy", "compatible_mp4_requires_faststart")
    output_name = f"{Path(safe_filename(requested_name)).stem or 'download'}.mp4"
    if plan.kind == PlanKind.PASS_THROUGH:
        _validate_output(source_probe, source_probe, path, max_bytes, deadline, reserve_seconds)
        return path, output_name, "video/mp4", plan, source_probe

    output = path.parent / "output.mp4"
    playable_video = next(stream for stream in source_probe.get("streams", []) if _is_playable_video_stream(stream))
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file,pipe", "-i", str(path),
        "-map", f"0:{int(playable_video.get('index') or 0)}", "-map", "0:a?", "-sn", "-dn",
        "-map_metadata", "0", "-map_chapters", "0",
        "-c:v", plan.video_codec,
    ]
    if plan.video_codec != "copy":
        command += ["-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    command += ["-c:a", plan.audio_codec]
    if plan.audio_codec != "copy":
        command += ["-b:a", "192k"]
    command += ["-movflags", "+faststart", "-max_muxing_queue_size", "1024", str(output)]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True,
            timeout=_phase_timeout(deadline, timeout_seconds, reserve_seconds), check=False,
            preexec_fn=(lambda: _limits(max_bytes)) if resource is not None else None, env=_clean_environment(),
        )
    except subprocess.TimeoutExpired as error:
        if deadline is not None:
            try:
                deadline.ensure(reserve_seconds=reserve_seconds)
            except TimeoutError:
                raise
        raise UnsafeFile("normalization_timeout") from error
    if result.returncode != 0 or not output.exists():
        raise UnsafeFile("normalization_failed")
    output_probe = probe_file(output, deadline, reserve_seconds)
    _validate_output(source_probe, output_probe, output, max_bytes, deadline, reserve_seconds)
    return output, output_name, "video/mp4", plan, output_probe


def enforce_video_transcode_budget(probe: dict, plan: MediaPlan, budget_seconds: float = VIDEO_TRANSCODE_BUDGET_EQUIVALENT_1080P30_SECONDS) -> float:
    """Reject only plans that must re-encode video and exceed the measured budget."""
    if plan.video_codec == "copy":
        return 0.0
    streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
    video = next((stream for stream in streams if _is_playable_video_stream(stream)), None)
    duration = _duration(probe, streams)
    if video is None or duration is None or duration <= 0:
        raise UnsafeFile("video_transcode_budget_unknown")
    width = max(320.0, _positive_number(video.get("width"), 1920.0))
    height = max(240.0, _positive_number(video.get("height"), 1080.0))
    fps = max(1.0, _frame_rate(video))
    equivalent = duration * ((width * height * fps) / (1920.0 * 1080.0 * 30.0))
    if equivalent > max(30.0, float(budget_seconds)):
        raise UnsafeFile("video_transcode_budget")
    return equivalent


def _validate_output(source: dict, output: dict, path: Path, max_bytes: int, deadline=None, reserve_seconds: float = 0) -> None:
    if path.stat().st_size <= 0 or path.stat().st_size > max_bytes:
        raise UnsafeFile("normalized_size_limit")
    streams = output.get("streams", [])
    videos = [stream for stream in streams if _is_playable_video_stream(stream)]
    if len(videos) != 1 or videos[0].get("codec_name") != "h264" or videos[0].get("pix_fmt") not in H264_PIXEL_FORMATS:
        raise UnsafeFile("normalized_video_incompatible")
    if any(stream.get("codec_name") != "aac" for stream in streams if stream.get("codec_type") == "audio"):
        raise UnsafeFile("normalized_audio_incompatible")
    formats = set(str(output.get("format", {}).get("format_name") or "").split(","))
    if not formats.intersection({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}):
        raise UnsafeFile("normalized_container_invalid")
    if not _has_faststart(path, deadline, reserve_seconds):
        raise UnsafeFile("normalized_faststart_missing")
    source_duration = _duration(source, source.get("streams", []))
    output_duration = _duration(output, streams)
    if source_duration and output_duration and abs(source_duration - output_duration) > max(2.0, source_duration * 0.02):
        raise UnsafeFile("normalized_duration_mismatch")


def _duration(probe: dict, streams: list[dict]) -> float | None:
    values = [probe.get("format", {}).get("duration"), *(stream.get("duration") for stream in streams)]
    for value in values:
        try:
            number = float(value)
            if number > 0:
                return number
        except (TypeError, ValueError):
            continue
    return None


def _frame_rate(video: dict) -> float:
    value = str(video.get("r_frame_rate") or "")
    try:
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            number = float(numerator) / float(denominator)
        else:
            number = float(value)
        if number > 0:
            return number
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return 30.0


def _positive_number(value, fallback: float) -> float:
    try:
        number = float(value)
        return number if number > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _has_faststart(path: Path, deadline=None, reserve_seconds: float = 0) -> bool:
    try:
        file_size = path.stat().st_size
        offset = 0
        moov_offset = None
        mdat_offset = None
        with path.open("rb") as source:
            while offset + 8 <= file_size and offset < 64 * 1024 * 1024:
                if deadline is not None:
                    deadline.ensure(reserve_seconds=reserve_seconds)
                source.seek(offset)
                header = source.read(16)
                if len(header) < 8:
                    break
                size = int.from_bytes(header[:4], "big")
                atom = header[4:8]
                header_size = 8
                if size == 1:
                    if len(header) < 16:
                        return False
                    size = int.from_bytes(header[8:16], "big")
                    header_size = 16
                elif size == 0:
                    size = file_size - offset
                if size < header_size or offset + size > file_size:
                    return False
                if atom == b"moov" and moov_offset is None:
                    moov_offset = offset
                elif atom == b"mdat" and mdat_offset is None:
                    mdat_offset = offset
                if moov_offset is not None and mdat_offset is not None:
                    return moov_offset < mdat_offset
                offset += size
    except OSError:
        return False
    return False


def _limits(max_bytes: int) -> None:
    if resource is None:
        return
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_bytes, max_bytes))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def _clean_environment() -> dict:
    return {key: value for key, value in os.environ.items() if key not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}}


def _phase_timeout(deadline, maximum_seconds: float, reserve_seconds: float = 0) -> float:
    if deadline is None:
        return float(maximum_seconds)
    return deadline.timeout(maximum_seconds=maximum_seconds, reserve_seconds=reserve_seconds)
