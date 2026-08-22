import { test } from "vitest";
import assert from "node:assert/strict";

import {
  ZeroSpendEvidenceCache,
  type ZeroSpendEvidenceKey,
} from "../../../open-sse/services/autoCombo/zeroSpendEvidenceCache.ts";
import {
  createZeroSpendEvidenceResolver,
  type ZeroSpendEvidenceSource,
} from "../../../open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";

const START = Date.parse("2026-08-22T12:00:00.000Z");
const KEY: ZeroSpendEvidenceKey = {
  provider: "fixture",
  connectionId: "account-a",
  model: "model-x",
};

function safeEvidence(checkedAt: number, overrides: Partial<ZeroSpendEvidence> = {}): ZeroSpendEvidence {
  return {
    status: "SAFE",
    kind: "free-quota",
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: null,
    remainingFreeAllowance: 50,
    effectiveInputPrice: null,
    effectiveOutputPrice: null,
    paidSpendPossible: false,
    hardStopVerified: true,
    source: "fixture",
    promotional: false,
    ...overrides,
  };
}

test("cold read fails closed and schedules exactly one deduplicated refresh", async () => {
  let now = START;
  let calls = 0;
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 60_000,
    now: () => now,
    refresh: async () => {
      calls += 1;
      return safeEvidence(now);
    },
  });

  assert.equal(cache.get(KEY), undefined);
  assert.equal(cache.get(KEY), undefined);
  await cache.whenIdle();
  assert.equal(calls, 1);
  assert.equal(cache.get(KEY)?.status, "SAFE");
});

test("stale SAFE evidence is removed before refresh and never returned optimistically", async () => {
  let now = START;
  let calls = 0;
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 100,
    now: () => now,
    refresh: async () => {
      calls += 1;
      return safeEvidence(now);
    },
  });

  assert.equal(cache.get(KEY), undefined);
  await cache.whenIdle();
  assert.equal(cache.get(KEY)?.status, "SAFE");

  now += 101;
  assert.equal(cache.get(KEY), undefined);
  await cache.whenIdle();
  assert.equal(calls, 2);
  assert.equal(cache.get(KEY)?.status, "SAFE");
});

test("refresh rejection cannot preserve an old stale SAFE entry", async () => {
  let now = START;
  let fail = false;
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 100,
    now: () => now,
    refresh: async () => {
      if (fail) throw new Error("provider unavailable");
      return safeEvidence(now);
    },
  });

  cache.get(KEY);
  await cache.whenIdle();
  now += 101;
  fail = true;
  assert.equal(cache.get(KEY), undefined);
  await cache.whenIdle();
  assert.equal(cache.peek(KEY), undefined);
});

test("invalidation wins over an older refresh already in flight", async () => {
  let releaseRefresh: ((evidence: ZeroSpendEvidence) => void) | undefined;
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 60_000,
    now: () => START,
    refresh: async () =>
      await new Promise<ZeroSpendEvidence>((resolve) => {
        releaseRefresh = resolve;
      }),
  });

  assert.equal(cache.get(KEY), undefined);
  assert.ok(releaseRefresh, "refresh must be in flight before invalidation");

  cache.invalidate(KEY.provider, KEY.connectionId, KEY.model);
  releaseRefresh!(safeEvidence(START));
  await cache.whenIdle();

  assert.equal(
    cache.peek(KEY),
    undefined,
    "a response started before invalidation must never repopulate SAFE evidence afterwards"
  );
});

test("account-wide invalidation also blocks all older model refreshes from repopulating", async () => {
  const releases = new Map<string, (evidence: ZeroSpendEvidence) => void>();
  const keys: ZeroSpendEvidenceKey[] = [
    KEY,
    { ...KEY, model: "model-y" },
  ];
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 60_000,
    now: () => START,
    refresh: async (key) =>
      await new Promise<ZeroSpendEvidence>((resolve) => {
        releases.set(key.model, resolve);
      }),
  });

  for (const key of keys) assert.equal(cache.get(key), undefined);
  assert.equal(releases.size, 2);

  cache.invalidate("fixture", "account-a");
  for (const key of keys) releases.get(key.model)!(safeEvidence(START, { source: key.model }));
  await cache.whenIdle();

  for (const key of keys) {
    assert.equal(cache.peek(key), undefined, `${key.model} must remain invalidated`);
  }
});

test("evidence expires at its own expiresAt even when generic TTL is longer", async () => {
  let now = START;
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 60_000,
    now: () => now,
    refresh: async () =>
      safeEvidence(now, { expiresAt: new Date(START + 1_000).toISOString(), promotional: true }),
  });

  cache.get(KEY);
  await cache.whenIdle();
  assert.equal(cache.get(KEY)?.status, "SAFE");
  now = START + 1_001;
  assert.equal(cache.get(KEY), undefined);
});

test("model-specific invalidation removes one entry and account invalidation removes all models", async () => {
  const keys: ZeroSpendEvidenceKey[] = [
    KEY,
    { ...KEY, model: "model-y" },
    { provider: "fixture", connectionId: "account-b", model: "model-x" },
  ];
  const cache = new ZeroSpendEvidenceCache({
    ttlMs: 60_000,
    now: () => START,
    refresh: async (key) => safeEvidence(START, { source: key.model }),
  });
  for (const key of keys) cache.get(key);
  await cache.whenIdle();

  cache.invalidate("fixture", "account-a", "model-x");
  assert.equal(cache.peek(KEY), undefined);
  assert.equal(cache.peek(keys[1])?.source, "model-y");

  cache.invalidate("fixture", "account-a");
  assert.equal(cache.peek(keys[1]), undefined);
  assert.equal(cache.peek(keys[2])?.source, "model-x");
});

test("resolver source registry composes account/model lookup without guessing generic balances", async () => {
  let now = START;
  const source: ZeroSpendEvidenceSource = {
    id: "normalized-free-tier",
    resolve: async ({ model }) =>
      model === "safe-model" ? safeEvidence(now, { source: "normalized-free-tier" }) : undefined,
  };
  const resolver = createZeroSpendEvidenceResolver({
    now: () => now,
    ttlMs: 60_000,
    getConnection: async () => ({ id: "account-a", provider: "fixture" }),
  });
  resolver.registerSource("fixture", source);

  assert.equal(resolver.resolve("fixture", "account-a", "safe-model"), undefined);
  await resolver.whenIdle();
  assert.equal(resolver.resolve("fixture", "account-a", "safe-model")?.source, "normalized-free-tier");

  assert.equal(resolver.resolve("fixture", "account-a", "ambiguous-model"), undefined);
  await resolver.whenIdle();
  assert.equal(resolver.peek("fixture", "account-a", "ambiguous-model"), undefined);
});
