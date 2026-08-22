import { test } from "vitest";
import assert from "node:assert/strict";

import {
  applyStrictZeroCostRequestGuard,
  isStrictZeroCostCombo,
} from "../../../open-sse/services/autoCombo/strictZeroCostRequestGuard.ts";

test("strict OpenRouter dispatch overwrites every supported max-price dimension with zero", () => {
  const input = {
    messages: [{ role: "user", content: "hi" }],
    provider: {
      order: ["SomeProvider"],
      max_price: { prompt: 99, completion: 99 },
    },
  };
  const out = applyStrictZeroCostRequestGuard(input, "openrouter", true);

  assert.notEqual(out, input);
  assert.deepEqual(out.provider, {
    order: ["SomeProvider"],
    max_price: {
      prompt: 0,
      completion: 0,
      image: 0,
      audio: 0,
      request: 0,
    },
  });
  assert.equal(input.provider.max_price.prompt, 99, "guard must be copy-on-write");
});

test("guard is byte/reference neutral when Strict is off or provider is not OpenRouter", () => {
  const body = { messages: [] };
  assert.equal(applyStrictZeroCostRequestGuard(body, "openrouter", false), body);
  assert.equal(applyStrictZeroCostRequestGuard(body, "gemini", true), body);
});

test("strict combo marker is recognized from both config shapes", () => {
  assert.equal(
    isStrictZeroCostCombo({ config: { auto: { strictZeroCost: true } } }),
    true
  );
  assert.equal(isStrictZeroCostCombo({ autoConfig: { strictZeroCost: true } }), true);
  assert.equal(isStrictZeroCostCombo({ autoConfig: {} }), false);
});
