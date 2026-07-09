/**
 * app/api/research/baseline/route.ts — the baseline (single-prompt) arm as a REST endpoint.
 *
 * FOR FUTURE AGENTS: This is the same pipeline as scan/route.ts (explore → callLLM →
 * assembleReport) but returned as a plain JSON response instead of a streaming SSE feed.
 * It exists so the compare script and other callers can hit it over HTTP when they need
 * a running server, or call runBaseline() directly from the lib for script/test use.
 *
 * Request:  POST { "topic": string }
 * Response: ArmResult JSON (see src/lib/orchestration/eval.ts)
 */
import { runBaseline } from "@/lib/orchestration/eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { topic?: string };
  const topic = body.topic?.trim() ?? "";

  if (!topic) {
    return Response.json({ error: "topic is required" }, { status: 400 });
  }

  try {
    const result = await runBaseline(topic);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error during baseline scan.";
    return Response.json({ error: message }, { status: 500 });
  }
}
