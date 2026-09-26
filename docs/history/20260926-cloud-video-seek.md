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

The earlier Windows Playwright WebKit probe advanced the MP4 clock, but did
not establish moving decoded frames/audio. Generated WebM stalled with
`readyState=0`/`duration=NaN`; MediaSource is unavailable on this port.
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

The updated CI's Cloud syntax/Node/Chromium/browser/dry-run build stage passed.
Its WebKit stage remained running without a result, so the seek test now rejects
a play promise that does not resume within 10s and CI bounds each WebKit command
to 5 minutes. WebKit audio verification additionally observes nonzero PCM via
Web Audio instead of claiming audio from the unavailable Chromium byte counter.
Windows WebKit also lacks AudioContext; this is an explicit failure, not a skip.

WMV work must wait for that gate. Existing ASF modules are thumbnail demuxers
plus WMV1/2/3 video decoders, without the WMA/WMA Pro audio decoder/encoder
pipeline required for audiovisual playback. No WMV playback codec was added,
and no video-only or non-seekable implementation is claimed as support.

## Linux WebKit CI investigation

The original failure in run 36222385860 occurs on native MP4, before the
TS/FLV remux cases. A bare video control uses the same generated MP4, the same
throttled HTTP Range server and the same seek/resume assertions, without
T-Cloud JavaScript, a Service Worker, encryption or remux workers.

Runs 36223515734 through 36224765685 reproduce failures in both Playwright's
headless WPE and Xvfb/headed GTK ports. Installing a PulseAudio null sink removes
missing audio-device errors; installing gstreamer1.0-gl removes the missing
OpenGL-plugin warning. Neither alone resolves the play-promise failure.

Reading every media property on every early event additionally changes this
build's initialization: duration becomes zero. The observer therefore records
event names/timestamps, and reads the complete requested state at seek
checkpoints and failure. Full per-event snapshots remain an explicit diagnostic
option (--event-state), rather than perturbing the default regression test.

In run 36224765685, the native MP4 reaches 67.5s, fires seeking/seeked/timeupdate,
and has buffered/seekable data through 90s. Its play() promise remains pending
for 10s, without rejection or media error. paused is false and readyState is 2.
The clock reaches about 77.5s; requestVideoFrameCallback reports advancing
mediaTime up to 77.466s with increasing presentedFrames. Thus decoded video is
playing while the promise remains unresolved. The app and bare control agree.
The test still fails: no promise assertion or timeout was weakened.

WebKit's GStreamer source selects legacy playbin for native HTTP media, while
MSE already uses playbin3. WEBKIT_GST_USE_PLAYBIN3=1 is the upstream-supported
switch for both WPE and GTK. Run 36225309082 confirms that this switch takes effect (the engine logs
legacy=false), but it still fails on native MP4. playbin3 alone is not a fix.
Run 36225693382 confirms WPE disk buffering is disabled, but the same pending
promise persists. GTK metadata preload also fails; prepareToPlay enables disk
buffering again. Neither experiment justifies a production code change.
Run 36226055807 compares pinned Playwright 1.56.1 with isolated 1.63.0
(WebKit 26.6). Both WPE and GTK retain the same pending promise. No shared
Playwright dependency upgrade was adopted.
Run 36226458228 also reproduces this with the audio track removed. Native
video-only still advances frames while the promise remains pending; AAC alone
cannot explain it. Debug logs show pause returning ASYNC, then another seek
about 5ms later and a transition HaveEnoughData -> HaveCurrentData that never
recovers despite a PLAYING pipeline and complete buffered data.
The first macOS control did not reach playback: Homebrew ffmpeg lacked libvorbis.
The next comparison uses ffmpeg-full, checks settled pause and tests the TS
remux independently. Results remain pending; no merge/deploy is approved.

Sources: [Playwright port selection](https://raw.githubusercontent.com/microsoft/playwright/v1.56.1/browser_patches/webkit/pw_run.sh),
[WebKit GStreamer pipeline selection](https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.50.1/Source/WebCore/platform/graphics/gstreamer/MediaPlayerPrivateGStreamer.cpp).

Run 36226849599's settled-pause control also fails on native MP4. macOS WebKit
passes the bare MP4 control and the app MP4 seek/audio test. Its WebM and MSE
seeks/frames pass but Web Audio PCM reads zero at both rate 1 and 1.5, despite
an enabled audio track and a running AudioContext. The AVFoundation MSE class
inherits the interface's null audioSourceProvider; that observer cannot prove
whether the default native output is audible. Actual output must be measured.
A macOS Playwright 1.63.0 WebM probe remained stuck without a result and was
cancelled when the next comparison was pushed; it is not counted as a pass.

Run 36227955845 independently passes Linux WebKit TS remux in normal and shared
touch views, including all real seeks, changing frames, PCM audio and cleanup.
GStreamer quantizes fractional volume values; the control test instead verifies
both volume 0 and 1 with strict equality and keeps the exact rate 1.5 assertion.
No production control code was changed for this backend rounding.

The macOS output observer uses an explicitly named BlackHole 2ch device on the
disposable CI runner only. Raw float PCM is bounded to 256KiB in RAM and never
saved. It requires a silent pre-play control, advancing unmuted video playback,
nonzero RMS and the synthetic 440Hz tone. FFmpeg collection is based on actual
44100-sample frames, with padding disabled, rather than AVFoundation timestamps.
The detector was tested with FFmpeg-generated 48kHz sine/silence resampled to
44.1kHz: exactly one second, 440Hz, RMS 0.08837 versus zero for silence. This
validates the detector only; browser output results remain pending.

The next run also completes the native-pipeline combination comparison:
playbin3 plus disabled WPE disk cache, rather than either switch alone.

Run 36228399160 failed both combination controls, including the full app test.
Its macOS native output contains real nonzero PCM, but a zero-crossing tone
estimate varied from 458 to 1044Hz. A whole-second coherent spectrum instead
found approximately 440Hz but undercounted the tone energy. Neither observer
failure is treated as a browser pass. The output detector now averages short
overlapping Hann-window spectra; frequency tolerance, minimum tone energy,
silent control, actual advancing video and original play promise remain required.
Local generated controls cover silence, phase-discontinuous 440Hz, 660Hz and
deterministic broadband noise. 440Hz is identified within 2Hz with tone fraction
0.21; the noise fraction is 0.0003 and cannot satisfy the tone assertion.
These are detector controls, not evidence of successful browser audio yet.

The immediate-response A/B preserves the exact generated video and 206/Range
headers while removing only the server's artificial 64KiB/10ms pacing from
native files. Remux input remains paced, including the assertion that 75% lies
beyond the initial buffered region. This is a diagnostic option, not an adopted
fix or a successful CI result.

Run 36229020718 failed the immediate-response bare and full native controls too.
It again passed Linux WebKit TS seek/audio/cleanup in both UI modes. macOS PCM
had a spectral peak near 440Hz, but the initial short-window observer used a
single-bin energy estimate that was not normalized by Hann-window energy.
That incorrectly failed audible output and was fixed using integer DFT bins,
Parseval normalization and summed 400–480Hz band power. The test now requires
more than half of the measured output energy in that band plus a dominant peak
within 20Hz of 440Hz. Phase-discontinuous generated 440Hz yields 0.974 band
fraction; 550Hz, 660Hz and deterministic noise each yield below 0.004.
The macOS full-matrix command allows 10 minutes for 18 cases with two real
one-second audio captures per case. Per-seek 25s and per-play/frame 10s bounds
remain unchanged; no Linux failing seek deadline was extended.

Run 36229413018 passes macOS native MP4 seek/frames/output and normal-rate WebM
seek/frames/output in normal and shared UI. At 1.5x, audible PCM is nonzero but
the pitch-preserved spectrum can peak near 420Hz; applying an exact original
440Hz-content assertion at that rate is an invalid observer assumption.
The final observer keeps the original actual-PCM/advancing-playback assertion
at the tested 1.5x speed and adds a separate actual-output capture at 1x for
the synthetic tone/majority-energy assertion, then restores the original rate.
The full normal/shared nine-format regression remains required and pending.

Run 36230071616's independent calibration fails: FFplay's known 440Hz source
is measured near 420Hz too. That counterexample invalidates attribution of the
recorded spectrum differences to WebKit. Prior macOS spectrum failures must
not be reported as proved application or browser audio defects, and partial
audio passes from the uncalibrated path do not satisfy the publication gate.
The CoreAudio comparison reads the named virtual device's actual input stream
format and first channel directly through a bounded HAL callback. It records
exactly one second using the reported 44.1/48kHz sample rate, with at most 192KiB
of PCM, and no resampling or timestamp conversion. The same independent
producer calibration and original audio/tone assertions remain mandatory.
Generated 44.1/48kHz tone controls pass the sample-rate-aware detector locally;
the native capture still requires a successful CI calibration and full matrix.

Run 36230568399 builds the HAL recorder and captures MP4/TS near 440Hz with
0.999 tone energy fraction, versus the AVFoundation path's roughly 0.7 and
incorrect frequency. TS passes both UI modes; normal-rate WebM passes both too.
The independent calibration captures silence in its first second, before the
known producer's output has been established. The observer now waits for actual
nonzero PCM within the existing 10s audio deadline, matching the original
Web Audio test; capture errors and incorrect tone content are never retried.
This is not yet a successful calibration or complete matrix result.

Run 36231039237 passes the independent HAL calibration: known 440Hz output,
RMS 0.08786, 0.99982 tone band fraction. Run 36231540537 repeats calibration
success and checks audio/tone directly at the original tested 1.5x rate. The
invalid AVFoundation recorder and compensating 1x rate mutation are retired.
The full-matrix command is again bounded to its original five minutes, with
a ten-second hard-kill grace for a hung comparison process. Seek/play/frame
and real-PCM deadlines remain unchanged.

## Separate remux rapid-seek race found by calibrated macOS tests

Those runs pass native MP4/WebM/MOV and TS/M2TS actual seeks/output, then expose
a real FLV adapter race. At final target 45.0115s, play resolves but frames/time
stop; the buffer becomes 52.013–65.999s. The earlier uncovered seek to 54s left
a debounced open queued. A subsequent covered seek to 45s returned before
cancelling that timer, so the obsolete reader opened at 54s and replaced the
buffer with its 52s preroll. WebKit can also coalesce seeking events, leaving
the timer's captured time obsolete even without a final event.

The adapter now cancels obsolete work immediately, reads the latest currentTime
when the debounce expires, and checks the generation inside SourceBuffer
operations after waiting for updateend. A stale ready handler therefore cannot
erase a newer usable range. Stale transferred fragments are cleared, and unload
cancels pending seek timers. Native playback and the encrypted Range path are
unchanged; SW/runtime diffs contain the synchronized build marker only.

The deterministic race test fails the previous source with `54 !== 45` and
passes the fixed source for normal/coalesced seeking and a superseded queued
SourceBuffer removal. It is registered in Cloud verify and test:media. Fixed
source local validation passes the full Chromium 18-case real seek/frame/audio/
cleanup matrix, Cloud syntax/Node/security/200MiB Range/dry-run profile, 12
development-flow tooling tests and Cloud build freshness (`cloud-d9ba0bfb7197`).
Calibrated macOS regression of this fix remains pending; Linux native MP4
remains a distinct unresolved browser-backend failure and blocks publication.

Run 36232142327 confirms that the fixed adapter passes indexed and unindexed
FLV actual seeks, changing frames, calibrated output and cleanup on macOS.
The next failure is the disguised TS-extension/MP4 case: play resolves and
time advances, but videoWidth/videoHeight stay zero and no frames appear.
The fixture's updateMediaFormat stub acknowledged success without changing
its synthetic transport's Content-Type from video/mp2t to video/mp4. Production
already updates the owner-checked Service Worker descriptor before restarting
native playback. The fixture now mirrors that acknowledgement and response
change only when the real application's sniff/fallback requests it; assertions
require exactly one update, the canonical detected format and a restarted
request with the corrected MIME. Neither production MIME/owner checks nor
seek/frame assertions are changed. macOS confirmation of this fixture correction
is pending.

The adapter also reconciles a settled seek when WebKit coalesces a later
seeking notification after an obsolete reader has already opened. A reader
opening the current target is retained while its track buffers are filling.
Two deterministic controls cover both cases; native playback stays unchanged.
Local Cloud syntax/Node/security/200MiB Range/dry-run verification and the
18-case Chromium matrix pass for this adapter follow-up (cloud-bb654832ec3f).
