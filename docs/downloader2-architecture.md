# Downloader 2 architecture

Downloader 2 is a separate owner-only service. Downloader 1 remains the Cloudflare/Container/R2 product at `/downloader/`; none of its Worker, Queue, Container, R2, D1, URL, or migrations are reused by Downloader 2.

## Data boundary

```text
/downloader2/ UI (Passkey owner session)
  -> content script (only https://tanaka-note.com/downloader2/*)
  -> Manifest V3 service worker
     -> webRequest capture, or explicit tab-scoped CDP capture
  -> Chrome/Edge Native Messaging
  -> Windows Companion (.NET 10)
  -> source media origin
  -> %USERPROFILE%\Downloads
```

The Downloader 2 Worker has only static assets and a Security service binding. It has no R2, D1, Queue, Container, Durable Object, media proxy, ffmpeg, or scanner binding. Media bytes and request context never enter Cloudflare. The Worker only establishes an owner Passkey session and signs a 120-second pairing token bound to the Companion's one-time device challenge.

Request headers required by playback may contain Cookie or Authorization. The extension keeps them in service-worker memory and passes them directly to the Native Host for the selected candidate. It never writes them to extension storage, console, the Worker, history, or files. The Companion applies Cookie and Authorization only to the credential origin; a cross-origin redirect drops both. Local history stores title, hostname, filename, size, resolution, duration, engine, result, elapsed time, and completion time—never a full URL, query, headers, or tokens.

## Capture

Normal capture correlates `webRequest.onBeforeRequest`, `onBeforeSendHeaders`, and `onHeadersReceived`. Classification combines URL suffix, response Content-Type, resource type, status, and explicit DRM markers. HLS/DASH manifests and direct media rank above segments; ordinary `.m4s`, `.ts`, and `.aac` requests are suppressed to avoid candidate storms. Extensionless URLs remain detectable by Content-Type.

Deep Capture is optional `debugger` permission. It attaches only to the opened capture tab, enables CDP Network events, and detaches when capture stops or the tab closes. It uses the same classifier and in-memory request-context path as normal capture.

## Native protocol and pairing

Native Messaging frames are 4-byte little-endian length plus JSON, capped at 1 MiB and depth 16. Every request requires `version: 1`, a bounded `type`, a bounded `requestId`, and a typed payload. The install script registers `com.tlain.downloader2` in HKCU for Chrome and Edge and writes only caller-supplied extension IDs to `allowed_origins`.

Before pairing, the Host creates a random 120-second challenge in memory. The authenticated Web session asks the Worker to sign a token bound to that exact challenge. The Host sends only the signed token and challenge to the Worker's public verification endpoint, consumes the local challenge after successful verification, then creates a 32-byte device credential in Windows Credential Manager. This request contains no video URL or browser credential. The device key is never returned to the extension. Passkey cookies, WebAuthn material, Worker secrets, and session secrets are not copied to the Companion.

## Engines

1. `direct`: probes with `Range: bytes=0-0`, selects 4/8/16 connections by size, validates every `Content-Range`, and falls back to a retried single stream on any parallel failure.
2. `hls-built-in`: highest-bandwidth master variant plus clear VOD segments. It deliberately refuses encrypted HLS requiring an external engine, but does not label AES-128 `identity` encryption as DRM.
3. `N_m3u8DL-RE`: HLS/DASH adapter when an app-local binary is present. Arguments match the official `N_m3u8DL-RE <input> [options]` help; no key/decryption flags are supplied. Because its global header option cannot enforce a per-redirect origin boundary, Cookie and Authorization are withheld; the built-in HLS engine remains the credential-aware path.
4. `yt-dlp`: fallback for direct/generic media when locally installed. It does not read browser cookie stores. Cookie and Authorization are withheld because the subprocess redirect policy cannot be proven equivalent to the built-in origin boundary.

External binaries are not committed or downloaded automatically. See `downloader2-native/tools/README.md` and `THIRD_PARTY_NOTICES.md`.

## Completion and safety

All engines write under a per-job temporary directory and use `.tlain.part` for the built-in paths. External-engine output stays in that temporary directory. The Companion then runs ffprobe when available (otherwise bounded signature validation with a warning), invokes Microsoft Defender CustomScan when available, and only then moves the file atomically to a unique name in Downloads. Explicit Defender detections produce `malware_detected`; an unavailable Defender produces a warning and does not turn a valid download into failure. Explicit Widevine/PlayReady identifiers produce `drm_not_supported`; no CDM, license key, DRM key, or decryption implementation exists.

## Local development

1. Install Node 24, pnpm 11, and .NET 10 SDK.
2. Install Worker dependencies with the repository-standard `pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false`.
3. Build/publish the Host: `dotnet publish downloader2-native/src/Tlain.Downloader2.Host/Tlain.Downloader2.Host.csproj -c Release`.
4. Load `downloader2-extension/` unpacked in Chrome or Edge and copy its extension ID.
5. Run `downloader2-native/scripts/Install-NativeHost.ps1` with that ID.
6. Run the local Worker for UI/API checks and the fixture server for capture/download checks. The shipped content script intentionally accepts only `https://tanaka-note.com/downloader2/*`; therefore the complete page-to-extension browser path is verified only after an explicitly approved deployment. No localhost origin is added as a production bypass.

Tests generate the 100 MiB range stream on demand. The fixture page also creates a short WebM with Canvas and MediaRecorder, uploads it only to the loopback fixture process, and plays it back over an HTTP Range response so browser capture can observe genuinely playable media without committing a binary fixture. The server also covers direct, range/no-range, HLS master/variant, DASH, extensionless Content-Type detection, header-required 403, signed query, same/cross-origin redirect, 403, 429, timeout, separate audio/video, multiple candidates, and explicit DRM.
