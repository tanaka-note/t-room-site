import assert from "node:assert/strict";

await import("../public/file-safety.js");

function mockFile(name, bytes) {
  const blob = new Blob([Uint8Array.from(bytes)]);
  return { name, size: blob.size, slice: (...args) => blob.slice(...args) };
}

await TCloudSafety.inspect(mockFile("photo.jpg", [0xff, 0xd8, 0xff, 0xe0]));
await TCloudSafety.inspect(mockFile("movie.flv", [0x46, 0x4c, 0x56, 0x01]));
await TCloudSafety.inspect(mockFile("report.pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]));
await TCloudSafety.inspect(mockFile("unknown.custom", [1, 2, 3, 4]));
await TCloudSafety.inspect(mockFile("(sample-SEXT VX.COM.mp4", [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));

for (const file of [
  mockFile("invoice.pdf.exe", [0x4d, 0x5a, 0, 0]),
  mockFile("photo.jpg", [0x4d, 0x5a, 0, 0]),
  mockFile("photo.jpg", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
  mockFile("safe\u202Egpj.exe", [1, 2, 3]),
  mockFile("page.html", [0x3c, 0x68, 0x74, 0x6d, 0x6c])
]) {
  await assert.rejects(() => TCloudSafety.inspect(file), (error) => error.code === "SAFETY_CONFIRM_REQUIRED");
}

console.log("privacy-first file safety: ok");
