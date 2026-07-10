import { generateObject } from "ai";
import { z } from "zod";
import { gateClassifierModel } from "../models/provider";
import type { ResearchStateT } from "../schemas/state";
import { MAX_LOOP_ITERATIONS } from "../params";
import { toAnnotatedUsage, type AnnotatedUsage } from "./eval";
import type { GateScore } from "../research-events";

const GateDecisionSchema = z.object({
  decisions: z.array(z.object({
    questionId: z.string(),
    retrieve: z.boolean(),
    reason: z.string(),
  })),
});

export async function allocateBudget(
  state: ResearchStateT
): Promise<{ state: ResearchStateT; continueLoop: boolean; usage: AnnotatedUsage[]; gateScores: GateScore[] }> {
  if (state.budgetRemaining <= 0 || state.loopIteration >= MAX_LOOP_ITERATIONS) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: [], gateScores: [] };
  }

  const unresolved = state.questions.filter(q => !q.resolved);

  const questionSignals = unresolved.map(q => {
    const claims = state.claims.filter(c => c.questionId === q.id);
    const confidences = claims.map(c => c.confidence);
    const gapCount = claims.reduce((sum, c) => sum + c.missingEvidence.length, 0);
    const confidenceSpread = confidences.length >= 2
      ? Math.max(...confidences) - Math.min(...confidences)
      : 0;

    const claimSummary = claims.length
      ? claims.map(c => `  - [${c.agentRole}] "${c.conclusion}" (confidence: ${c.confidence.toFixed(2)}, gaps: ${c.missingEvidence.length})`).join("\n")
      : "  - no claims yet";

    return { question: q, gapCount, confidenceSpread, claimSummary };
  });

  const sections = questionSignals.map(qs =>
    `Question ${qs.question.id} (${qs.question.category}): ${qs.question.text}\n` +
    `  Computed: gapCount=${qs.gapCount}, confidenceSpread=${qs.confidenceSpread.toFixed(2)}\n` +
    `  Claims:\n${qs.claimSummary}`
  );

  const prompt = `You are a research gate classifier deciding which questions need more evidence retrieval.

Current state: loop iteration ${state.loopIteration}, budget remaining ${state.budgetRemaining} calls.

Decision rules (apply in order):
- If this is iteration 0 (first pass): default to YES unless agents already agree directionally and no specific evidence gaps are named.
- If 3+ agents name overlapping missing evidence (similar data/sources): YES.
- If agents reach opposing conclusions on the same sub-question: YES.
- If all agents agree directionally and gaps are vague ("more data would help"): NO.
- If budget remaining is low (≤2 calls): only YES for the single highest-gap question.

For each question, decide: should we retrieve more evidence (true) or mark as resolved (false)?
Explain your decision in one sentence per question.

${sections.join("\n\n")}

Return a decision for every question ID listed above.`;

  const { object, usage } = await generateObject({
    model: gateClassifierModel,
    schema: GateDecisionSchema,
    prompt,
  });
  const callUsage = [toAnnotatedUsage(usage, gateClassifierModel.modelId, "gate")];

  const signalMap = new Map(questionSignals.map(qs => [qs.question.id, qs]));

  const gateScores: GateScore[] = object.decisions.map(d => ({
    questionId: d.questionId,
    retrieve: d.retrieve,
    gapCount: signalMap.get(d.questionId)?.gapCount ?? 0,
    confidenceSpread: signalMap.get(d.questionId)?.confidenceSpread ?? 0,
    reason: d.reason,
  }));

  const continueLoop = gateScores.some(d => d.retrieve);

  if (!continueLoop) {
    return { state: { ...state, converged: true }, continueLoop: false, usage: callUsage, gateScores };
  }

  const questions = state.questions.map(q => {
    const score = gateScores.find(s => s.questionId === q.id);
    return score && !score.retrieve ? { ...q, resolved: true } : q;
  });

  return {
    state: { ...state, questions, loopIteration: state.loopIteration + 1 },
    continueLoop: true,
    usage: callUsage,
    gateScores,
  };
}
