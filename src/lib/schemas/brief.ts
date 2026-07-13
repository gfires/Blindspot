import { z } from "zod";

/**
 * brief.ts — the ResearchBrief: the intake node's reading of whatever came in.
 *
 * The pipeline is input-structure-agnostic. Rather than hardcode one shape (broad industry,
 * open survey), the manager reads the shape of the actual input — a bare phrase, a sharper
 * niche, a specific thesis, an investment decision — into ONE small, general brief, and the
 * downstream nodes (decompose, committee, synthesis) adapt their altitude to it.
 *
 * The whole design branches on NOTHING: there is no intent/posture enum (that would just move
 * the hardcoding we're removing). `objective` is real LLM-inferred TEXT that everything
 * downstream reads — it is the load-bearing field.
 *
 * NOTE: no .min()/.max() on this LLM-output schema — providers strip unsupported JSON-schema
 * keywords, so they never fire during generation and only cause client-side generation errors
 * when the model drifts past them. Steer with .describe() and clamp counts in code (the intake
 * node clamps `constraints`).
 */
export const ResearchBriefSchema = z.object({
  subject: z
    .string()
    .describe(
      "the entity or space under study — what to search ABOUT. A short noun phrase, e.g. " +
        '"freight brokerage" or "AI-native contract review for mid-market law firms".',
    ),
  objective: z
    .string()
    .describe(
      "ONE statement of what output would satisfy this input, in the product's terms " +
        "(opportunity/market analysis, not open-ended research): a coverage map of the landscape, " +
        "a comparison, a go/no-go on a specific bet, a verdict on a thesis. For a bare phrase this is " +
        'a survey objective (e.g. "Survey the opportunity landscape in freight brokerage"); for a ' +
        "thesis or decision it restates the actual ask. This field is load-bearing — every downstream " +
        "node reads it.",
    ),
  constraints: z
    .array(z.string())
    .describe(
      "explicit scope boundaries, requirements, or decision criteria the INPUT stated (budget, " +
        "geography, timeframe, buyer segment, the specific claim to test). Empty for a bare phrase — " +
        "do not invent constraints the input did not state.",
    ),
});

export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

/**
 * The degrade-path brief: a bare survey of `topic`, no constraints. Used when intake fails so
 * a run never dies on a bad brief — mirrors the digest node's degrade-to-raw behavior.
 */
export function fallbackBrief(topic: string): ResearchBrief {
  return {
    subject: topic,
    objective: `Assess the opportunity in ${topic}`,
    constraints: [],
  };
}

/** An empty brief (empty subject) — the state channel's default before intake has run. */
export const EMPTY_BRIEF: ResearchBrief = fallbackBrief("");
