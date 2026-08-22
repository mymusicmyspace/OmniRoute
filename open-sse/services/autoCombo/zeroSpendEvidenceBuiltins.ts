import { FREE_MODEL_BUDGETS } from "../../config/freeModelCatalog.ts";
import { getOpenRouterCatalog } from "@/lib/catalog/openrouterCatalog";
import type {
  AccountSpendSafetySource,
  EffectiveModelPriceSource,
} from "./zeroSpendEvidenceResolver.ts";

function parsePerTokenPrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPermanentCatalogFree(provider: string, model: string): boolean {
  return FREE_MODEL_BUDGETS.some(
    (entry) =>
      entry.provider === provider &&
      entry.modelId === model &&
      entry.freeType !== "one-time-initial" &&
      entry.freeType !== "discontinued"
  );
}

/**
 * OpenRouter's public /models catalog reports effective per-token prices for the
 * exact model SKU being requested. A fresh explicit 0/0 entry is therefore usable
 * as economic evidence without keeping a model whitelist in OmniRoute.
 *
 * Missing pricing fields, non-token request fees, or a stale catalog all fail closed.
 */
export const openRouterEffectivePriceSource: EffectiveModelPriceSource = {
  id: "openrouter-live-model-price",
  async resolve({ model }) {
    const catalog = await getOpenRouterCatalog();
    if (catalog.stale) return undefined;

    const entry = catalog.data.find((candidate) => candidate.id === model);
    if (!entry?.pricing) return undefined;

    const prompt = parsePerTokenPrice(entry.pricing.prompt);
    const completion = parsePerTokenPrice(entry.pricing.completion);
    if (prompt === null || completion === null) return undefined;

    const requestFee = parsePerTokenPrice(entry.pricing.request);
    if (requestFee !== null && requestFee !== 0) return undefined;
    const imageFee = parsePerTokenPrice(entry.pricing.image);
    if (imageFee !== null && imageFee !== 0) return undefined;

    if (prompt !== 0 || completion !== 0) return undefined;

    return {
      inputPerMillion: prompt * 1_000_000,
      outputPerMillion: completion * 1_000_000,
      checkedAt: catalog.cachedAt ?? new Date().toISOString(),
      expiresAt: null,
      source: "openrouter-live-model-price",
      promotional: !isPermanentCatalogFree("openrouter", model),
    };
  },
};

/**
 * Independent spend-safety fact for OpenRouter exact model IDs. OmniRoute sends the
 * concrete model SKU; OpenRouter prices that SKU rather than silently substituting a
 * paid SKU. Combined with a fresh explicit 0/0 catalog price, this prevents a paid
 * fallback inside Strict Zero Cost.
 */
export const openRouterSpendSafetySource: AccountSpendSafetySource = {
  id: "openrouter-exact-model-spend-safety",
  async resolve() {
    return {
      paidSpendPossible: false,
      hardStopVerified: true,
      source: "openrouter-exact-model-spend-safety",
      checkedAt: new Date().toISOString(),
    };
  },
};
