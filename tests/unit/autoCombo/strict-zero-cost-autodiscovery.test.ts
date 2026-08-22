import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  findBudgetEntry,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";
import {
  composeEffectiveZeroPriceEvidence,
  createZeroSpendEvidenceResolver,
  type AccountSpendSafetySource,
  type EffectiveModelPriceSource,
} from "../../../open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = { minRemainingAllowance: 1, maxEvidenceAgeMs: 180_000, now: () => Date.parse(NOW) };

function safeEvidence(): ZeroSpendEvidence {
  return {
    status: "SAFE",
    kind: "free-quota",
    remainingFreeAllowance: 40,
    effectiveInputPrice: null,
    effectiveOutputPrice: null,
    paidSpendPossible: false,
    hardStopVerified: true,
    checkedAt: NOW,
    expiresAt: null,
    source: "fixture",
    promotional: false,
  };
}

function keylessEntry(modelId: string): FreeModelBudget {
  return {
    provider: "dynamic-keyless",
    modelId,
    displayName: modelId,
    monthlyTokens: 0,
    creditTokens: 0,
    freeType: "keyless",
    poolKey: null,
    tos: "ok",
  };
}

function quotaEntry(modelId: string): FreeModelBudget {
  return {
    provider: "dynamic-quota",
    modelId,
    displayName: modelId,
    monthlyTokens: 1_000_000,
    creditTokens: 0,
    freeType: "recurring-daily",
    poolKey: null,
    tos: "ok",
    hardStopGuaranteed: true,
  };
}

test("new keyless catalog entry becomes eligible without a filter code change", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-keyless",
    model: "new-free-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, findBudgetEntry(candidate, []), () => undefined, OPTIONS),
    []
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, [keylessEntry("new-free-model")]),
      () => undefined,
      OPTIONS
    ),
    [SYNTHETIC_NOAUTH_CONNECTION_ID]
  );
});

test("removed keyless catalog entry becomes ineligible without a filter code change", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-keyless",
    model: "temporary-free-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, [keylessEntry("temporary-free-model")]),
      () => undefined,
      OPTIONS
    ),
    [SYNTHETIC_NOAUTH_CONNECTION_ID]
  );
  assert.deepEqual(
    evaluateCandidateConnections(candidate, findBudgetEntry(candidate, []), () => undefined, OPTIONS),
    []
  );
});

test("new credentialed quota model is admitted from catalog membership plus independent SAFE evidence", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-quota",
    model: "new-quota-model",
    connectionId: "connection-1",
  };
  const catalog = [quotaEntry("new-quota-model")];
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, catalog),
      () => safeEvidence(),
      OPTIONS
    ),
    ["connection-1"]
  );
});

test("catalog membership without economic evidence remains fail-closed", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-quota",
    model: "unknown-economics-model",
    connectionId: "connection-1",
  };
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, [quotaEntry("unknown-economics-model")]),
      () => undefined,
      OPTIONS
    ),
    []
  );
});

test("effective zero price becomes SAFE only when independent account spend protection is verified", () => {
  const evidence = composeEffectiveZeroPriceEvidence(
    {
      inputPerMillion: 0,
      outputPerMillion: 0,
      checkedAt: NOW,
      expiresAt: "2026-08-31T00:00:00.000Z",
      source: "live-price",
      promotional: true,
    },
    {
      paidSpendPossible: true,
      hardStopVerified: true,
      source: "account-cap",
      checkedAt: NOW,
    }
  );

  assert.equal(evidence?.status, "SAFE");
  assert.equal(evidence?.kind, "effective-zero-price");
  assert.equal(evidence?.promotional, true);
  assert.equal(evidence?.source, "live-price+account-cap");
});

test("zero-price model is not admitted when the account can silently fall through to paid spend", () => {
  const evidence = composeEffectiveZeroPriceEvidence(
    {
      inputPerMillion: 0,
      outputPerMillion: 0,
      checkedAt: NOW,
      expiresAt: null,
      source: "live-price",
      promotional: true,
    },
    {
      paidSpendPossible: true,
      hardStopVerified: false,
      source: "account-unknown",
      checkedAt: NOW,
    }
  );
  assert.equal(evidence, undefined);
});

test("nonzero effective price can never be converted into promotional zero-spend evidence", () => {
  const evidence = composeEffectiveZeroPriceEvidence(
    {
      inputPerMillion: 0,
      outputPerMillion: 0.01,
      checkedAt: NOW,
      expiresAt: null,
      source: "live-price",
      promotional: true,
    },
    {
      paidSpendPossible: false,
      hardStopVerified: true,
      source: "hard-stop",
      checkedAt: NOW,
    }
  );
  assert.equal(evidence, undefined);
});

test("resolver dynamically discovers a promo from independent price and account-safety adapters", async () => {
  const resolver = createZeroSpendEvidenceResolver({
    ttlMs: 60_000,
    now: () => Date.parse(NOW),
    getConnection: async () => ({ id: "account-a", provider: "gateway" }),
  });

  const priceSource: EffectiveModelPriceSource = {
    id: "gateway-live-pricing",
    resolve: async ({ model }) =>
      model === "brand-new-promo-model"
        ? {
            inputPerMillion: 0,
            outputPerMillion: 0,
            checkedAt: NOW,
            expiresAt: "2026-08-25T00:00:00.000Z",
            source: "gateway-live-pricing",
            promotional: true,
          }
        : undefined,
  };
  const safetySource: AccountSpendSafetySource = {
    id: "gateway-account-cap",
    resolve: async () => ({
      paidSpendPossible: true,
      hardStopVerified: true,
      source: "gateway-account-cap",
      checkedAt: NOW,
    }),
  };

  resolver.registerEffectiveModelPriceSource("gateway", priceSource);
  resolver.registerAccountSpendSafetySource("gateway", safetySource);

  assert.equal(resolver.resolve("gateway", "account-a", "brand-new-promo-model"), undefined);
  await resolver.whenIdle();
  const evidence = resolver.resolve("gateway", "account-a", "brand-new-promo-model");
  assert.equal(evidence?.status, "SAFE");
  assert.equal(evidence?.promotional, true);
  assert.equal(evidence?.kind, "effective-zero-price");
});

test("a free-looking model name is never evidence by itself", async () => {
  const resolver = createZeroSpendEvidenceResolver({
    ttlMs: 60_000,
    now: () => Date.parse(NOW),
    getConnection: async () => ({ id: "account-a", provider: "gateway" }),
  });

  assert.equal(resolver.resolve("gateway", "account-a", "super-model:free"), undefined);
  await resolver.whenIdle();
  assert.equal(resolver.peek("gateway", "account-a", "super-model:free"), undefined);
});
