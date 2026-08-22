import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  filterStrictZeroCostCandidates,
  filterTosAvoidCandidates,
  type FreeAccessState,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = { minRemainingAllowance: 1, maxStateAgeMs: 180_000, now: () => Date.parse(NOW) };
const REAL_CONN = "conn-real-1";

function safeState(overrides: Partial<FreeAccessState> = {}): FreeAccessState {
  return {
    status: "SAFE",
    remainingFreeAllowance: 40,
    resetAt: null,
    checkedAt: NOW,
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

function quotaEntry(modelId = "quota-model", hardStopGuaranteed = true): FreeModelBudget {
  return {
    provider: "fixture-quota",
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

test("strict policy disabled returns the original pool reference", () => {
  const pool: StrictZeroCostCandidate[] = [
    { provider: "anything", model: "anything", connectionId: REAL_CONN },
  ];
  const out = filterStrictZeroCostCandidates(pool, {
    enabled: false,
    resolveFreeAccessState: () => undefined,
    ...OPTIONS,
  });
  assert.equal(out, pool);
});

test("genuine no-auth keyless candidate passes without a live quota lookup", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "fixture-keyless",
    model: "keyless-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  const resolve = () => {
    throw new Error("keyless no-auth must not query quota state");
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, keylessEntry(), resolve, OPTIONS),
    [SYNTHETIC_NOAUTH_CONNECTION_ID]
  );
});

test("quota candidate passes only with hard stop and fresh positive SAFE allowance", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "fixture-quota",
    model: "quota-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, quotaEntry(), () => safeState(), OPTIONS),
    [REAL_CONN]
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(),
      () => safeState({ status: "EXHAUSTED", remainingFreeAllowance: 0 }),
      OPTIONS
    ),
    []
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(false),
      () => safeState(),
      OPTIONS
    ),
    []
  );
  assert.deepEqual(
    evaluateCandidateConnections(
      candidate,
      quotaEntry(),
      () => safeState({ checkedAt: "2026-08-22T11:00:00.000Z" }),
      OPTIONS
    ),
    []
  );
});

test("candidate missing from free evidence is excluded", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "unknown-provider",
    model: "unknown-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, undefined, () => safeState(), OPTIONS),
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
