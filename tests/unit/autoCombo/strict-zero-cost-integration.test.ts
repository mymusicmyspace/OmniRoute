import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createVirtualAutoComboFromPrepared,
  type PreparedVirtualAutoComboInputs,
  type VirtualAutoComboCandidate,
} from "../../../open-sse/services/autoCombo/virtualFactory.ts";
import { MODE_PACKS } from "../../../open-sse/services/autoCombo/modePacks.ts";

function candidate(overrides: Partial<VirtualAutoComboCandidate> = {}): VirtualAutoComboCandidate {
  return {
    provider: "openrouter",
    connectionId: null,
    allowedConnectionIds: ["safe-account"],
    model: "temporary-premium-zero",
    modelStr: "openrouter/temporary-premium-zero",
    costPer1MTokens: 0,
    resolvedContextLength: 128_000,
    resolvedMaxOutputTokens: 8_192,
    resolvedSupportsVision: false,
    resolvedReasoning: true,
    resolvedSupportsThinking: true,
    zeroSpendEvidence: {
      promotional: true,
      expiresAt: "2026-08-25T00:00:00.000Z",
      kind: "effective-zero-price",
      source: "fixture-live-price+fixture-hard-stop",
    },
    ...overrides,
  };
}

test("Strict treats verified zero-cost promotions as free even when static tier classification is not free", async () => {
  const safe = candidate();
  const prepared: PreparedVirtualAutoComboInputs = {
    regularCandidates: [safe],
    familyCandidates: [safe],
    strictZeroCost: true,
  };

  const combo = await createVirtualAutoComboFromPrepared(prepared, "cheap", { tier: "free" });

  assert.deepEqual(combo.models.map((model) => model.model), ["openrouter/temporary-premium-zero"]);
  assert.deepEqual(combo.models[0]?.allowedConnectionIds, ["safe-account"]);
  assert.deepEqual(combo.weights, MODE_PACKS["quality-first"]);
});

test("Strict empty pool stays empty even when legacy full-pool fallback env flag is enabled", async () => {
  const previous = process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL;
  process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL = "true";
  try {
    const prepared: PreparedVirtualAutoComboInputs = {
      regularCandidates: [],
      familyCandidates: [],
      strictZeroCost: true,
    };

    const combo = await createVirtualAutoComboFromPrepared(prepared, "cheap", {
      category: "coding",
      tier: "free",
    });

    assert.deepEqual(combo.models, []);
    assert.deepEqual(combo.candidatePool, []);
    assert.deepEqual(combo.weights, MODE_PACKS["quality-first"]);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL;
    else process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL = previous;
  }
});

test("Strict prepared pool never reintroduces a candidate that was excluded before materialization", async () => {
  const safe = candidate();
  const unsafePaid = candidate({
    provider: "paid-provider",
    model: "paid-model",
    modelStr: "paid-provider/paid-model",
    allowedConnectionIds: ["paid-account"],
    zeroSpendEvidence: undefined,
  });

  // prepareVirtualAutoComboInputs is responsible for filtering; materialization receives
  // only the proven-safe snapshot. This regression pins that no later stage has another
  // source from which to resurrect unsafePaid.
  const prepared: PreparedVirtualAutoComboInputs = {
    regularCandidates: [safe],
    familyCandidates: [safe],
    strictZeroCost: true,
  };

  const combo = await createVirtualAutoComboFromPrepared(prepared, undefined);
  assert.deepEqual(combo.models.map((model) => model.model), [safe.modelStr]);
  assert.ok(!combo.models.some((model) => model.model === unsafePaid.modelStr));
});
