import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { refine } from "@/lib/orchestration/graph";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";
import type { DebateRound } from "@/lib/orchestration/debate";
import { fakeGenResult } from "../helpers/mock-ai";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, o: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...o };
}
function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"]): DebateResponse {
  return { targetRole, stance, point: "p" };
}
function claim(role: AgentRoleT, o: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`, questionId: "q1", agentRole: role, conclusion: `${role} take`,
    confidence: 0.4, supportingEvidenceIds: [], contradictingEvidenceIds: [], missingEvidence: [],
    loopIteration: 0, debateRound: 1, responses: [], ...o,
  };
}

// Final debate round with an unresolved evidential contention: historian rebuts investor (who does
// not concede back) and the historian names a missing-evidence gap → an EVIDENTIAL fault line.
const historian = claim("historian", {
  responses: [resp("investor", "rebut")],
  missingEvidence: ["mid-market deal sizes / annual spend per firm"],
});
const investor = claim("investor");
const finalRound: DebateRound = { round: 1, claims: [historian, investor] };

function stateOf(over: Partial<ResearchStateT> = {}): ResearchStateT {
  return {
    topic: "t",
    researchBrief: fallbackBrief("t"),
    questions: [q("q1")],
    // The claims carry loopIteration 0 (the loop they were debated in); the gate has since
    // incremented state.loopIteration to 1 — the exact condition that used to make refine no-op.
    claims: [historian, investor],
    debateTranscripts: { q1: [{ round: 0, claims: [historian, investor] }, finalRound] },
    loopIteration: 1,
    evidence: [],
    answer: "",
    searchedQueries: [],
    ...over,
  } as ResearchStateT;
}

beforeEach(() => (generateText as Mock).mockReset());

describe("refine (off-by-one regression)", () => {
  it("still finds the named gaps after the gate incremented loopIteration past the claims' loop", async () => {
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ questions: [{ questionId: "q1", searchQueries: ["mid-market law firm AI review pricing"] }] }),
    );

    const out = await refine(stateOf());

    // Regression: refine previously filtered claims by === state.loopIteration (=1) while the claims
    // were tagged loop 0, found no gaps, and returned {} without ever calling the model.
    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = (generateText as Mock).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("mid-market deal sizes / annual spend per firm"); // the gap reached the prompt
    // The refined query is appended to the question's searchQueries.
    const q1 = out.questions!.find((x) => x.id === "q1")!;
    expect(q1.searchQueries).toContain("mid-market law firm AI review pricing");
  });

  it("no-ops (no LLM call) when no gaps are named", async () => {
    const noGap: DebateRound = { round: 1, claims: [claim("historian"), claim("investor")] };
    const out = await refine(
      stateOf({ debateTranscripts: { q1: [noGap] }, claims: noGap.claims }),
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });
});
