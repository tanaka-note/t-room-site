export async function preparePhoto(file) {
  if (!(file instanceof File) || !String(file.type).startsWith("image/")) {
    throw new Error("画像ファイルではありません。");
  }
  if (!file.size || file.size > 60 * 1024 * 1024) throw new Error("60MB以内の画像を選択してください。");
  const imageSource = await preparePhotoSource(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(imageSource.source);
  } catch {
    throw new Error("この画像形式をブラウザで読み取れませんでした。");
  }
  try {
    const [displayBlob, thumbnailBlob] = await Promise.all([
      resizePhoto(bitmap, 1800, 320 * 1024, 0.88, imageSource.orientation),
      resizePhoto(bitmap, 480, 100 * 1024, 0.82, imageSource.orientation)
    ]);
    const orientedSize = orientedImageSize(bitmap.width, bitmap.height, imageSource.orientation);
    const id = crypto.randomUUID().toLowerCase();
    return {
      id,
      fileName: file.name || "photo",
      originalFile: file,
      displayBlob,
      thumbnailBlob,
      width: orientedSize.width,
      height: orientedSize.height,
      previewUrl: URL.createObjectURL(thumbnailBlob),
      existing: false,
      uploadState: "preparing",
      uploadPromise: null,
      uploadError: null,
      removed: false
    };
  } finally {
    bitmap.close();
  }
}

async function preparePhotoSource(file) {
  const isJpeg = /^image\/(?:jpeg|jpg)$/i.test(String(file.type || "")) || /\.jpe?g$/i.test(String(file.name || ""));
  if (!isJpeg) return { source: file, orientation: 1 };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const exif = readJpegOrientation(bytes);
  if (!exif) return { source: file, orientation: 1 };
  // arrayBuffer() returns an independent copy. Mutating it preserves the
  // original File while avoiding a second full-size copy on memory-limited
  // mobile browsers.
  writeExifOrientation(bytes, exif.valueOffset, exif.littleEndian, 1);
  return {
    source: new Blob([bytes], { type: file.type || "image/jpeg" }),
    orientation: exif.orientation
  };
}

function readJpegOrientation(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    const segmentLength = readBigEndianUint16(bytes, offset);
    if (!segmentLength || offset + segmentLength > bytes.length) break;
    if (marker === 0xe1 && segmentLength >= 8 &&
        bytes[offset + 2] === 0x45 && bytes[offset + 3] === 0x78 &&
        bytes[offset + 4] === 0x69 && bytes[offset + 5] === 0x66 &&
        bytes[offset + 6] === 0x00 && bytes[offset + 7] === 0x00) {
      const tiffOffset = offset + 8;
      const littleEndian = bytes[tiffOffset] === 0x49 && bytes[tiffOffset + 1] === 0x49;
      const bigEndian = bytes[tiffOffset] === 0x4d && bytes[tiffOffset + 1] === 0x4d;
      if (!littleEndian && !bigEndian) return null;
      const read16 = (position) => readEndianUint16(bytes, position, littleEndian);
      const read32 = (position) => readEndianUint32(bytes, position, littleEndian);
      if (read16(tiffOffset + 2) !== 42) return null;
      const ifdOffset = read32(tiffOffset + 4);
      const ifd = tiffOffset + ifdOffset;
      if (ifd < tiffOffset || ifd + 2 > offset + segmentLength) return null;
      const entryCount = read16(ifd);
      for (let index = 0; index < entryCount; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > offset + segmentLength) break;
        if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3 || read32(entry + 4) !== 1) continue;
        const valueOffset = entry + 8;
        const orientation = read16(valueOffset);
        return {
          orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
          valueOffset,
          littleEndian
        };
      }
      return null;
    }
    offset += segmentLength;
  }
  return null;
}

function readBigEndianUint16(bytes, offset) {
  return offset + 2 <= bytes.length ? (bytes[offset] << 8) | bytes[offset + 1] : 0;
}

function readEndianUint16(bytes, offset, littleEndian) {
  if (offset + 2 > bytes.length) return 0;
  return littleEndian ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}

function readEndianUint32(bytes, offset, littleEndian) {
  if (offset + 4 > bytes.length) return 0;
  return littleEndian
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0
    : ((bytes[offset] * 0x1000000) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeExifOrientation(bytes, offset, littleEndian, value) {
  if (offset < 0 || offset + 2 > bytes.length) return;
  if (littleEndian) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = value >> 8;
  } else {
    bytes[offset] = value >> 8;
    bytes[offset + 1] = value & 0xff;
  }
}

function orientedImageSize(width, height, orientation) {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

async function resizePhoto(bitmap, maxDimension, targetBytes, initialQuality, orientation = 1) {
  const sourceSize = orientedImageSize(bitmap.width, bitmap.height, orientation);
  const ratio = Math.min(1, maxDimension / Math.max(sourceSize.width, sourceSize.height));
  const width = Math.max(1, Math.round(sourceSize.width * ratio));
  const height = Math.max(1, Math.round(sourceSize.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  drawOrientedImage(context, bitmap, orientation, width / sourceSize.width, height / sourceSize.height);
  let quality = initialQuality;
  let blob = await canvasToBlob(canvas, quality);
  while (blob.size > targetBytes && quality > 0.5) {
    quality -= 0.08;
    blob = await canvasToBlob(canvas, quality);
  }
  return blob;
}

function drawOrientedImage(context, bitmap, orientation, scaleX, scaleY) {
  const width = bitmap.width;
  const height = bitmap.height;
  switch (orientation) {
    case 2: context.setTransform(-scaleX, 0, 0, scaleY, width * scaleX, 0); break;
    case 3: context.setTransform(-scaleX, 0, 0, -scaleY, width * scaleX, height * scaleY); break;
    case 4: context.setTransform(scaleX, 0, 0, -scaleY, 0, height * scaleY); break;
    case 5: context.setTransform(0, scaleY, scaleX, 0, 0, 0); break;
    case 6: context.setTransform(0, scaleY, -scaleX, 0, height * scaleX, 0); break;
    case 7: context.setTransform(0, -scaleY, -scaleX, 0, height * scaleX, width * scaleY); break;
    case 8: context.setTransform(0, -scaleY, scaleX, 0, 0, width * scaleY); break;
    default: context.setTransform(scaleX, 0, 0, scaleY, 0, 0); break;
  }
  context.drawImage(bitmap, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を変換できませんでした。")), "image/webp", quality);
  });
}
