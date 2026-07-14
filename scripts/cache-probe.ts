/**
 * scripts/cache-probe.ts — THROWAWAY live diagnostic for cross-round Anthropic prompt caching.
 *
 * NOT part of the shipped pipeline. It isolates the committee/debate caching mechanism with two
 * cheap sequential `generateText` calls (a few cents) so we can confirm empirically — not by unit
 * test — that the fix in committee.ts (a cache breakpoint at the STABLE head boundary, not just the
 * moving tail) actually produces cross-round cache READS.
 *
 * It runs the mechanism BOTH ways for a direct before/after:
 *   A) BROKEN — one system message (head+tail) with a single trailing cacheControl. Call 2's system
 *      = call 1's system + an appended paragraph. This is the pre-fix structure. Expectation: call 2
 *      does NOT read the head from cache (nothing cached at the head boundary), so cacheRead ≈ 0.
 *   B) FIXED — head and tail as two consecutive system blocks, each with its own cacheControl
 *      (exactly what cacheableSystemMessages emits). Call 2 shares call 1's head block byte-for-byte.
 *      Expectation: call 2 READS the whole head from cache (large cacheRead) and only WRITES the tail.
 *
 * Usage:  npx tsx scripts/cache-probe.ts     (needs .env.local ANTHROPIC_API_KEY)
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Load .env.local the same way scripts/run-arm.ts does.
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

import { generateText, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const model = anthropic("claude-sonnet-5");
const CC = { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } };

// The prompt cache is a byte-exact prefix match with a 5-minute TTL, so repeated runs (and the two
// scenarios within one run) MUST use distinct content or a warm cache masks the difference. Prefix
// every head with a unique nonce; give scenarios A and B their own nonce so B can't read what A wrote.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// A big "evidence + calibration" head — comfortably above Sonnet's ~2048-token cacheable minimum.
function head(nonce: string): string {
  return (
    `PROBE-RUN ${RUN}-${nonce}\n` +
    "RESEARCH OBJECTIVE — decide go/no-go on the freight brokerage bet.\n\n" +
    "EVIDENCE — cite only by bracketed id:\n" +
    Array.from(
      { length: 220 },
      (_, i) =>
        `[e${i}] Source ${i}: freight brokerage margins, load-board dynamics, carrier churn, ` +
        `and the operational friction an outsider misses when quoting a lane. Detail line ${i}.`,
    ).join("\n") +
    "\n\nCONFIDENCE CALIBRATION — earn confidence from evidence; anchor low; penalize sparsity."
  );
}

// The per-round transcript delta that gets appended for call 2.
const TAIL =
  "\n\nDEBATE SO FAR (all prior rounds):\n" +
  Array.from({ length: 40 }, (_, i) => `Round 0 — historian: precedent point ${i} [e${i}].`).join("\n");

const USER: ModelMessage = { role: "user", content: "Reply with the single word: ACK." };

type Usage = Awaited<ReturnType<typeof generateText>>["usage"];
function cacheOf(usage: Usage) {
  // AI SDK v7 surfaces Anthropic cache activity on usage.inputTokenDetails.
  const d = (usage as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } })
    .inputTokenDetails ?? {};
  return { inputTokens: usage.inputTokens ?? 0, cacheRead: d.cacheReadTokens ?? 0, cacheWrite: d.cacheWriteTokens ?? 0 };
}

async function call(label: string, system: ModelMessage[]) {
  const { usage } = await generateText({
    model,
    messages: [...system, USER],
    allowSystemInMessages: true,
    maxRetries: 2,
  });
  const c = cacheOf(usage);
  console.log(
    `  ${label.padEnd(24)} input=${c.inputTokens}  cacheRead=${c.cacheRead}  cacheWrite=${c.cacheWrite}`,
  );
  return c;
}

async function main() {
  const headA = head("A");
  const headB = head("B");

  console.log("\n=== A) BROKEN: single trailing breakpoint on head+tail ===");
  // Call 1: head only, single block, trailing cacheControl.
  await call("call 1 (head)", [{ role: "system", content: headA, ...CC }]);
  // Call 2: head+tail as ONE block, trailing cacheControl (the pre-fix structure).
  const aRead = await call("call 2 (head+tail)", [{ role: "system", content: headA + TAIL, ...CC }]);

  console.log("\n=== B) FIXED: head block + tail block, each its own breakpoint ===");
  // Call 1: head block only (mirrors committee round 0).
  await call("call 1 (head)", [{ role: "system", content: headB, ...CC }]);
  // Call 2: head block (byte-identical) + tail block, each cacheControl (mirrors debate round 1).
  const bRead = await call("call 2 (head|tail)", [
    { role: "system", content: headB, ...CC },
    { role: "system", content: TAIL, ...CC },
  ]);

  console.log("\n=== verdict ===");
  console.log(`  A call-2 cacheRead: ${aRead.cacheRead}  (single trailing breakpoint — pre-fix)`);
  console.log(`  B call-2 cacheRead: ${bRead.cacheRead}  (stable-head breakpoint — the fix)`);
  const ok = Number(bRead.cacheRead) > Number(aRead.cacheRead);
  console.log(
    ok
      ? "  ✅ The stable-head breakpoint yields a large cross-round cacheRead the single trailing breakpoint does not."
      : "  ⚠️  No improvement observed — investigate.",
  );
}

main().catch((err) => {
  console.error("cache-probe failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
