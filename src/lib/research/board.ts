/**
 * board.ts — pure, state-shaping helpers for the QuestionBoard (question-board-spec.md).
 *
 * Everything here is a pure function over data the stream already carries (Claims, GateScores,
 * Evidence, ResearcherPass) — no LLM calls, no invented scores. Components import these instead of
 * recomputing cell logic inline, so the derivation is unit-testable without a browser (per the
 * project's "reducer logic is pure and unit-testable" discipline).
 */
import type { AgentRoleT, Claim } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";
import type { GateScore } from "@/lib/research-events";
import type { GateDecision } from "@/lib/useResearchStream";
import { hasGenuineDisagreement, type CommitteeStance } from "@/lib/orchestration/debate";

/** Source count gathered on loop 0 (the Recon cell). */
export function reconCount(evidence: Evidence[]): number {
  return evidence.filter((e) => e.loopIteration === 0).length;
}

/** Index an already-scoped (one question) claim list by role, last occurrence wins. */
export function claimsByRole(claims: Claim[]): Partial<Record<AgentRoleT, Claim>> {
  const result: Partial<Record<AgentRoleT, Claim>> = {};
  for (const c of claims) result[c.agentRole] = c;
  return result;
}

/** The Openings cell's "→" resolution: no claims yet, unanimous, or a genuine split. */
export function openingResolution(claims: Claim[]): "pending" | "agree" | "split" {
  if (claims.length === 0) return "pending";
  return hasGenuineDisagreement(claims) ? "split" : "agree";
}

/** The most recent GateScore recorded for one question, scanning decisions newest-first. */
export function latestGateScoreFor(
  decisions: GateDecision[],
  questionId: string,
): GateScore | undefined {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const score = decisions[i].gateScores.find((s) => s.questionId === questionId);
    if (score) return score;
  }
  return undefined;
}

/**
 * Scope a run's GateDecisions down to one question — same shape, `gateScores`/`resolvedIds`/
 * `unresolvedIds` filtered to just that question — so the existing `GateDecisionPanel` (built for
 * the whole-run view) can be reused unchanged as the Gate drill-down (component disposition table).
 */
export function scopeGateDecisionsToQuestion(
  decisions: GateDecision[],
  questionId: string,
): GateDecision[] {
  return decisions.map((d) => ({
    ...d,
    gateScores: d.gateScores.filter((s) => s.questionId === questionId),
    resolvedIds: d.resolvedIds.filter((id) => id === questionId),
    unresolvedIds: d.unresolvedIds.filter((id) => id === questionId),
  }));
}

export type GateVerdict = "pending" | "settled" | "fault-line" | "retrieve";

/**
 * The Gate cell's route verdict — derived from the REAL gate decision (`retrieve`), not
 * re-guessed: a question the gate sent back to retrieval is "retrieve"; one it resolved is
 * "settled" unless the committee stance was `"contested"`, in which case it's a reported fault
 * line rather than a confident answer.
 */
export function gateVerdict(score: GateScore | undefined, stance: CommitteeStance): GateVerdict {
  if (!score) return "pending";
  if (score.retrieve) return "retrieve";
  return stance === "contested" ? "fault-line" : "settled";
}
