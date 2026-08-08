(function (global) {
  "use strict";

  function parsePlainRange(value, size) {
    size = Number(size);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (size === 0) return { start: 0, end: -1, partial: Boolean(value) };
    if (!value) return { start: 0, end: size - 1, partial: false };
    const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return null;
    let start;
    let end;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
      end = Math.min(end, size - 1);
    }
    return { start, end, partial: true };
  }

  function encryptedChunkRange(file, index) {
    const size = Number(file.sizeBytes);
    const chunkSize = Number(file.chunkSizeBytes || 8 * 1024 * 1024);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("ファイルの分割情報を確認してください。");
    const chunkCount = Math.ceil(size / chunkSize);
    if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount) throw new Error("分割番号を確認してください。");
    const plainLength = Math.min(chunkSize, size - index * chunkSize);
    const encryptedStride = chunkSize + 32;
    const start = index * encryptedStride;
    return { start, end: start + plainLength + 31, plainLength };
  }

  function plainChunkSlice(index, plainLength, requestedStart, requestedEnd, chunkSize) {
    const plainStart = index * chunkSize;
    return {
      from: Math.max(0, requestedStart - plainStart),
      to: Math.min(plainLength, requestedEnd - plainStart + 1)
    };
  }

  global.TCloudRange = Object.freeze({ parsePlainRange, encryptedChunkRange, plainChunkSlice });
})(globalThis);
