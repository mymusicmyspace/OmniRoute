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
  resetSources(provider?: string): void;
  whenIdle(): Promise<void>;
}

const DEFAULT_TTL_MS = 180_000;

export function createZeroSpendEvidenceResolver(
  options: ZeroSpendEvidenceResolverOptions
): ZeroSpendEvidenceResolver {
  const sources = new Map<string, ZeroSpendEvidenceSource[]>();

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

      return exhausted ?? unknown;
    },
  });

  const toKey = (
    provider: string,
    connectionId: string,
    model: string
  ): ZeroSpendEvidenceKey => ({ provider, connectionId, model });

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
      cache.invalidate(provider, "");
    },
    resetSources(provider) {
      if (provider !== undefined) {
        sources.delete(provider);
        return;
      }
      sources.clear();
    },
    whenIdle() {
      return cache.whenIdle();
    },
  };
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

export function resetZeroSpendEvidenceSourcesForTests(provider?: string): void {
  productionResolver.resetSources(provider);
}
