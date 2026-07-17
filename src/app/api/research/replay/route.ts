import { readFileSync } from "fs";
import { join } from "path";
import type { ResearchEvent } from "@/lib/research-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the committed replay fixture (test/fixtures/replay-events.json) — a real agentic
 * streaming run's ResearchEvent[], extracted by scripts/extract-replay-fixture.ts. The board's
 * replay path (question-board-spec.md §5) drives the SAME `reduce` the live stream uses over this
 * array; a bundled fixture keeps replay working with no live run, no keys, no cost.
 */
export async function GET() {
  const path = join(process.cwd(), "test", "fixtures", "replay-events.json");
  const events = JSON.parse(readFileSync(path, "utf8")) as ResearchEvent[];
  return Response.json(events);
}
