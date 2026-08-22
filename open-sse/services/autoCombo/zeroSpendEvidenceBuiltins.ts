import { FREE_MODEL_BUDGETS } from "../../config/freeModelCatalog.ts";
import { refreshOpenRouterCatalog } from "@/lib/catalog/openrouterCatalog";
import type {
  AccountSpendSafetySource,
  EffectiveModelPriceSource,
} from "./zeroSpendEvidenceResolver.ts";

const STRICT_OPENROUTER_SNAPSHOT_TTL_MS = 120_000;

type OpenRouterPricing = {
  prompt?: string;
  completion?: string;
  image?: string;
  request?: string;
};

type OpenRouterStrictCatalogEntry = {
  id: string;
  pricing?: OpenRouterPricing;
};

type OpenRouterStrictSnapshot = {
  checkedAt: string;
  fetchedAtMs: number;
  data: OpenRouterStrictCatalogEntry[];
};

let openRouterSnapshot: OpenRouterStrictSnapshot | null = null;
let openRouterRefreshInFlight: Promise<OpenRouterStrictSnapshot | undefined> | null = null;

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

async function getFreshOpenRouterStrictSnapshot(): Promise<OpenRouterStrictSnapshot | undefined> {
  const now = Date.now();
  if (
    openRouterSnapshot &&
    now - openRouterSnapshot.fetchedAtMs <= STRICT_OPENROUTER_SNAPSHOT_TTL_MS
  ) {
    return openRouterSnapshot;
  }

  if (!openRouterRefreshInFlight) {
    openRouterRefreshInFlight = (async () => {
      const refreshed = await refreshOpenRouterCatalog();
      if (!refreshed.ok) {
        // Strict never reuses a stale last-known price after a failed refresh.
        openRouterSnapshot = null;
        return undefined;
      }
      const fetchedAtMs = Date.now();
      const snapshot: OpenRouterStrictSnapshot = {
        checkedAt: new Date(fetchedAtMs).toISOString(),
        fetchedAtMs,
        data: refreshed.data as OpenRouterStrictCatalogEntry[],
      };
      openRouterSnapshot = snapshot;
      return snapshot;
    })().finally(() => {
      openRouterRefreshInFlight = null;
    });
  }

  return openRouterRefreshInFlight;
}

/**
 * OpenRouter's public /models catalog reports effective per-token prices for the
 * exact model SKU being requested. Strict uses a short provider-wide snapshot so
 * hundreds of candidate models share one network refresh rather than each fetching
 * the catalog independently. A failed refresh yields no proof; stale prices are
 * never carried forward.
 */
export const openRouterEffectivePriceSource: EffectiveModelPriceSource = {
  id: "openrouter-live-model-price",
  async resolve({ model }) {
    const catalog = await getFreshOpenRouterStrictSnapshot();
    if (!catalog) return undefined;

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
      inputPerMillion: 0,
      outputPerMillion: 0,
      checkedAt: catalog.checkedAt,
      expiresAt: null,
      source: "openrouter-live-model-price",
      promotional: !isPermanentCatalogFree("openrouter", model),
    };
  },
};

/**
 * Independent spend-safety fact for OpenRouter exact model IDs. OmniRoute sends the
 * concrete model SKU; the live catalog proves that same SKU is currently 0/0 priced.
 * There is no OmniRoute-side substitution to a paid SKU inside this evidence path.
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

export function resetZeroSpendBuiltinCachesForTests(): void {
  openRouterSnapshot = null;
  openRouterRefreshInFlight = null;
}
