export const MODEL_PRICING_USD_PER_MILLION = Object.freeze({
  "gpt-5.6-luna": Object.freeze({ input: 0.2, cached: 0.02, output: 1.2 }),
  "gpt-5.6-terra": Object.freeze({ input: 2, cached: 0.2, output: 12 }),
  "gpt-5.6-sol": Object.freeze({ input: 4, cached: 0.4, output: 20 })
});

export function currentJstPeriod(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export function normalizedIdentifier(value, max = 128) {
  const text = String(value || "").trim();
  return new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(text) ? text : "";
}

export function normalizedMessage(value, max = 12000) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return "";
  return text;
}

export function memoryNamespace(identityId, characterId) {
  const identity = normalizedIdentifier(identityId, 64);
  const character = normalizedIdentifier(characterId, 64);
  if (!identity || !character) throw new RangeError("Memory namespace requires valid identifiers");
  return `${identity}:${character}`;
}

export function selectChatModel(text, configured = {}) {
  const value = String(text || "");
  const advanced = /(?:高度|精密|詳細|深く|徹底|法的|医療|財務|設計|分析)/u.test(value) || value.length > 1800;
  if (advanced) return configured.advanced || "gpt-5.6-sol";
  if (value.length > 220 || /(?:比較|理由|計画|相談|検討|説明)/u.test(value)) return configured.balanced || "gpt-5.6-terra";
  return configured.default || "gpt-5.6-luna";
}

export function conservativeTokenUpperBound(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

export function estimateReservationMicrosJpy({ model, inputText, maxOutputTokens, usdJpyRate = 200 }) {
  const pricing = MODEL_PRICING_USD_PER_MILLION[model];
  if (!pricing) throw new RangeError("Unknown model pricing");
  const inputTokens = conservativeTokenUpperBound(inputText);
  const outputTokens = Math.max(1, Math.trunc(Number(maxOutputTokens) || 1));
  const jpy = ((inputTokens * pricing.input) + (outputTokens * pricing.output)) * Number(usdJpyRate) / 1_000_000;
  return Math.max(1, Math.ceil(jpy * 1_000_000));
}

export function usageCostMicrosJpy({ model, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, audioInputTokens = 0, audioOutputTokens = 0, usdJpyRate = 200 }) {
  const pricing = MODEL_PRICING_USD_PER_MILLION[model];
  if (!pricing) throw new RangeError("Unknown model pricing");
  const uncached = Math.max(0, Number(inputTokens) - Number(cachedInputTokens));
  const textUsd = (uncached * pricing.input + Number(cachedInputTokens) * pricing.cached + Number(outputTokens) * pricing.output) / 1_000_000;
  // Realtime audio pricing is accounted separately when the realtime phase is enabled.
  if (Number(audioInputTokens) || Number(audioOutputTokens)) throw new RangeError("Audio pricing is not configured");
  return Math.max(0, Math.ceil(textUsd * Number(usdJpyRate) * 1_000_000));
}

export function effectiveBudgetLimitMicros(policy, period = currentJstPeriod()) {
  const reserveEnabled = Boolean(policy?.reserveEnabled) && policy?.reservePeriod === period;
  const yen = reserveEnabled ? Number(policy?.hardStopJpy) : Number(policy?.softStopJpy);
  return Math.max(0, Math.trunc(yen * 1_000_000));
}

export function publicBudgetState({ policy, usageMicros = 0, period = currentJstPeriod() }) {
  const spentJpy = Number(usageMicros) / 1_000_000;
  const monthlyBudgetJpy = Number(policy?.monthlyBudgetJpy || 0);
  const effectiveStopJpy = effectiveBudgetLimitMicros(policy, period) / 1_000_000;
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dayOfMonth = Math.max(1, nowJst.getUTCDate());
  const daysInMonth = new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth() + 1, 0)).getUTCDate();
  const budgetUsageRate = monthlyBudgetJpy > 0 ? Math.min(1, spentJpy / monthlyBudgetJpy) : 0;
  return {
    period,
    monthlyBudgetJpy,
    softStopJpy: Number(policy?.softStopJpy || 0),
    hardStopJpy: Number(policy?.hardStopJpy || 0),
    reserveEnabled: Boolean(policy?.reserveEnabled) && policy?.reservePeriod === period,
    effectiveStopJpy,
    activeLimitJpy: effectiveStopJpy,
    spentJpy,
    remainingJpy: Math.max(0, effectiveStopJpy - spentJpy),
    budgetUsageRate,
    usageRatio: budgetUsageRate,
    projectedMonthEndJpy: Math.max(spentJpy, spentJpy * daysInMonth / dayOfMonth),
    stopped: effectiveStopJpy <= 0 || spentJpy >= effectiveStopJpy
  };
}
