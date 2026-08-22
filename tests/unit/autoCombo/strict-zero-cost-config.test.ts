import { test } from "vitest";
import assert from "node:assert/strict";

import { createVirtualAutoComboFromPrepared } from "../../../open-sse/services/autoCombo/virtualFactory.ts";

test("strict prepared pools expose quality-first routing while non-strict remains unchanged", async () => {
  const candidate = {
    provider: "fixture",
    connectionId: "safe-account",
    model: "model-a",
    modelStr: "fixture/model-a",
    costPer1MTokens: 0,
  };

  const strict = await createVirtualAutoComboFromPrepared(
    { regularCandidates: [candidate], familyCandidates: [candidate], strictZeroCost: true },
    "cheap"
  );
  const normal = await createVirtualAutoComboFromPrepared(
    { regularCandidates: [candidate], familyCandidates: [candidate], strictZeroCost: false },
    "cheap"
  );

  assert.notDeepEqual(strict.weights, normal.weights);
  assert.equal(strict.models.length, 1);
  assert.equal(normal.models.length, 1);
});
