import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { AgentRoleT } from "../schemas/claim";
import { ROLES } from "../roles";
import { RESEARCHER_MODEL_ID } from "../params";
import { MODEL_CATALOG, type ModelProviderT } from "./pricing";

const PROVIDER_FACTORIES: Record<ModelProviderT, (id: string) => ReturnType<typeof anthropic>> = {
  anthropic,
  openai,
  google,
};

/**
 * Resolve a model id string to its SDK model instance, purely off MODEL_CATALOG's `provider`
 * field (models/pricing.ts). Swapping or adding a model is a catalog edit, never a code change
 * here — an id missing from the catalog throws immediately (fail loud on a typo, not a silent $0
 * cost estimate downstream in eval.ts).
 */
function modelFromId(id: string) {
  const entry = MODEL_CATALOG[id];
  if (!entry) {
    throw new Error(`modelFromId: "${id}" is not in MODEL_CATALOG (models/pricing.ts) — add it there first.`);
  }
  return PROVIDER_FACTORIES[entry.provider](id);
}

/**
 * The model for a committee role. Loop 0 uses ROLES[role].model; re-debates (loopIteration > 0)
 * use ROLES[role].redebateModel. Role config lives in roles.ts.
 */
export function modelForRole(role: AgentRoleT, loopIteration = 0) {
  const id = loopIteration > 0 ? ROLES[role].redebateModel : ROLES[role].model;
  return modelFromId(id);
}

/**
 * The model for a role in a given DEBATE round (Wave 3). Round 0 is the deep opening and keeps
 * the loop-aware mix (delegates to modelForRole with the retrieval loop); conversational rounds
 * (>=1) are declining-marginal-value refinements, so every role drops to its redebateModel.
 */
export function modelForDebateRound(role: AgentRoleT, debateRound: number, loopIteration = 0) {
  if (debateRound === 0) return modelForRole(role, loopIteration);
  return modelFromId(ROLES[role].redebateModel);
}

export const managerModel = anthropic("claude-haiku-4-5-20251001");
export const gateModel = anthropic("claude-sonnet-5");
export const gateClassifierModel = openai("gpt-4o-mini");
// L2 evidence digest: cheap, fast model to compress each source before the committee.
export const digestModel = anthropic("claude-haiku-4-5-20251001");
// The agentic-retrieval researcher agent (P3): Haiku for search planning, not deep reasoning.
export const researcherModel = anthropic(RESEARCHER_MODEL_ID);