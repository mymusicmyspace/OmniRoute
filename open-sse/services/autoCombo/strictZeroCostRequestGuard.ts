const ZERO_PRICE_LIMIT = Object.freeze({
  prompt: 0,
  completion: 0,
  image: 0,
  audio: 0,
  request: 0,
});

/**
 * OpenRouter supports provider.max_price as a hard upstream routing ceiling. Strict
 * Zero Cost sets every supported price dimension to zero immediately before a
 * selected OpenRouter target is dispatched. If the live price changes after our
 * evidence snapshot, OpenRouter must reject the request rather than charge it.
 *
 * The helper is copy-on-write and preserves unrelated provider preferences.
 */
export function applyStrictZeroCostRequestGuard<T extends Record<string, unknown>>(
  body: T,
  provider: string | null | undefined,
  strictZeroCost: boolean
): T {
  if (!strictZeroCost || provider !== "openrouter") return body;

  const rawProvider = body.provider;
  const providerPrefs =
    rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider)
      ? (rawProvider as Record<string, unknown>)
      : {};

  return {
    ...body,
    provider: {
      ...providerPrefs,
      max_price: { ...ZERO_PRICE_LIMIT },
    },
  } as T;
}

export function isStrictZeroCostCombo(combo: {
  config?: Record<string, unknown> | null;
  autoConfig?: Record<string, unknown> | null;
}): boolean {
  const nestedAuto = combo.config?.auto;
  if (
    nestedAuto &&
    typeof nestedAuto === "object" &&
    !Array.isArray(nestedAuto) &&
    (nestedAuto as Record<string, unknown>).strictZeroCost === true
  ) {
    return true;
  }
  return combo.autoConfig?.strictZeroCost === true;
}
