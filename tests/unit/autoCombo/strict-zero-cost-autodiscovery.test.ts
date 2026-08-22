import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  findBudgetEntry,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";
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
