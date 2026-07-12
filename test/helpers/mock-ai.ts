/**
 * mock-ai.ts — reusable helpers for the handful of node-level tests that need a mocked
 * `generateText`. The vast majority of this repo's tests are pure-function tests and need
 * none of this; reach for these helpers only when a test drives a graph/committee/gate node
 * that would otherwise make a live LLM call.
 *
 * PER-TEST-FILE PATTERN. `vi.mock` is hoisted to the top of the file it appears in, so each
 * test file that wants a mocked SDK must declare the mock itself — it can't be centralized
 * here. Paste this block at the top of the test file (below the imports is fine; Vitest
 * hoists it):
 *
 *   vi.mock("ai", async () => {
 *     const actual = await vi.importActual<typeof import("ai")>("ai");
 *     return { ...actual, generateText: vi.fn() };
 *   });
 *
 * Notes on why this shape is safe:
 *   - `Output.object` (and everything else in "ai") stays REAL via `importActual` — only
 *     `generateText` is replaced, so schema wiring still validates exactly as in production.
 *   - Model instances (Anthropic/OpenAI clients from provider.ts) are safe to construct
 *     without API keys: the SDK reads keys lazily at call time, and the call itself is mocked,
 *     so nothing ever hits the network.
 *
 * Then, inside a test, program the mock's return value with `fakeGenResult`:
 *
 *   import { generateText } from "ai";
 *   (generateText as Mock).mockResolvedValue(fakeGenResult(myOutput, { inputTokens: 10, outputTokens: 5 }));
 */
import { expect, vi } from "vitest";
import { generateText } from "ai";

/**
 * Token usage as the AI SDK v7 reports it on a `generateText` result. All fields optional to
 * mirror providers that omit some counts; `toAnnotatedUsage` reads `inputTokens`/`outputTokens`.
 */
export interface FakeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/**
 * Build a fake `generateText` result shaped exactly like what call sites destructure:
 * `const { output, usage } = await generateText(...)`. Pass it to `mockResolvedValue`.
 * `usage` defaults to a zeroed object so `usage` is always present on the result.
 */
export function fakeGenResult<T>(
  output: T,
  usage: FakeUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
): { output: T; usage: FakeUsage } {
  return { output, usage };
}

/**
 * Assert the mocked `generateText` was never invoked — for tests that should resolve a node
 * without spending any LLM budget. Requires the file to have installed the `vi.mock("ai", …)`
 * block above; throws a pointed error if it didn't.
 */
export function assertNoLlmCalls(): void {
  if (!vi.isMockFunction(generateText)) {
    throw new Error(
      'assertNoLlmCalls: generateText is not mocked. Add the vi.mock("ai", …) block ' +
        "(see the header comment in test/helpers/mock-ai.ts) to this test file.",
    );
  }
  expect(generateText).not.toHaveBeenCalled();
}
