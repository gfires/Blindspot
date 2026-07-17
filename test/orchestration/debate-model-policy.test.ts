import { describe, it, expect } from "vitest";
import { modelForDebateRound, modelForRole } from "@/lib/models/provider";
import { ROLES } from "@/lib/roles";
import type { AgentRoleT } from "@/lib/schemas/claim";

const CONSTRUCTIVE: AgentRoleT[] = ["historian", "operator", "investor"];
const ALL_ROLES: AgentRoleT[] = [...CONSTRUCTIVE, "skeptic"];

describe("modelForDebateRound", () => {
  it("round 0 delegates to modelForRole (loop 0 → full mix)", () => {
    for (const role of ALL_ROLES) {
      expect(modelForDebateRound(role, 0, 0).modelId).toBe(modelForRole(role, 0).modelId);
      expect(modelForDebateRound(role, 0, 0).modelId).toBe(ROLES[role].model);
    }
  });

  it("round 0 stays loop-aware (re-debate loop → REDEBATE mix)", () => {
    for (const role of ALL_ROLES) {
      expect(modelForDebateRound(role, 0, 1).modelId).toBe(ROLES[role].redebateModel);
    }
  });

  it("every role drops to its REDEBATE_ROLE_MODEL_IDS entry at conversational round 1+", () => {
    for (const role of ALL_ROLES) {
      const id = modelForDebateRound(role, 1).modelId;
      expect(id).toBe(ROLES[role].redebateModel);
    }
    // The one role with a real downgrade available (investor: Sonnet → Haiku) actually uses it.
    expect(modelForDebateRound("investor", 1).modelId).toContain("haiku");
  });

  it("skeptic stays on its cross-family model at every round (no staging left to do)", () => {
    expect(modelForDebateRound("skeptic", 1).modelId).toBe("gemini-3.1-flash-lite");
    expect(modelForDebateRound("skeptic", 2).modelId).toBe("gemini-3.1-flash-lite");
    expect(modelForDebateRound("skeptic", 5).modelId).toBe("gemini-3.1-flash-lite");
  });
});
