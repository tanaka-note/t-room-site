# Downloader Container third-party components

The image is built from Debian Bookworm packages and pinned application tools.

- FFmpeg is installed from Debian's `ffmpeg` package. Debian enables GPL components including `libx264`; it is not an `--enable-nonfree` build. The source/package copyright and corresponding source links are published by Debian.
- Chromium is installed from Debian's `chromium` package and is used only as the final metadata-analysis fallback.
- ClamAV is installed from Debian and its signatures are updated while building the image. A missing or failed scanner is treated as rejection, never as a clean result.
- yt-dlp is pinned to `2026.8.19` and Deno to `2.9.5`. Updates require the resolver and security test suites before deployment.

No codec library is fetched from an unreviewed binary bundle, and no component is built with a nonfree FFmpeg configuration.
