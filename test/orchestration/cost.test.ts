import { describe, it, expect, vi } from "vitest";
import { estimateCostUsd, toAnnotatedUsage } from "@/lib/orchestration/eval";

/** claude-sonnet-5 base rates (per MODEL_COST): $2.00/1M in, $10.00/1M out. */
const SONNET_IN = 2.0;
const SONNET_OUT = 10.0;

describe("estimateCostUsd", () => {
  it("prices plain prompt/completion tokens at the base rates", () => {
    const cost = estimateCostUsd({
      model: "claude-sonnet-5",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(SONNET_IN + SONNET_OUT, 10);
  });

  it("discounts cached and cache-creation tokens by the default multipliers", () => {
    // 1M prompt = 500k uncached + 300k cached + 200k creation, plus 0 output.
    const cost = estimateCostUsd({
      model: "claude-sonnet-5",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 300_000,
      cacheCreationTokens: 200_000,
    });
    const expected =
      (500_000 / 1_000_000) * SONNET_IN +
      (300_000 / 1_000_000) * 0.1 * SONNET_IN +
      (200_000 / 1_000_000) * 1.25 * SONNET_IN;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("clamps the uncached remainder to ≥ 0 when cached + creation exceed prompt tokens", () => {
    // Over-counted cache tokens must not produce negative cost.
    const cost = estimateCostUsd({
      model: "claude-sonnet-5",
      promptTokens: 100_000,
      completionTokens: 0,
      cachedPromptTokens: 90_000,
      cacheCreationTokens: 90_000,
    });
    const expected =
      (90_000 / 1_000_000) * 0.1 * SONNET_IN +
      (90_000 / 1_000_000) * 1.25 * SONNET_IN;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns $0 and warns once for an unknown model", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const usage = {
        model: "totally-made-up-model-xyz",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      };
      expect(estimateCostUsd(usage)).toBe(0);
      // Second call for the same unknown model must not warn again.
      expect(estimateCostUsd(usage)).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("toAnnotatedUsage", () => {
  it("maps inputTokens/outputTokens and cachedInputTokens", () => {
    const annotated = toAnnotatedUsage(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 },
      "claude-sonnet-5",
      "committee",
    );
    expect(annotated.promptTokens).toBe(1_000_000);
    expect(annotated.completionTokens).toBe(0);
    expect(annotated.cachedPromptTokens).toBe(400_000);
    expect(annotated.label).toBe("committee");

    const expected =
      (600_000 / 1_000_000) * SONNET_IN +
      (400_000 / 1_000_000) * 0.1 * SONNET_IN;
    expect(annotated.costUsd).toBeCloseTo(expected, 10);
  });

  it("reads anthropic cacheCreationInputTokens from providerMetadata when passed", () => {
    const annotated = toAnnotatedUsage(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 },
      "claude-sonnet-5",
      "committee",
      { anthropic: { cacheCreationInputTokens: 250_000 } },
    );
    expect(annotated.cacheCreationTokens).toBe(250_000);

    const expected =
      (750_000 / 1_000_000) * SONNET_IN +
      (250_000 / 1_000_000) * 1.25 * SONNET_IN;
    expect(annotated.costUsd).toBeCloseTo(expected, 10);
  });

  it("leaves cacheCreationTokens undefined when providerMetadata is absent or malformed", () => {
    expect(
      toAnnotatedUsage({ inputTokens: 10, outputTokens: 5 }, "gpt-4o", "analyze")
        .cacheCreationTokens,
    ).toBeUndefined();
    expect(
      toAnnotatedUsage(
        { inputTokens: 10, outputTokens: 5 },
        "gpt-4o",
        "analyze",
        { anthropic: {} },
      ).cacheCreationTokens,
    ).toBeUndefined();
  });

  it("defaults token counts to 0 when usage is undefined", () => {
    const annotated = toAnnotatedUsage(undefined, "gpt-4o", "analyze");
    expect(annotated.promptTokens).toBe(0);
    expect(annotated.completionTokens).toBe(0);
    expect(annotated.costUsd).toBe(0);
  });
});
