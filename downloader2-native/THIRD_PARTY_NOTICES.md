# Third-party tools

Downloader 2 does not commit or download external media binaries automatically. Place approved binaries in the published Host's `tools/` directory.

- FFmpeg / ffprobe: version 8.x is the tested family. FFmpeg is licensed under LGPL/GPL depending on the build; preserve the notices supplied by the binary distributor.
- N_m3u8DL-RE: tested CLI contract `N_m3u8DL-RE <input> [options]`, release family `0.6.0-beta`; MIT License. Downloader 2 never supplies DRM keys or decryption options.
- yt-dlp: fallback only; pin a reviewed release and verify its published SHA-256 before local placement. Unlicense.

The Companion executes binaries directly with argument arrays (never through a shell), detects versions with `--version`, and reports missing tools without downloading them.
