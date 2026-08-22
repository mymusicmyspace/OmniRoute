import { test } from "vitest";
import assert from "node:assert/strict";

import {
  evaluateZeroSpendEvidence,
  type ZeroSpendEvidence,
} from "../../../open-sse/services/autoCombo/zeroSpendEvidence.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const OPTIONS = {
  nowMs: Date.parse(NOW),
  maxAgeMs: 180_000,
  minRemainingAllowance: 1,
};

function evidence(overrides: Partial<ZeroSpendEvidence> = {}): ZeroSpendEvidence {
  return {
    status: "SAFE",
    kind: "free-quota",
    checkedAt: NOW,
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

test("missing or UNKNOWN evidence fails closed", () => {
  assert.deepEqual(evaluateZeroSpendEvidence(undefined, OPTIONS), {
    safe: false,
    reason: "usage_unknown",
  });
  assert.equal(
    evaluateZeroSpendEvidence(evidence({ status: "UNKNOWN" }), OPTIONS).reason,
    "usage_unknown"
  );
});

test("stale SAFE evidence is not reusable", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({ checkedAt: "2026-08-22T11:00:00.000Z" }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: false, reason: "evidence_stale" });
});

test("expired promotional evidence fails closed", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({
      kind: "promotional-credit",
      promotional: true,
      expiresAt: "2026-08-22T11:59:59.000Z",
    }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: false, reason: "promotion_expired" });
});

test("exhausted free allowance is rejected", () => {
  assert.equal(
    evaluateZeroSpendEvidence(
      evidence({ status: "EXHAUSTED", remainingFreeAllowance: 0 }),
      OPTIONS
    ).reason,
    "free_allowance_exhausted"
  );
  assert.equal(
    evaluateZeroSpendEvidence(evidence({ remainingFreeAllowance: 1 }), OPTIONS).reason,
    "free_allowance_exhausted"
  );
});

test("effective zero price is unsafe when paid fallback is possible", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({
      kind: "effective-zero-price",
      promotional: true,
      remainingFreeAllowance: null,
      effectiveInputPrice: 0,
      effectiveOutputPrice: 0,
      paidSpendPossible: true,
      hardStopVerified: false,
    }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: false, reason: "paid_fallback_possible" });
});

test("effective zero price with verified hard stop is SAFE", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({
      kind: "effective-zero-price",
      promotional: true,
      remainingFreeAllowance: null,
      effectiveInputPrice: 0,
      effectiveOutputPrice: 0,
      paidSpendPossible: false,
      hardStopVerified: true,
    }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: true, reason: null });
});

test("effective-zero-price evidence must actually report zero input and output prices", () => {
  assert.equal(
    evaluateZeroSpendEvidence(
      evidence({
        kind: "effective-zero-price",
        remainingFreeAllowance: null,
        effectiveInputPrice: 0,
        effectiveOutputPrice: 0.25,
      }),
      OPTIONS
    ).reason,
    "effective_price_nonzero"
  );
});

test("promotional credit is SAFE only while positive allowance remains and hard stop is verified", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({
      kind: "promotional-credit",
      promotional: true,
      remainingFreeAllowance: 25,
      paidSpendPossible: false,
      hardStopVerified: true,
    }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: true, reason: null });
});

test("quota evidence with no numeric free allowance remains UNKNOWN", () => {
  const out = evaluateZeroSpendEvidence(
    evidence({ kind: "free-quota", remainingFreeAllowance: null }),
    OPTIONS
  );
  assert.deepEqual(out, { safe: false, reason: "usage_unknown" });
});
