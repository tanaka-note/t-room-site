# Third-party components (local prototype)

The app invokes separate executables. They are downloaded locally by Prepare-Tools.ps1; binaries are not committed to this repository. The manifest pins official release URLs and SHA-256 checksums. No third-party download sites or runtime plugin downloads are used.

- yt-dlp nightly 2026.10.10.233141: https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/tag/2026.10.10.233141
  - Project source: Unlicense. The official Windows executable bundles other components and is GPLv3+ as a combined work, per https://github.com/yt-dlp/yt-dlp#licensing .
  - Corresponding source revision: https://github.com/yt-dlp/yt-dlp/tree/897341241f2bfb2439fe0367f4c7c9ccd29a3828 and its THIRD_PARTY_LICENSES.txt. Dependencies have additional terms.
- FFmpeg N-127588-g0b19c65afe (GPL shared build): https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/autobuild-2026-10-16-18-04
  - FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/tree/0b19c65afe
  - Build recipes and dependency sources: https://github.com/yt-dlp/FFmpeg-Builds . License files included by the archive are copied into tools/licenses.
  - This build enables GPL components. See https://ffmpeg.org/legal.html .
- .NET / WPF: https://github.com/dotnet/runtime and https://github.com/dotnet/wpf (MIT and third-party notices).
- Microsoft.Web.WebView2 SDK 1.0.4258.31: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31 . The SDK/native loader and the separately installed Evergreen Runtime have Microsoft license terms; consult the package license and https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution before redistribution.
- System.Security.Cryptography.ProtectedData 10.0.13: https://www.nuget.org/packages/System.Security.Cryptography.ProtectedData/10.0.13 (MIT; Windows CurrentUser DPAPI).

This output is for local prototyping. Before distributing an executable package to others, prepare the complete corresponding source, dependency/build information, license texts and notices required by the exact shipped binaries. This notice alone does not fulfill all redistribution obligations. App code and helper executables are separate processes; that does not waive the helpers' redistribution requirements.
