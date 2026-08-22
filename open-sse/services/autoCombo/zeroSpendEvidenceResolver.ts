import { getCachedProviderConnections } from "@/lib/db/readCache";
import type { ZeroSpendEvidence } from "./zeroSpendEvidence.ts";
import {
  ZeroSpendEvidenceCache,
  type ZeroSpendEvidenceKey,
} from "./zeroSpendEvidenceCache.ts";

export interface ZeroSpendEvidenceSource {
  id: string;
  resolve(input: {
    provider: string;
    connectionId: string;
    model: string;
    connection: Record<string, unknown>;
  }): Promise<ZeroSpendEvidence | undefined>;
}

export interface AccountSpendSafety {
  paidSpendPossible: boolean;
  hardStopVerified: boolean;
  source: string;
  checkedAt: string;
}

export interface AccountSpendSafetySource {
  id: string;
  resolve(input: {
    provider: string;
    connectionId: string;
    connection: Record<string, unknown>;
  }): Promise<AccountSpendSafety | undefined>;
}

export interface EffectiveModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  checkedAt: string;
  expiresAt: string | null;
  source: string;
  promotional: boolean;
}

export interface EffectiveModelPriceSource {
  id: string;
  resolve(input: {
    provider: string;
    connectionId: string;
    model: string;
    connection: Record<string, unknown>;
  }): Promise<EffectiveModelPrice | undefined>;
}

export interface ZeroSpendEvidenceResolverOptions {
  getConnection: (
    provider: string,
    connectionId: string
  ) => Promise<Record<string, unknown> | undefined>;
  ttlMs?: number;
  now?: () => number;
  maxConcurrentRefreshes?: number;
}

export interface ZeroSpendEvidenceResolver {
  resolve(provider: string, connectionId: string, model: string): ZeroSpendEvidence | undefined;
  peek(provider: string, connectionId: string, model: string): ZeroSpendEvidence | undefined;
  invalidate(provider: string, connectionId: string, model?: string): void;
  registerSource(provider: string, source: ZeroSpendEvidenceSource): void;
  registerAccountSpendSafetySource(provider: string, source: AccountSpendSafetySource): void;
  registerEffectiveModelPriceSource(provider: string, source: EffectiveModelPriceSource): void;
  resetSources(provider?: string): void;
  whenIdle(): Promise<void>;
}

const DEFAULT_TTL_MS = 180_000;

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function newerTimestamp(a: string, b: string): string {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return aMs >= bMs ? a : b;
}

export function composeEffectiveZeroPriceEvidence(
  price: EffectiveModelPrice | undefined,
  safety: AccountSpendSafety | undefined
): ZeroSpendEvidence | undefined {
  if (!price || !safety) return undefined;
  if (!isFiniteNonNegative(price.inputPerMillion) || !isFiniteNonNegative(price.outputPerMillion)) {
    return undefined;
  }
  if (price.inputPerMillion !== 0 || price.outputPerMillion !== 0) return undefined;

  // Zero price alone is not a spend guarantee. A separate account-side fact must
  // prove that a later paid fallback cannot silently charge the account.
  if (safety.paidSpendPossible && !safety.hardStopVerified) return undefined;

  return {
    status: "SAFE",
    kind: "effective-zero-price",
    checkedAt: newerTimestamp(price.checkedAt, safety.checkedAt),
    expiresAt: price.expiresAt,
    remainingFreeAllowance: null,
    effectiveInputPrice: price.inputPerMillion,
    effectiveOutputPrice: price.outputPerMillion,
    paidSpendPossible: safety.paidSpendPossible,
    hardStopVerified: safety.hardStopVerified,
    source: `${price.source}+${safety.source}`,
    promotional: price.promotional,
  };
}

export function createZeroSpendEvidenceResolver(
  options: ZeroSpendEvidenceResolverOptions
): ZeroSpendEvidenceResolver {
  const sources = new Map<string, ZeroSpendEvidenceSource[]>();
  const spendSafetySources = new Map<string, AccountSpendSafetySource[]>();
  const priceSources = new Map<string, EffectiveModelPriceSource[]>();

  const cache = new ZeroSpendEvidenceCache({
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    now: options.now,
    maxConcurrentRefreshes: options.maxConcurrentRefreshes,
    refresh: async (key) => {
      const connection = await options.getConnection(key.provider, key.connectionId);
      if (!connection) return undefined;

      const providerSources = sources.get(key.provider) ?? [];
      let exhausted: ZeroSpendEvidence | undefined;
      let unknown: ZeroSpendEvidence | undefined;

      for (const source of providerSources) {
        try {
          const evidence = await source.resolve({ ...key, connection });
          if (!evidence) continue;
          if (evidence.status === "SAFE") return evidence;
          if (evidence.status === "EXHAUSTED" && !exhausted) exhausted = evidence;
          if (evidence.status === "UNKNOWN" && !unknown) unknown = evidence;
        } catch {
          // A provider adapter failure is absence of proof, never permission to spend.
        }
      }

      const safety = await resolveFirstSpendSafety(
        spendSafetySources.get(key.provider) ?? [],
        key,
        connection
      );
      const price = await resolveFirstEffectivePrice(priceSources.get(key.provider) ?? [], key, connection);
      const zeroPriceEvidence = composeEffectiveZeroPriceEvidence(price, safety);
      if (zeroPriceEvidence) return zeroPriceEvidence;

      return exhausted ?? unknown;
    },
  });

  const toKey = (
    provider: string,
    connectionId: string,
    model: string
  ): ZeroSpendEvidenceKey => ({ provider, connectionId, model });

  const invalidateProviderAccounts = (provider: string) => {
    // Existing cache entries are model/account keyed. Source registration is normally
    // startup-only; callers with live metadata changes should invalidate the concrete
    // account/model through the public invalidate() method.
    void provider;
  };

  return {
    resolve(provider, connectionId, model) {
      return cache.get(toKey(provider, connectionId, model));
    },
    peek(provider, connectionId, model) {
      return cache.peek(toKey(provider, connectionId, model));
    },
    invalidate(provider, connectionId, model) {
      cache.invalidate(provider, connectionId, model);
    },
    registerSource(provider, source) {
      const current = sources.get(provider) ?? [];
      if (current.some((existing) => existing.id === source.id)) return;
      sources.set(provider, [...current, source]);
      invalidateProviderAccounts(provider);
    },
    registerAccountSpendSafetySource(provider, source) {
      const current = spendSafetySources.get(provider) ?? [];
      if (current.some((existing) => existing.id === source.id)) return;
      spendSafetySources.set(provider, [...current, source]);
      invalidateProviderAccounts(provider);
    },
    registerEffectiveModelPriceSource(provider, source) {
      const current = priceSources.get(provider) ?? [];
      if (current.some((existing) => existing.id === source.id)) return;
      priceSources.set(provider, [...current, source]);
      invalidateProviderAccounts(provider);
    },
    resetSources(provider) {
      if (provider !== undefined) {
        sources.delete(provider);
        spendSafetySources.delete(provider);
        priceSources.delete(provider);
        return;
      }
      sources.clear();
      spendSafetySources.clear();
      priceSources.clear();
    },
    whenIdle() {
      return cache.whenIdle();
    },
  };
}

async function resolveFirstSpendSafety(
  sources: AccountSpendSafetySource[],
  key: ZeroSpendEvidenceKey,
  connection: Record<string, unknown>
): Promise<AccountSpendSafety | undefined> {
  for (const source of sources) {
    try {
      const safety = await source.resolve({
        provider: key.provider,
        connectionId: key.connectionId,
        connection,
      });
      if (safety) return safety;
    } catch {
      // Fail closed: adapter failure means no verified spend protection.
    }
  }
  return undefined;
}

async function resolveFirstEffectivePrice(
  sources: EffectiveModelPriceSource[],
  key: ZeroSpendEvidenceKey,
  connection: Record<string, unknown>
): Promise<EffectiveModelPrice | undefined> {
  for (const source of sources) {
    try {
      const price = await source.resolve({ ...key, connection });
      if (price) return price;
    } catch {
      // Fail closed: price discovery failure cannot manufacture zero cost.
    }
  }
  return undefined;
}

async function defaultGetConnection(
  provider: string,
  connectionId: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const connections = (await getCachedProviderConnections({
      provider,
      isActive: true,
    })) as unknown as Record<string, unknown>[];
    return connections.find((connection) => connection.id === connectionId);
  } catch {
    return undefined;
  }
}

const productionResolver = createZeroSpendEvidenceResolver({
  getConnection: defaultGetConnection,
  ttlMs: DEFAULT_TTL_MS,
});

export function resolveZeroSpendEvidence(
  provider: string,
  connectionId: string,
  model: string
): ZeroSpendEvidence | undefined {
  return productionResolver.resolve(provider, connectionId, model);
}

export function peekZeroSpendEvidence(
  provider: string,
  connectionId: string,
  model: string
): ZeroSpendEvidence | undefined {
  return productionResolver.peek(provider, connectionId, model);
}

export function invalidateZeroSpendEvidence(
  provider: string,
  connectionId: string,
  model?: string
): void {
  productionResolver.invalidate(provider, connectionId, model);
}

export function registerZeroSpendEvidenceSource(
  provider: string,
  source: ZeroSpendEvidenceSource
): void {
  productionResolver.registerSource(provider, source);
}

export function registerAccountSpendSafetySource(
  provider: string,
  source: AccountSpendSafetySource
): void {
  productionResolver.registerAccountSpendSafetySource(provider, source);
}

export function registerEffectiveModelPriceSource(
  provider: string,
  source: EffectiveModelPriceSource
): void {
  productionResolver.registerEffectiveModelPriceSource(provider, source);
}

export function resetZeroSpendEvidenceSourcesForTests(provider?: string): void {
  productionResolver.resetSources(provider);
}
