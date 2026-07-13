import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { AgentRoleT } from "../schemas/claim";
import { ROLE_MODEL_IDS, REDEBATE_ROLE_MODEL_IDS, DEBATE_SKEPTIC_STRONG_ROUNDS } from "../params";

/** Resolve a model id string to its SDK model instance (OpenAI for gpt-*, else Anthropic). */
function modelFromId(id: string) {
  return id.startsWith("gpt") ? openai(id) : anthropic(id);
}

/**
 * The model for a committee role. Loop 0 uses the full mix (ROLE_MODEL_IDS); re-debates
 * (loopIteration > 0) use REDEBATE_ROLE_MODEL_IDS — Haiku for the three analytical roles,
 * gpt-4o for the skeptic. Both maps live in params.ts.
 */
export function modelForRole(role: AgentRoleT, loopIteration = 0) {
  const ids = loopIteration > 0 ? REDEBATE_ROLE_MODEL_IDS : ROLE_MODEL_IDS;
  return modelFromId(ids[role]);
}

/**
 * The model for a role in a given DEBATE round (Wave 3). Heavy models are spent sparingly: round 0
 * is the deep opening and keeps the loop-aware mix (delegates to modelForRole with the retrieval
 * loop); conversational rounds (>=1) are declining-marginal-value refinements, so the three
 * constructive roles drop to the redebate Haiku (REDEBATE_ROLE_MODEL_IDS) and the skeptic stays
 * cross-family on gpt-4o only through DEBATE_SKEPTIC_STRONG_ROUNDS, then drops to gpt-4o-mini (by the
 * late rounds we're closing, not breaking ground). Every id returned exists in eval.ts MODEL_COST.
 */
export function modelForDebateRound(role: AgentRoleT, debateRound: number, loopIteration = 0) {
  if (debateRound === 0) return modelForRole(role, loopIteration);
  if (role === "skeptic") {
    return modelFromId(debateRound <= DEBATE_SKEPTIC_STRONG_ROUNDS ? "gpt-4o" : "gpt-4o-mini");
  }
  return modelFromId(REDEBATE_ROLE_MODEL_IDS[role]);
}

export const managerModel = anthropic("claude-haiku-4-5-20251001");
export const gateModel = anthropic("claude-sonnet-5");
export const gateClassifierModel = openai("gpt-4o-mini");
// L2 evidence digest: cheap, fast model to compress each source before the committee.
export const digestModel = anthropic("claude-haiku-4-5-20251001");