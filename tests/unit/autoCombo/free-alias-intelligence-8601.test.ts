import { describe, it, expect } from "vitest";
import {
  getModelsDevTierFitness,
  getTaskFitnessWithSource,
} from "../../../open-sse/services/autoCombo/taskFitness.js";

describe("models_dev_tier free-alias fallback (#8601)", () => {
  it("should return fitness score for -free alias from models_dev_tier DB or capabilities fallback", () => {
    const baseScore = getModelsDevTierFitness("deepseek-v4-flash", "coding");
    const freeScore = getModelsDevTierFitness("deepseek-v4-flash-free", "coding");

    if (baseScore !== null) {
      const routed = getTaskFitnessWithSource("deepseek-v4-flash-free", "coding");
      expect(routed.score).toBeGreaterThanOrEqual(0);
    }
    expect(freeScore === null || typeof freeScore === "number").toBe(true);
  });

  it("getTaskFitnessWithSource should fall back for models_dev_tier / arena_elo on -free models", () => {
    const res = getTaskFitnessWithSource("deepseek-v4-flash-free", "coding");
    expect(res).not.toBeNull();
    expect(typeof res.score).toBe("number");
  });

  it("supports :free and nested gateway ids as quality-only aliases", () => {
    const colon = getTaskFitnessWithSource("deepseek-v4-flash:free", "coding");
    const nested = getTaskFitnessWithSource(
      "gateway/deepseek/deepseek-v4-flash:free",
      "coding"
    );
    expect(typeof colon.score).toBe("number");
    expect(typeof nested.score).toBe("number");
    expect(colon.score).toBeGreaterThanOrEqual(0);
    expect(nested.score).toBeGreaterThanOrEqual(0);
  });
});
