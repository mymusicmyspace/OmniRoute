import type { ZeroSpendEvidence } from "./zeroSpendEvidence.ts";

export interface ZeroSpendEvidenceKey {
  provider: string;
  connectionId: string;
  model: string;
}

export interface ZeroSpendEvidenceCacheOptions {
  ttlMs: number;
  refresh: (key: ZeroSpendEvidenceKey) => Promise<ZeroSpendEvidence | undefined>;
  now?: () => number;
  maxConcurrentRefreshes?: number;
}

type CacheEntry = {
  evidence: ZeroSpendEvidence;
};

function keyString(key: ZeroSpendEvidenceKey): string {
  return `${key.provider}\u0000${key.connectionId}\u0000${key.model}`;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class ZeroSpendEvidenceCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, ZeroSpendEvidenceKey>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly ttlMs: number;
  private readonly refreshFn: ZeroSpendEvidenceCacheOptions["refresh"];
  private readonly now: () => number;
  private readonly maxConcurrentRefreshes: number;
  private activeRefreshes = 0;

  constructor(options: ZeroSpendEvidenceCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.refreshFn = options.refresh;
    this.now = options.now ?? Date.now;
    this.maxConcurrentRefreshes = Math.max(1, options.maxConcurrentRefreshes ?? 8);
  }

  get(key: ZeroSpendEvidenceKey): ZeroSpendEvidence | undefined {
    const serialized = keyString(key);
    const entry = this.cache.get(serialized);
    if (entry && this.isFresh(entry.evidence)) return entry.evidence;

    if (entry) this.cache.delete(serialized);
    this.scheduleRefresh(key);
    return undefined;
  }

  peek(key: ZeroSpendEvidenceKey): ZeroSpendEvidence | undefined {
    const serialized = keyString(key);
    const entry = this.cache.get(serialized);
    if (!entry) return undefined;
    if (this.isFresh(entry.evidence)) return entry.evidence;
    this.cache.delete(serialized);
    return undefined;
  }

  invalidate(provider: string, connectionId: string, model?: string): void {
    if (model !== undefined) {
      this.cache.delete(keyString({ provider, connectionId, model }));
      return;
    }

    const prefix = `${provider}\u0000${connectionId}\u0000`;
    for (const serialized of this.cache.keys()) {
      if (serialized.startsWith(prefix)) this.cache.delete(serialized);
    }
  }

  async whenIdle(): Promise<void> {
    if (this.activeRefreshes === 0 && this.queued.size === 0 && this.inFlight.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private isFresh(evidence: ZeroSpendEvidence): boolean {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) return false;
    const checkedAt = parseTimestamp(evidence.checkedAt);
    if (checkedAt === null) return false;

    const now = this.now();
    if (now - checkedAt > this.ttlMs) return false;

    if (evidence.expiresAt !== null) {
      const expiresAt = parseTimestamp(evidence.expiresAt);
      if (expiresAt === null || expiresAt <= now) return false;
    }

    return true;
  }

  private scheduleRefresh(key: ZeroSpendEvidenceKey): void {
    const serialized = keyString(key);
    if (this.inFlight.has(serialized) || this.queued.has(serialized)) return;

    if (this.activeRefreshes >= this.maxConcurrentRefreshes) {
      this.queued.set(serialized, { ...key });
      return;
    }

    this.startRefresh(key);
  }

  private startRefresh(key: ZeroSpendEvidenceKey): void {
    const serialized = keyString(key);
    this.activeRefreshes += 1;

    const task = (async () => {
      try {
        const evidence = await this.refreshFn(key);
        if (evidence && this.isFresh(evidence)) {
          this.cache.set(serialized, { evidence });
        } else {
          this.cache.delete(serialized);
        }
      } catch {
        this.cache.delete(serialized);
      } finally {
        this.inFlight.delete(serialized);
        this.activeRefreshes -= 1;
        this.drainQueue();
        this.notifyIdleIfNeeded();
      }
    })();

    this.inFlight.set(serialized, task);
  }

  private drainQueue(): void {
    while (this.activeRefreshes < this.maxConcurrentRefreshes && this.queued.size > 0) {
      const next = this.queued.entries().next().value as
        | [string, ZeroSpendEvidenceKey]
        | undefined;
      if (!next) break;
      const [serialized, key] = next;
      this.queued.delete(serialized);
      this.startRefresh(key);
    }
  }

  private notifyIdleIfNeeded(): void {
    if (this.activeRefreshes !== 0 || this.queued.size !== 0 || this.inFlight.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
