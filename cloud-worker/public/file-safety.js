(function (global) {
  "use strict";

  const BLOCKED_EXTENSIONS = new Set([
    "exe", "dll", "sys", "msi", "msp", "com", "scr", "cpl", "lnk",
    "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
    "reg", "hta", "jar", "apk", "app", "dmg", "pkg", "sh"
  ]);
  const ACTIVE_WEB_EXTENSIONS = new Set(["html", "htm", "xhtml", "svg"]);

  function confirmationRequired(message) {
    const error = new Error(message);
    error.code = "SAFETY_CONFIRM_REQUIRED";
    error.requiresConfirmation = true;
    return error;
  }

  async function inspect(file) {
    if (!file || typeof file.name !== "string" || typeof file.slice !== "function") {
      throw new Error("ファイル情報を確認できません。");
    }
    const name = file.name.normalize("NFKC");
    if (/[\u202A-\u202E\u2066-\u2069]/u.test(name)) {
      throw confirmationRequired("ファイル名に表示方向を偽装する文字が含まれています。");
    }
    const extensions = name.toLowerCase().split(".").slice(1).map((value) => value.trim()).filter(Boolean);
    const extension = extensions.at(-1) || "";
    if (BLOCKED_EXTENSIONS.has(extension) || ACTIVE_WEB_EXTENSIONS.has(extension)) {
      throw confirmationRequired("安全上、このファイル形式は保存できません。");
    }

    const header = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    try {
      if (isExecutable(header) || isScript(header)) {
        throw confirmationRequired("実行可能な内容が検出されました。");
      }
      const signature = signatureKind(header);
      if (!matchesExtension(extension, signature, header)) {
        throw confirmationRequired("拡張子とファイル内容が一致しません。元のファイルをご確認ください。");
      }
      return Object.freeze({ status: "passed", inspectedBytes: header.byteLength });
    } finally {
      header.fill(0);
    }
  }

  function isExecutable(bytes) {
    if (starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46])) return true;
    return starts(bytes, [0xfe, 0xed, 0xfa, 0xce])
      || starts(bytes, [0xfe, 0xed, 0xfa, 0xcf])
      || starts(bytes, [0xce, 0xfa, 0xed, 0xfe])
      || starts(bytes, [0xcf, 0xfa, 0xed, 0xfe])
      || starts(bytes, [0xca, 0xfe, 0xba, 0xbe]);
  }

  function isScript(bytes) {
    if (starts(bytes, [0x23, 0x21])) return true;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 1024))).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    return text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<script");
  }

  function signatureKind(bytes) {
    if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
    if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
    if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
    if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
    if (ascii(bytes, 0, 3) === "FLV") return "flv";
    if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
    if (ascii(bytes, 4, 4) === "ftyp") return "isobmff";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return "avi";
    if (ascii(bytes, 0, 4) === "OggS") return "ogg";
    if (ascii(bytes, 0, 4) === "fLaC") return "flac";
    if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "mpeg-audio";
    if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) return "zip";
    if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
    if (ascii(bytes, 0, 7) === "Rar!\u001a\u0007\u0000" || ascii(bytes, 0, 8) === "Rar!\u001a\u0007\u0001\u0000") return "rar";
    if (starts(bytes, [0x1f, 0x8b])) return "gzip";
    if (starts(bytes, [0x00, 0x00, 0x01, 0xba]) || starts(bytes, [0x00, 0x00, 0x01, 0xb3])) return "mpeg-video";
    if (bytes[0] === 0x47 || bytes[188] === 0x47) return "mpeg-ts";
    return "unknown";
  }

  function matchesExtension(extension, signature, bytes) {
    if (!extension || signature === "unknown") return true;
    const expected = {
      jpg: ["jpeg"], jpeg: ["jpeg"], png: ["png"], gif: ["gif"], webp: ["webp"],
      pdf: ["pdf"], flv: ["flv"], webm: ["ebml"], mkv: ["ebml"],
      mp4: ["isobmff"], m4v: ["isobmff"], mov: ["isobmff"], m4a: ["isobmff"],
      heic: ["isobmff"], heif: ["isobmff"], avif: ["isobmff"],
      wav: ["wav"], avi: ["avi"], ogg: ["ogg"], flac: ["flac"], mp3: ["mpeg-audio"],
      zip: ["zip"], docx: ["zip"], xlsx: ["zip"], pptx: ["zip"],
      "7z": ["7z"], rar: ["rar"], gz: ["gzip"], gzip: ["gzip"],
      mpg: ["mpeg-video"], mpeg: ["mpeg-video"], ts: ["mpeg-ts"], mts: ["mpeg-ts"], m2ts: ["mpeg-ts"]
    }[extension];
    if (!expected) return true;
    if (extension === "aac" && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return true;
    return expected.includes(signature);
  }

  function starts(bytes, values) {
    return values.every((value, index) => bytes[index] === value);
  }

  function ascii(bytes, offset, length) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
  }

  global.TCloudSafety = Object.freeze({ inspect });
})(globalThis);
