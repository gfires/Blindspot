import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { AgentRoleT } from "../schemas/claim";

// Your explicit model mix decision, in one place
const ROLE_MODEL: Record<AgentRoleT, ReturnType<typeof anthropic> | ReturnType<typeof openai>> = {
  historian: anthropic("claude-sonnet-5"),
  operator: anthropic("claude-sonnet-5"),
  investor: anthropic("claude-sonnet-5"),
  skeptic: openai("gpt-4o"),   // deliberately different family — genuine adversarial check
};

export function modelForRole(role: AgentRoleT) {
  return ROLE_MODEL[role];
}

export const managerModel = anthropic("claude-haiku-4-5-20251001");
export const gateModel = anthropic("claude-sonnet-5");
export const gateClassifierModel = openai("gpt-4o-mini");
// L2 evidence digest: cheap, fast model to compress each source before the committee.
export const digestModel = anthropic("claude-haiku-4-5-20251001");