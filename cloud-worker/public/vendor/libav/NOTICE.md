# libav.js 6.7.7.1.1 modular thumbnail decoders

Unmodified ESM/WebAssembly files from the upstream release:
https://github.com/Yahweasel/libav.js/releases/tag/v6.7.7.1.1

Included modules: ASF/MP4/MPEG-TS/FLV demuxers and MPEG-4 Visual/WMV1/WMV2/WMV3 decoders.
Thumbnail modules load only after native thumbnail decoding fails. The TS/FLV
demuxers are loaded by a dedicated device-local remux worker for static AVC/AAC
playback and timestamp seeking. No media or keys are sent to a third party.

`../mp4-generator-1.8.0.mjs` is the unmodified MP4 box generator from mpegts.js
v1.8.0 (`src/remux/mp4-generator.js`), covered by the adjacent mpegts Apache-2.0
license. It is used to produce bounded fMP4 fragments without re-encoding.

The JavaScript wrapper uses the ISC license. FFmpeg uses LGPL-2.1-or-later for
these modules. The corresponding unmodified source archives, build scripts,
patches, dependency sources and license texts are supplied in `sources/`.
Unused audio/video codec modules and threaded/asm.js builds are not distributed.

Source: https://github.com/Yahweasel/libav.js
