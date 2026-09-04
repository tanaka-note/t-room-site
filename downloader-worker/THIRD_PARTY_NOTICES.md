# Downloader Container third-party components

The image is built from Debian Bookworm packages and pinned application tools.

- FFmpeg is installed from Debian's `ffmpeg` package. Debian enables GPL components including `libx264`; it is not an `--enable-nonfree` build. The source/package copyright and corresponding source links are published by Debian.
- Chromium is installed from Debian's `chromium` package and is used only as the final metadata-analysis fallback.
- ClamAV 1.4.6 LTS is installed from Cisco Talos' checksum-pinned official Linux package. Its signed `main`, `daily`, and `bytecode` databases are updated while building the image. A missing, stale, or failed scanner is treated as rejection, never as a clean result.
- YARA 4.5.8 is built from the checksum-pinned VirusTotal source release and is licensed under BSD-3-Clause. Rules are compiled into the image and are never fetched at runtime.
- `gen_xored_pe.yar` and `generic_exe2hex_payload.yar` are selected from `Neo23x0/signature-base@278165d7845decece517f756cf92ff4a41938d1e` and are licensed under Detection Rule License 1.1. Author and source attribution remain in each rule file. Generic, experimental, hunting, Office, and web-shell rules are intentionally excluded to keep the media false-positive boundary reviewable.
- yt-dlp is pinned to `2026.8.19` and Deno to `2.9.5`. Updates require the resolver and security test suites before deployment.

No codec library is fetched from an unreviewed binary bundle, and no component is built with a nonfree FFmpeg configuration.
