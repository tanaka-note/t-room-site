const SECRET_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const FORWARD_HEADERS = new Set([
  "accept", "accept-language", "authorization", "cookie", "origin", "referer", "user-agent"
]);

export function normalizeHeaders(headers = []) {
  const output = {};
  for (const header of headers || []) {
    const name = String(header?.name || "").trim().toLowerCase();
    if (!FORWARD_HEADERS.has(name) || typeof header?.value !== "string") continue;
    const value = header.value.replace(/[\r\n\0]/g, "").slice(0, name === "cookie" ? 16384 : 4096);
    if (value) output[name] = value;
  }
  return output;
}

export function normalizeHeaderObject(headers = {}) {
  return normalizeHeaders(Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) })));
}

export function publicHeaderNames(headers = {}) {
  return Object.keys(headers).map((name) => SECRET_HEADERS.has(name) ? `${name}:present` : name).sort();
}

export function requestContext(method, headers, initiator) {
  return {
    method: ["GET", "HEAD"].includes(String(method || "").toUpperCase()) ? String(method).toUpperCase() : "GET",
    headers: { ...headers },
    initiator: safeOrigin(initiator)
  };
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}
