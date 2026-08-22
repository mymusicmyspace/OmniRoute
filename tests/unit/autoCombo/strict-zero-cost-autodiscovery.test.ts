import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  findBudgetEntry,
  type FreeAccessState,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = { minRemainingAllowance: 1, maxStateAgeMs: 180_000, now: () => Date.parse(NOW) };

function safeState(): FreeAccessState {
  return { status: "SAFE", remainingFreeAllowance: 40, resetAt: null, checkedAt: NOW };
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

function quotaEntry(modelId: string, hardStopGuaranteed = true): FreeModelBudget {
  return {
    provider: "dynamic-quota",
    modelId,
    displayName: modelId,
    monthlyTokens: 1_000_000,
    creditTokens: 0,
    freeType: "recurring-daily",
    poolKey: null,
    tos: "ok",
    hardStopGuaranteed,
  };
}

test("new catalog entry becomes eligible without a filter code change", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-keyless",
    model: "new-free-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, []),
      () => undefined,
      OPTIONS
    ),
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

test("removed catalog entry becomes ineligible without a filter code change", () => {
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

test("new quota model is admitted from metadata plus live SAFE state", () => {
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
      () => safeState(),
      OPTIONS
    ),
    ["connection-1"]
  );
});

test("incomplete safety metadata remains fail-closed", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "dynamic-quota",
    model: "unguaranteed-model",
    connectionId: "connection-1",
  };
  const entry = quotaEntry("unguaranteed-model");
  delete entry.hardStopGuaranteed;
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      findBudgetEntry(candidate, [entry]),
      () => safeState(),
      OPTIONS
    ),
    []
  );
});
