rule TLAIN_YARA_SAFE_TEST_MARKER {
  meta:
    description = "Safe marker used to verify the independent YARA gate"
    author = "T-lain"
    version = "1"
  strings:
    $marker = "TLAIN-YARA-SAFE-TEST-MARKER-8F32C9A1" ascii fullword
  condition:
    $marker
}

rule TLAIN_MEDIA_EMBEDDED_PE_PAYLOAD {
  meta:
    description = "Media-looking file containing a likely embedded PE payload near its start"
    author = "T-lain"
    version = "1"
  strings:
    $media_mp4 = "ftyp" ascii
    $media_ogg = "OggS" ascii
    $media_riff = "RIFF" ascii
    $media_matroska = { 1A 45 DF A3 }
    $mz = "MZ" ascii
    $dos = "This program cannot be run in DOS mode" ascii
  condition:
    filesize < 64MB and
    ( $media_mp4 in (4..32) or $media_ogg at 0 or $media_riff at 0 or $media_matroska at 0 ) and
    $mz in (8..1048576) and $dos in (8..4194304)
}

rule TLAIN_MEDIA_EMBEDDED_SCRIPT_PAYLOAD {
  meta:
    description = "Media-looking file containing a high-confidence embedded command payload"
    author = "T-lain"
    version = "1"
  strings:
    $media_mp4 = "ftyp" ascii
    $media_ogg = "OggS" ascii
    $media_riff = "RIFF" ascii
    $media_matroska = { 1A 45 DF A3 }
    $shell = "#!/bin/sh" ascii
    $powershell = "powershell -EncodedCommand" ascii nocase
    $download = "curl -fsSL" ascii nocase
    $execute = "chmod +x" ascii nocase
  condition:
    filesize < 64MB and
    ( $media_mp4 in (4..32) or $media_ogg at 0 or $media_riff at 0 or $media_matroska at 0 ) and
    2 of ($shell, $powershell, $download, $execute)
}
