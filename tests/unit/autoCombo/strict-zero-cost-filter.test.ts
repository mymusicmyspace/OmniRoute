import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  filterStrictZeroCostCandidates,
  filterTosAvoidCandidates,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = { minRemainingAllowance: 1, maxEvidenceAgeMs: 180_000, now: () => Date.parse(NOW) };
const REAL_CONN = "conn-real-1";

function safeEvidence(overrides: Partial<ZeroSpendEvidence> = {}): ZeroSpendEvidence {
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
    ...overrides,
  };
}

function keylessEntry(modelId = "keyless-model", tos: FreeModelBudget["tos"] = "ok"): FreeModelBudget {
  return {
    provider: "fixture-keyless",
    modelId,
    displayName: modelId,
    monthlyTokens: 0,
    creditTokens: 0,
    freeType: "keyless",
    poolKey: null,
    tos,
  };
}

function quotaEntry(modelId = "quota-model"): FreeModelBudget {
  return {
    provider: "fixture-quota",
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

test("strict policy disabled returns the original pool reference", () => {
  const pool: StrictZeroCostCandidate[] = [
    { provider: "anything", model: "anything", connectionId: REAL_CONN },
  ];
  const out = filterStrictZeroCostCandidates(pool, {
    enabled: false,
    resolveZeroSpendEvidence: () => undefined,
    ...OPTIONS,
  });
  assert.equal(out, pool);
});

test("genuine no-auth keyless candidate passes without live economic evidence", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "fixture-keyless",
    model: "keyless-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  const resolve = () => {
    throw new Error("genuine keyless no-auth must not resolve account evidence");
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, keylessEntry(), resolve, OPTIONS),
    [SYNTHETIC_NOAUTH_CONNECTION_ID]
  );
});

test("credentialed candidate follows typed economic evidence", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "fixture-quota",
    model: "quota-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, quotaEntry(), () => safeEvidence(), OPTIONS),
    [REAL_CONN]
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(),
      () => safeEvidence({ status: "EXHAUSTED", remainingFreeAllowance: 0 }),
      OPTIONS
    ),
    []
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(),
      () => safeEvidence({ checkedAt: "2026-08-22T11:00:00.000Z" }),
      OPTIONS
    ),
    []
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(),
      () =>
        safeEvidence({
          kind: "effective-zero-price",
          remainingFreeAllowance: null,
          effectiveInputPrice: 0,
          effectiveOutputPrice: 0,
          paidSpendPossible: true,
          hardStopVerified: false,
          promotional: true,
        }),
      OPTIONS
    ),
    []
  );
});

test("candidate missing from current free catalog evidence is excluded in the v1-compatible stage", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "unknown-provider",
    model: "unknown-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, undefined, () => safeEvidence(), OPTIONS),
    []
  );
});

test("ToS guard stays independent from economic filtering", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "fixture-keyless",
    model: "avoid-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  const catalog = [keylessEntry("avoid-model", "avoid")];
  assert.equal(filterTosAvoidCandidates([candidate], false, catalog)[0], candidate);
  assert.deepEqual(filterTosAvoidCandidates([candidate], true, catalog), []);
});
