import { describe, it, expect } from "vitest";
import { opportunityScore, severityWord, OPPORTUNITY_WEIGHTS } from "@/lib/scoring";
import type { Scores } from "@/lib/schema";

/** Build a Scores object with the same value for every dimension (test helper). */
function scoresOf(v: number, overrides: Partial<Record<keyof Scores, number>> = {}): Scores {
  const mk = (val: number) => ({ value: val, label: "", reason: "" });
  return {
    pain: mk(overrides.pain ?? v),
    softwareMaturity: mk(overrides.softwareMaturity ?? v),
    founderAccessibility: mk(overrides.founderAccessibility ?? v),
    aiSuitability: mk(overrides.aiSuitability ?? v),
    budgetSignal: mk(overrides.budgetSignal ?? v),
  };
}

describe("opportunityScore", () => {
  it("weights sum to 1", () => {
    const sum = Object.values(OPPORTUNITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("stays within 0–100", () => {
    for (let v = 0; v <= 10; v++) {
      const s = opportunityScore(scoresOf(v));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it("mature software LOWERS opportunity (inverted dimension)", () => {
    const base = scoresOf(5);
    const immature = opportunityScore({ ...base, softwareMaturity: { value: 1, label: "", reason: "" } });
    const mature = opportunityScore({ ...base, softwareMaturity: { value: 9, label: "", reason: "" } });
    expect(immature).toBeGreaterThan(mature);
  });

  it("more pain RAISES opportunity", () => {
    const base = scoresOf(5);
    const low = opportunityScore({ ...base, pain: { value: 1, label: "", reason: "" } });
    const high = opportunityScore({ ...base, pain: { value: 9, label: "", reason: "" } });
    expect(high).toBeGreaterThan(low);
  });

  it("a maximally ripe industry scores very high", () => {
    // High pain, low software maturity, high labor scarcity/AI/budget.
    const ripe = scoresOf(10, { softwareMaturity: 0 });
    expect(opportunityScore(ripe)).toBe(100);
  });
});

describe("severityWord", () => {
  it("maps ranges to words", () => {
    expect(severityWord(9)).toBe("Severe");
    expect(severityWord(7.5)).toBe("High");
    expect(severityWord(5)).toBe("Moderate");
    expect(severityWord(3)).toBe("Mild");
    expect(severityWord(0)).toBe("Low");
  });
});

