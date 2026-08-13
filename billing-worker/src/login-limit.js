export const LOGIN_LOCK_MINUTES = 15;

export function isLoginLocked(lockedUntil, nowMilliseconds = Date.now()) {
  if (typeof lockedUntil !== "string" || !lockedUntil) return false;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(lockedUntil)
    ? lockedUntil
    : `${lockedUntil.replace(" ", "T")}Z`;
  const lockedUntilMilliseconds = Date.parse(normalized);
  return Number.isFinite(lockedUntilMilliseconds) && lockedUntilMilliseconds > nowMilliseconds;
}
