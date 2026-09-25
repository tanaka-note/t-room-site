# App-local tools

Do not commit binaries here. For local use, copy reviewed Windows executables next to the published Host under `tools/`:

- `ffprobe.exe` (and `ffmpeg.exe` for external stream muxing)
- `N_m3u8DL-RE.exe`
- `yt-dlp.exe`

Pin the chosen release outside Git and verify the distributor's SHA-256 before copying it. Run the Web UI's tool-status check or send the Native Messaging `tools.status` command to see detected versions. Missing `ffprobe` falls back to basic container-signature validation with a visible warning. Missing Defender also warns without rejecting an otherwise valid download.
