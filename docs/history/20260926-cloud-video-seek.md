# T-Cloud static video seek investigation (2026-09-26)

Base: origin/main `5b7a298ba64464a4b87946c2f8fdd898da32d69e`, including PR #22
(`50476fc`, native-first format fallback) and `c58ac7a` (WebM tail warmup).

## Root cause and routing

mpegts.js 1.8.0's TS demuxer initializes duration to zero and supplies no
keyframe index. The transmuxing controller returns from an unbuffered seek
when `MediaInfo.isSeekable()` is false. `accurateSeek` and `seekType: range`
do not create an index. A real, throttled 20-second AVC/AAC TS in Chromium
reproduced `duration=Infinity`, `hasKeyframesIndex=null`, and a seek to 15s
remaining `seeking=true` with zero `seeked` events.

References: [TS demuxer](https://github.com/xqq/mpegts.js/blob/v1.8.0/src/demux/ts-demuxer.ts),
[seek controller](https://github.com/xqq/mpegts.js/blob/v1.8.0/src/core/transmuxing-controller.js).

| Actual container | Existing first route | Proposed route |
| --- | --- | --- |
| MP4 / QuickTime / WebM | native video | unchanged |
| TS / M2TS | mpegts.js MSE | bounded local AVC/AAC fMP4 remux; other codecs retain mpegts.js |
| FLV, with/without metadata index | mpegts.js MSE | bounded local AVC/AAC fMP4 remux; other codecs retain mpegts.js |
| ASF / AVI / Matroska | native, then download if unsupported | unchanged |

`.mp4` containing TS first tries native, sniffs at most 16KiB through the
device-local Service Worker on failure, then follows TS playback. `.ts`
containing MP4 first tries the transport path and returns to native after
detecting MP4. Detection, encryption, keys and the SW registration remain intact.

## Implementation and limits

The proposed TS/FLV adapter reuses the existing LibAV worker/device-reader pattern,
adds upstream MPEG-TS and FLV demuxers (three unmodified assets each, about
866KiB and 777KiB), and uses the unmodified MP4 generator from mpegts.js 1.8.0. It does
not patch mpegts.js or encode/decode video. AVC Annex-B and AAC ADTS packets
become fMP4 fragments consumed by the existing video element and controls.
FFmpeg timestamp seeking reads closed ranges from `/cloud/local-media/`.

Input cache: four 1MiB blocks. Read budgets: 24MiB initialization, 16MiB per
pull. Packet output budget: 512KiB per pull (plus the final packet). MSE has
15s forward demand, 30s backward retention and a conservative 64MiB compressed
fragment cap. File duration is bounded to 12h to keep the reused v0 MP4 clock
fields representable. Seeks terminate the previous worker and its fetches;
generation checks reject stale results. Preview close/session cleanup uses
the existing player destruction path. No plaintext file/Blob is accumulated
or persisted; keys never enter the remux worker or leave the decrypting SW.

Supported remux combination: H.264 with optional AAC-LC audio (ADTS in TS,
raw packets/ASC in FLV). Unknown
private streams, other codecs, negative composition offsets, unsupported
time bases and missing duration/configuration retain the old transport path
before initialization. Errors after initialization stop playback safely and
offer download. Do not claim arbitrary seeking for legacy fallbacks.
Very large GOPs or malformed files may exceed bounded read budgets and fail.

## Verification and publication gate

`media-seek.browser.mjs` generates legal synthetic 90s audiovisual fixtures
with FFmpeg at test time; no new video binaries are committed. It covers
MP4/WebM/MOV/TS/M2TS/indexed and unindexed FLV, both mismatched extensions, normal desktop and
shared touch UI, 25%/75%/backward/rapid/EOF seeks, real seeking/seeked/timeupdate
events, playback advancement, pause/play, volume/speed, decoded audio and worker
cleanup. TS's forward target must lie beyond the initial MSE buffer. Remote
and direct API source rejection is tested for both worker and adapter.

Existing 200MiB Range/prefetch tests cover open/closed/EOF ranges, demand priority,
retry, bounded plaintext cache, owner/session isolation, cancellation/release,
and encrypted-only offline storage. They passed unchanged. Cloud standard
Node tests and `test:media` passed. Chromium's real normal/shared media seeks,
player parity and 200MiB native/SW browser tests passed during development.

Windows Playwright WebKit: native MP4 real seek passed, generated WebM stalled
with `readyState=0`/`duration=NaN`; MediaSource is unavailable on this port.
This is not a successful WebKit remux verification. CI runs the new real seek
test in both Chromium and Linux WebKit, installs FFmpeg for fixtures, and does
not skip unavailable codec cases. Publication requires all selected CI checks
and the full real seek matrix to pass; no production release is approved by
these partial results alone. The first CI run failed because Playwright's
standard Linux Chromium lacks H.264/AAC; the Cloud job now installs/uses Chrome
and includes the GStreamer LibAV plugin for WebKit rather than skipping media.

A final rerun also exposed a legacy FLV resume stall after repeated seeks.
FLV was therefore moved to the same bounded remux path; both indexed and
unindexed fixtures passed normal/shared real seek and audio checks locally.

WMV work must wait for that gate. Existing ASF modules are thumbnail demuxers
plus WMV1/2/3 video decoders, without the WMA/WMA Pro audio decoder/encoder
pipeline required for audiovisual playback. No WMV playback codec was added,
and no video-only or non-seekable implementation is claimed as support.
