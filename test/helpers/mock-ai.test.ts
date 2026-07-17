import { describe, it, expect, vi } from "vitest";
import { generateText } from "ai";
import { fakeGenResult, assertNoLlmCalls } from "./mock-ai";
import { toAnnotatedUsage } from "@/lib/orchestration/eval";

// Per-file mock: only generateText is faked; Output.object and the rest of "ai" stay real.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

describe("fakeGenResult", () => {
  it("round-trips a fake usage through toAnnotatedUsage", () => {
    const { output, usage } = fakeGenResult(
      { verdict: "ok" },
      { inputTokens: 120, outputTokens: 40, cachedInputTokens: 100 },
    );
    expect(output).toEqual({ verdict: "ok" });

    const annotated = toAnnotatedUsage(usage, "claude-sonnet-5", "smoke");
    expect(annotated.model).toBe("claude-sonnet-5");
    expect(annotated.label).toBe("smoke");
    expect(annotated.promptTokens).toBe(120);
    expect(annotated.completionTokens).toBe(40);
    // claude-sonnet-5: $2/M in, $10/M out. Of 120 prompt tokens, 100 are cached
    // (billed at the 0.1× read multiplier), leaving 20 uncached; plus 40 output.
    expect(annotated.costUsd).toBeCloseTo(20e-6 * 2 + 100e-6 * 0.1 * 2 + 40e-6 * 10, 12);
  });

  it("defaults usage to zeros when omitted", () => {
    const { usage } = fakeGenResult("hello");
    const annotated = toAnnotatedUsage(usage, "gpt-4o", "empty");
    expect(annotated.promptTokens).toBe(0);
    expect(annotated.completionTokens).toBe(0);
    expect(annotated.costUsd).toBe(0);
  });
});

describe("assertNoLlmCalls", () => {
  it("passes when the mocked generateText is never called", () => {
    expect(vi.isMockFunction(generateText)).toBe(true);
    expect(() => assertNoLlmCalls()).not.toThrow();
  });
});
