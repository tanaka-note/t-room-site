export const LEGACY_PASSWORD_ITERATIONS = 100000;
// Cloudflare Workers Web Crypto supports PBKDF2 iteration counts up to 100000.
// The current format adds a server-side HMAC pepper while retaining that supported limit.
export const CURRENT_PASSWORD_ITERATIONS = 100000;
export const CURRENT_PEPPER_VERSION = 1;
export const SOURCE_LOGIN_LIMIT = 5;
export const ACCOUNT_LOGIN_LIMIT = 25;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const encoder = new TextEncoder();

export async function verifyPasswordRecord(password, record, pepper = "") {
  try {
    const iterations = Number(record?.password_iterations);
    if (!Number.isInteger(iterations) || iterations < LEGACY_PASSWORD_ITERATIONS || iterations > 2000000) return false;

    const pepperVersion = Number(record?.password_pepper_version || 0);
    if (![0, CURRENT_PEPPER_VERSION].includes(pepperVersion)) return false;
    if (pepperVersion === CURRENT_PEPPER_VERSION && !pepper) return false;

    const material = pepperVersion === CURRENT_PEPPER_VERSION
      ? await pepperPassword(password, pepper)
      : encoder.encode(password);
    const actual = await derivePasswordHash(material, base64UrlToBytes(record.password_salt), iterations);
    return constantTimeEqual(actual, base64UrlToBytes(record.password_hash));
  } catch {
    return false;
  }
}

export async function createCurrentPasswordRecord(password, pepper) {
  if (!pepper) throw new Error("BILLING_PASSWORD_PEPPER is required");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const material = await pepperPassword(password, pepper);
  const hash = await derivePasswordHash(material, salt, CURRENT_PASSWORD_ITERATIONS);
  return {
    passwordSalt: bytesToBase64Url(salt),
    passwordHash: bytesToBase64Url(hash),
    passwordIterations: CURRENT_PASSWORD_ITERATIONS,
    passwordPepperVersion: CURRENT_PEPPER_VERSION
  };
}

export function needsPasswordUpgrade(record) {
  return Number(record?.password_pepper_version || 0) !== CURRENT_PEPPER_VERSION
    || Number(record?.password_iterations || 0) < CURRENT_PASSWORD_ITERATIONS;
}

export function nextSourceAttempt(previous, nowSeconds = Math.floor(Date.now() / 1000)) {
  const firstFailedAt = Number(previous?.first_failed_at || previous?.firstFailedAt || 0);
  const inWindow = firstFailedAt > 0 && nowSeconds - firstFailedAt <= LOGIN_WINDOW_SECONDS;
  const failedCount = inWindow ? Number(previous?.failed_count || previous?.failedCount || 0) + 1 : 1;
  const startedAt = inWindow ? firstFailedAt : nowSeconds;
  return {
    failedCount,
    firstFailedAt: startedAt,
    lockedUntil: failedCount >= SOURCE_LOGIN_LIMIT ? nowSeconds + LOGIN_WINDOW_SECONDS : null
  };
}

export function isSourceLocked(lockedUntil, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Number(lockedUntil || 0) > nowSeconds;
}

async function pepperPassword(password, pepper) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(password)));
}

async function derivePasswordHash(material, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations
  }, keyMaterial, 256);
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
