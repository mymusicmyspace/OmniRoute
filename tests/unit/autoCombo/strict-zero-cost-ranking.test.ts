import { test } from "vitest";
import assert from "node:assert/strict";

import { qualityAliasCandidates } from "../../../open-sse/services/autoCombo/modelQualityAlias.ts";
import { promotionUrgencyMultiplier } from "../../../open-sse/services/autoCombo/promotionUrgency.ts";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function adjusted(quality: number, promotional: boolean, expiresAt: string | null): number {
  return quality * promotionUrgencyMultiplier({ promotional, expiresAt, nowMs: NOW });
}

test("materially stronger permanent-free quality beats a weak promotion", () => {
  assert.ok(adjusted(0.95, false, null) > adjusted(0.55, true, "2026-08-22T18:00:00.000Z"));
});

test("near-equal quality may prefer a promotion while it is available", () => {
  assert.ok(adjusted(0.92, true, "2026-08-22T18:00:00.000Z") > adjusted(0.91, false, null));
});

test("near-expiry promotion gets at least as much urgency as unknown-expiry promotion", () => {
  const near = promotionUrgencyMultiplier({
    promotional: true,
    expiresAt: "2026-08-22T18:00:00.000Z",
    nowMs: NOW,
  });
  const unknown = promotionUrgencyMultiplier({ promotional: true, expiresAt: null, nowMs: NOW });
  assert.ok(near >= unknown);
  assert.ok(near <= 1.08);
});

test("permanent free receives no promotion boost", () => {
  assert.equal(promotionUrgencyMultiplier({ promotional: false, expiresAt: null, nowMs: NOW }), 1);
});

test("quality aliases strip free markers without changing the concrete economic identity", () => {
  assert.deepEqual(qualityAliasCandidates("mimo-v2.5-free"), ["mimo-v2.5-free", "mimo-v2.5"]);
  assert.deepEqual(qualityAliasCandidates("deepseek-v4-flash:free"), [
    "deepseek-v4-flash:free",
    "deepseek-v4-flash",
  ]);
  assert.deepEqual(qualityAliasCandidates("gateway/deepseek/deepseek-v4-flash:free"), [
    "gateway/deepseek/deepseek-v4-flash:free",
    "gateway/deepseek/deepseek-v4-flash",
    "deepseek-v4-flash",
  ]);
});
