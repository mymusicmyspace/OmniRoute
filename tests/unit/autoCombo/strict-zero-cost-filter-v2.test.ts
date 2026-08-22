import { test } from "vitest";
import assert from "node:assert/strict";

import {
  filterStrictZeroCostCandidates,
  type StrictZeroCostCandidate,
} from "../../../open-sse/services/autoCombo/strictZeroCostFilter.ts";
import type { ZeroSpendEvidence } from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";
import type { FreeModelBudget } from "../../../open-sse/config/freeModelCatalog.ts";

const NOW = "2026-08-22T12:00:00.000Z";

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

function safeEvidence(overrides: Partial<ZeroSpendEvidence> = {}): ZeroSpendEvidence {
  return {
    status: "SAFE",
    kind: "free-quota",
    checkedAt: NOW,
    expiresAt: null,
    remainingFreeAllowance: 40,
    effectiveInputPrice: null,
    effectiveOutputPrice: null,
    paidSpendPossible: false,
    hardStopVerified: true,
    source: "fixture",
    promotional: false,
    ...overrides,
  };
}

test("credentialed Strict filtering evaluates typed evidence for the concrete model/account", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: null,
    allowedConnectionIds: ["A", "B"],
  };
  const seen: string[] = [];
  const out = filterStrictZeroCostCandidates([candidate], {
    enabled: true,
    resolveZeroSpendEvidence: (provider, connectionId, model) => {
      seen.push(`${provider}/${model}@${connectionId}`);
      return connectionId === "A" ? safeEvidence() : undefined;
    },
    minRemainingAllowance: 1,
    maxEvidenceAgeMs: 180_000,
    catalog: [quotaEntry()],
    now: () => Date.parse(NOW),
  });
  assert.deepEqual(out[0].allowedConnectionIds, ["A"]);
  assert.deepEqual(seen, ["qp/qp-model@A", "qp/qp-model@B"]);
});

test("typed evidence rejects a zero-price promo that could spill into paid billing", () => {
  const candidate: StrictZeroCostCandidate = {
    provider: "qp",
    model: "qp-model",
    connectionId: "A",
  };
  const out = filterStrictZeroCostCandidates([candidate], {
    enabled: true,
    resolveZeroSpendEvidence: () =>
      safeEvidence({
        kind: "effective-zero-price",
        promotional: true,
        remainingFreeAllowance: null,
        effectiveInputPrice: 0,
        effectiveOutputPrice: 0,
        paidSpendPossible: true,
        hardStopVerified: false,
      }),
    minRemainingAllowance: 1,
    maxEvidenceAgeMs: 180_000,
    catalog: [quotaEntry()],
    now: () => Date.parse(NOW),
  });
  assert.deepEqual(out, []);
});
