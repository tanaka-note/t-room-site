# Downloader YARA rules

The container compiles these source rules during the image build and never
downloads rules at runtime.

- `tlain_downloader.yar`: narrowly scoped T-lain rules for the scanner health
  fixture and executable/script payloads embedded in media-looking files.
- `gen_xored_pe.yar`: selected unchanged from
  `Neo23x0/signature-base@278165d7845decece517f756cf92ff4a41938d1e`
  (upstream CRLF SHA-256
  `3aab7b946be720d994b517f2cbbbca8831848223bde6895fa78c7f351851b924`;
  vendored LF SHA-256
  `3f72f78730662a2975f5965059d6064e78eaaa990a7bddf3a471b862927c11ea`).
- `generic_exe2hex_payload.yar`: selected unchanged from the same commit
  (upstream CRLF SHA-256
  `e3418d170ed383847d9921376de4412c8a09c1781bbc190b0f0a22a7121e40b7`;
  vendored LF SHA-256
  `fdb4b31835ba5193c1be53fb40aadebfb47218d2e9518eb97298647bb83b4312`).

The selected Signature-Base rules are licensed under Detection Rule License
1.1. The full rule feed is intentionally not bundled: generic, hunting,
experimental, office, web-shell, and platform-specific rules add substantial
media false-positive and maintenance risk without improving this narrow input
boundary.
