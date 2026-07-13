/**
 * debate.ts — the committee debate (Wave 3).
 *
 * The committee is a REAL debate, not a parallel poll: over a FROZEN evidence snapshot, each role
 * renders an independent opening claim (round 0), then across conversational rounds reads its peers'
 * positions and the challenges aimed at it and revises — conceding ONLY to evidence, never to
 * consensus. The debate runs until positions stop moving (a mechanical movement signal, never a
 * self-reported "I've converged") or a hard round cap, and skips entirely when the opening round
 * already agrees. Evidence never changes mid-debate; only the outer retrieval loop adds evidence.
 *
 * This module owns the debate's types and (from D1 on) its pure logic — consensus detection,
 * round-over-round movement, directed challenges, transcript rendering, and contention extraction.
 * Everything here is computed from data the committee already produces (confidences, cited-id sets,
 * response stances); nothing invents a score.
 */
import type { AgentRoleT, Claim } from "../schemas/claim";

/** One conversational round: every participating role's claim for that round. */
export interface DebateRound {
  round: number; // 0 = independent opening; >=1 = conversational
  claims: Claim[]; // one per role; each carries its `responses` (edges to peers)
}

/**
 * A disagreement that survived the debate. `type` decides routing at the gate:
 * - "evidential": a contested claim names missing evidence that could settle it → worth retrieval.
 * - "interpretive": the roles read the same evidence differently with no named gap → retrieving is
 *   futile; report the fault line rather than burning budget.
 */
export interface Contention {
  questionId: string;
  roles: [AgentRoleT, AgentRoleT];
  type: "evidential" | "interpretive";
  note: string; // short mechanical description (which claims clash, over which ids)
}
