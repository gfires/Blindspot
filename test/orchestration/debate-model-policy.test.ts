import { describe, it, expect } from "vitest";
import { modelForDebateRound, modelForRole } from "@/lib/models/provider";
import {
  ROLE_MODEL_IDS,
  REDEBATE_ROLE_MODEL_IDS,
  DEBATE_SKEPTIC_STRONG_ROUNDS,
} from "@/lib/params";
import type { AgentRoleT } from "@/lib/schemas/claim";

const CONSTRUCTIVE: AgentRoleT[] = ["historian", "operator", "investor"];

describe("modelForDebateRound", () => {
  it("round 0 delegates to modelForRole (loop 0 → full mix)", () => {
    for (const role of [...CONSTRUCTIVE, "skeptic"] as AgentRoleT[]) {
      expect(modelForDebateRound(role, 0, 0).modelId).toBe(modelForRole(role, 0).modelId);
      expect(modelForDebateRound(role, 0, 0).modelId).toBe(ROLE_MODEL_IDS[role]);
    }
  });

  it("round 0 stays loop-aware (re-debate loop → Haiku trio)", () => {
    for (const role of CONSTRUCTIVE) {
      expect(modelForDebateRound(role, 0, 1).modelId).toBe(REDEBATE_ROLE_MODEL_IDS[role]);
    }
  });

  it("constructive roles drop to the redebate Haiku at round 1", () => {
    for (const role of CONSTRUCTIVE) {
      const id = modelForDebateRound(role, 1).modelId;
      expect(id).toBe(REDEBATE_ROLE_MODEL_IDS[role]);
      expect(id).toContain("haiku");
    }
  });

  it("skeptic stays gpt-4o through the strong rounds, then drops to gpt-4o-mini", () => {
    // DEBATE_SKEPTIC_STRONG_ROUNDS = 2: rounds 1,2 → gpt-4o; round 3 → gpt-4o-mini.
    expect(modelForDebateRound("skeptic", 1).modelId).toBe("gpt-4o");
    expect(modelForDebateRound("skeptic", DEBATE_SKEPTIC_STRONG_ROUNDS).modelId).toBe("gpt-4o");
    expect(modelForDebateRound("skeptic", DEBATE_SKEPTIC_STRONG_ROUNDS + 1).modelId).toBe("gpt-4o-mini");
  });
});
