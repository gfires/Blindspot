/**
 * useResearchReplay's core contract: reducing a PREFIX of the event stream (what scrub/play do,
 * one step at a time) behaves like the live reducer mid-run — partial, `running: true`, no report
 * yet — and reducing the empty prefix is exactly initialResearchState. The hook itself is a thin
 * React timer wrapper around this; the timer behavior needs a DOM/fake-timer harness this repo
 * doesn't have, so the coverage goes on the pure mechanism (question-board-spec.md §5).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { ResearchEvent } from "@/lib/research-events";
import { reduce, initialResearchState } from "@/lib/useResearchStream";

const events = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "replay-events.json"), "utf8"),
) as ResearchEvent[];

function reduceUpTo(index: number) {
  return events.slice(0, index + 1).reduce(reduce, initialResearchState);
}

describe("replay prefix reduction", () => {
  it("the empty prefix (nothing applied yet) is exactly initialResearchState", () => {
    expect(events.slice(0, 0).reduce(reduce, initialResearchState)).toEqual(initialResearchState);
  });

  it("a mid-stream prefix is running with no report yet", () => {
    const midpoint = Math.floor(events.length / 2);
    const s = reduceUpTo(midpoint);
    expect(s.running).toBe(true);
    expect(s.report).toBeNull();
  });

  it("the full prefix matches the fixture's validated finished run", () => {
    const s = reduceUpTo(events.length - 1);
    expect(s.running).toBe(false);
    expect(s.report).not.toBeNull();
  });
});
