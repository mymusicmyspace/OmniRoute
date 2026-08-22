import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateCandidateConnections,
  filterStrictZeroCostCandidates,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = { minRemainingAllowance: 1, maxEvidenceAgeMs: 180_000, now: () => Date.parse(NOW) };
const REAL_CONN = "real-connection-42";

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

function keylessEntry(): FreeModelBudget {
  return {
    provider: "kp",
    modelId: "kp-model",
    displayName: "kp-model",
    monthlyTokens: 0,
    creditTokens: 0,
    freeType: "keyless",
    poolKey: null,
    tos: "ok",
  };
}

function quotaEntry(): FreeModelBudget {
  return {
    provider: "qp",
    modelId: "qp-model",
    displayName: "qp-model",
    monthlyTokens: 1_000_000,
    creditTokens: 0,
    freeType: "recurring-daily",
    poolKey: null,
    tos: "ok",
    hardStopGuaranteed: true,
  };
}

test("credentialed access never inherits the keyless shortcut", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "kp",
    model: "kp-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, keylessEntry(), () => undefined, OPTIONS),
    []
  );
});

test("credentialed keyless-catalogued access may pass only with independent typed evidence", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "kp",
    model: "kp-model",
    connectionId: REAL_CONN,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, keylessEntry(), () => safeEvidence(), OPTIONS),
    [REAL_CONN]
  );
});

test("non-keyless metadata on the synthetic no-auth path fails closed", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
  };
  assert.deepEqual(
    evaluateCandidateConnections(candidate, quotaEntry(), () => safeEvidence(), OPTIONS),
    []
  );
});

test("multi-account candidate keeps exactly the verified SAFE subset", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: null,
    allowedConnectionIds: ["A", "B", "C"],
  };
  const result = filterStrictZeroCostCandidates([candidate], {
    enabled: true,
    resolveZeroSpendEvidence: (_provider, connectionId) =>
      connectionId === "B" ? safeEvidence() : undefined,
    catalog: [quotaEntry()],
    ...OPTIONS,
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].allowedConnectionIds, ["B"]);
  assert.equal(result[0].allowedConnectionIds?.includes("A"), false);
  assert.equal(result[0].allowedConnectionIds?.includes("C"), false);
});

test("EXHAUSTED account is removed while another SAFE account remains", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: null,
    allowedConnectionIds: ["A", "B"],
  };
  const safe = evaluateCandidateConnections(
    candidate,
    quotaEntry(),
    (_provider, connectionId) =>
      connectionId === "A"
        ? safeEvidence({ status: "EXHAUSTED", remainingFreeAllowance: 0 })
        : safeEvidence(),
    OPTIONS
  );
  assert.deepEqual(safe, ["B"]);
});

test("unchanged verified allowlist preserves array and candidate identity", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: null,
    allowedConnectionIds: ["A"],
  };
  const pool = [candidate];
  const result = filterStrictZeroCostCandidates(pool, {
    enabled: true,
    resolveZeroSpendEvidence: () => safeEvidence(),
    catalog: [quotaEntry()],
    ...OPTIONS,
  });
  assert.equal(result, pool);
  assert.equal(result[0], candidate);
});

test("all UNKNOWN accounts drop the logical candidate entirely", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: null,
    allowedConnectionIds: ["A", "B"],
  };
  assert.deepEqual(
    filterStrictZeroCostCandidates([candidate], {
      enabled: true,
      resolveZeroSpendEvidence: () => undefined,
      catalog: [quotaEntry()],
      ...OPTIONS,
    }),
    []
  );
});
