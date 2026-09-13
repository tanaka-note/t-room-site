# libav.js 6.7.7.1.1 modular thumbnail decoders

Unmodified ESM/WebAssembly files from the upstream release:
https://github.com/Yahweasel/libav.js/releases/tag/v6.7.7.1.1

Included modules: ASF/MP4 demuxers and MPEG-4 Visual/WMV1/WMV2/WMV3 decoders.
Only the required module is loaded, inside a dedicated browser worker, after
native thumbnail decoding fails. No media or keys are sent to a third party.

The JavaScript wrapper uses the ISC license. FFmpeg uses LGPL-2.1-or-later for
these modules. The corresponding unmodified source archives, build scripts,
patches, dependency sources and license texts are supplied in `sources/`.
Unused audio/video codec modules and threaded/asm.js builds are not distributed.

Source: https://github.com/Yahweasel/libav.js
