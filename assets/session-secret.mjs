const encoder = new TextEncoder();

// Length/known-placeholder checks cannot prove entropy. Provision each service
// independently with a CSPRNG; never normalize the bytes used for signing.
export function isValidSessionSecret(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value !== value.trim()) return false;
  if (encoder.encode(value).byteLength < 32 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (/password|changeme|replace[\s_-]*with|your[\s_-]*secret|test[\s_-]*secret|example|fixture|dummy|generate[\s_-].*secret|local[\s_-]*only/i.test(value)) return false;
  if (new Set(value).size < 8 || /^(.{1,16})\1+$/u.test(value)) return false;
  return true;
}

export function requireSessionSecret(value, HttpError) {
  if (!isValidSessionSecret(value)) throw new HttpError(503, "セッションの認証設定が完了していません。");
}
