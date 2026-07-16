"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchUIState, QuestionStatus } from "@/lib/useResearchStream";
import type { AgentRoleT, Claim } from "@/lib/schemas/claim";
import { committeeStance } from "@/lib/orchestration/debate";
import { latestClaimsByRole, confidenceColor as barColor } from "@/lib/research/arena";
import {
  reconCount,
  claimsByRole as indexClaimsByRole,
  latestGateScoreFor,
  gateVerdict,
  scopeGateDecisionsToQuestion,
  type GateVerdict,
} from "@/lib/research/board";
import { PipelineMinimap } from "./PipelineMinimap";
import { StanceDots } from "./StanceDots";
import { CostCounter } from "./CostCounter";
import { DebateArena } from "./DebateArena";
import { AgentSwimlane } from "./AgentSwimlane";
import { EvidenceFeed } from "./EvidenceFeed";
import { GateDecisionPanel } from "./GateDecisionPanel";

const ROLE_LABELS: Record<AgentRoleT, string> = {
  historian: "Historian",
  operator: "Operator",
  investor: "Investor",
  skeptic: "Skeptic",
};

const STATUS_STYLE: Record<QuestionStatus["status"], { label: string; cls: string }> = {
  pending: { label: "pending", cls: "text-mute border-line" },
  retrieving: { label: "retrieving", cls: "text-amber border-amber animate-blink" },
  debating: { label: "debating", cls: "text-accent border-accent animate-blink" },
  resolved: { label: "resolved", cls: "text-accent border-accent" },
  looping: { label: "looping", cls: "text-amber border-amber" },
};

const GATE_VERDICT_STYLE: Record<GateVerdict, { label: string; cls: string }> = {
  pending: { label: "—", cls: "text-mute" },
  settled: { label: "✔ settled", cls: "text-accent" },
  "fault-line": { label: "⚡ fault line", cls: "text-amber" },
  retrieve: { label: "↻ retrieve +gap", cls: "text-amber" },
};

type Stage = "recon" | "openings" | "deliberation" | "gate" | "loop";
interface DrillDown {
  questionId: string;
  stage: Stage;
}

function useElapsed(running: boolean, resetKey: string): number {
  const [elapsed, setElapsed] = useState(0);
  const t0 = useRef(Date.now());

  useEffect(() => {
    t0.current = Date.now();
    setElapsed(0);
  }, [resetKey]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Date.now() - t0.current), 100);
    return () => clearInterval(id);
  }, [running]);

  return elapsed;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The Openings cell's claims: the real round-0 blind opening once §3c events have arrived, else
 * (Phase 1 fallback) the latest claim per role from whatever's streamed so far.
 */
function openingClaimsFor(state: ResearchUIState, qid: string): Claim[] {
  const openings = state.openingsByQuestion[qid];
  if (openings && openings.length > 0) return openings;
  const claims = state.claimsByQuestion[qid] ?? [];
  return Object.values(latestClaimsByRole(claims, qid)).filter((c): c is Claim => c != null);
}

function deliberationLabel(q: QuestionStatus): string {
  if (q.debateOutcome === "pending") return "—";
  if (q.debateOutcome === "skipped") return "⚡ skipped — unanimous, no genuine disagreement";
  return q.debateRounds > 0 ? `🗣 debated ${q.debateRounds} round${q.debateRounds === 1 ? "" : "s"}` : "🗣 opening...";
}

interface CellProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Cell({ active, onClick, children }: CellProps) {
  return (
    <button
      onClick={onClick}
      className={`min-h-[52px] rounded border p-2 text-left text-[11px] transition
        ${active ? "border-accent bg-accent/10" : "border-line hover:border-accent/50 hover:bg-panel2"}`}
    >
      {children}
    </button>
  );
}

interface RowProps {
  q: QuestionStatus;
  state: ResearchUIState;
  drill: DrillDown | null;
  onToggle: (questionId: string, stage: Stage) => void;
}

function QuestionRow({ q, state, drill, onToggle }: RowProps) {
  const qid = q.question.id;
  const s = STATUS_STYLE[q.status];
  const evidence = state.evidenceByQuestion[qid] ?? [];
  const claims = state.claimsByQuestion[qid] ?? [];
  const openingClaimsByRole = indexClaimsByRole(openingClaimsFor(state, qid));
  const stance = committeeStance(claims);
  const gateScore = latestGateScoreFor(state.gateDecisions, qid);
  const verdict = gateVerdict(gateScore, stance);
  const verdictStyle = GATE_VERDICT_STYLE[verdict];

  const isDrilled = (stage: Stage) => drill?.questionId === qid && drill.stage === stage;

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: "minmax(180px,1fr) repeat(5, minmax(120px,1fr))" }}
    >
      {/* Row header — absorbed QuestionTracker */}
      <div className="panel space-y-1.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[10px] text-mute">{qid}</span>
            <span className="mx-1 text-line">·</span>
            <span className="text-[10px] text-fg/70">{q.question.category}</span>
            <p className="mt-0.5 text-xs leading-snug text-fg">{q.question.text}</p>
          </div>
          <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${s.cls}`}>
            {s.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-panel2">
            <div
              className={`h-full rounded-full ${barColor(q.aggregateConfidence)}`}
              style={{ width: `${Math.round(q.aggregateConfidence * 100)}%` }}
            />
          </div>
          <span className="nums w-8 text-right text-[10px] text-mute">
            {q.aggregateConfidence > 0 ? q.aggregateConfidence.toFixed(2) : "—"}
          </span>
        </div>
      </div>

      {/* Recon */}
      <Cell active={isDrilled("recon")} onClick={() => onToggle(qid, "recon")}>
        <div className="nums text-fg">{reconCount(evidence)} src</div>
        <div className="text-mute">{evidence.length} total</div>
      </Cell>

      {/* Openings */}
      <Cell active={isDrilled("openings")} onClick={() => onToggle(qid, "openings")}>
        <StanceDots claimsByRole={openingClaimsByRole} />
      </Cell>

      {/* Deliberation */}
      <Cell active={isDrilled("deliberation")} onClick={() => onToggle(qid, "deliberation")}>
        <span className={q.debateOutcome === "debated" ? "text-accent" : "text-mute"}>
          {deliberationLabel(q)}
        </span>
      </Cell>

      {/* Gate */}
      <Cell active={isDrilled("gate")} onClick={() => onToggle(qid, "gate")}>
        <div className="font-mono text-[10px] uppercase text-mute">{stance}</div>
        <div className={verdictStyle.cls}>{verdictStyle.label}</div>
      </Cell>

      {/* Loop */}
      <Cell active={isDrilled("loop")} onClick={() => onToggle(qid, "loop")}>
        {q.status === "looping" || q.currentLoop > 0 ? (
          <span className="text-amber">↻ retrieve loop {q.currentLoop}</span>
        ) : (
          <span className="text-mute">—</span>
        )}
      </Cell>
    </div>
  );
}

interface DrillDownPanelProps {
  drill: DrillDown;
  state: ResearchUIState;
  onClose: () => void;
}

function DrillDownPanel({ drill, state, onClose }: DrillDownPanelProps) {
  const { questionId, stage } = drill;
  const openingClaimsByRole = indexClaimsByRole(openingClaimsFor(state, questionId));

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="eyebrow">
          {questionId} · {stage}
        </div>
        <button onClick={onClose} className="text-xs text-mute hover:text-fg">
          close ✕
        </button>
      </div>

      {stage === "recon" || stage === "loop" ? (
        <EvidenceFeed evidence={state.evidenceByQuestion[questionId] ?? []} loopIteration={state.loopIteration} />
      ) : stage === "openings" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(openingClaimsByRole) as AgentRoleT[]).map((role) => {
            const claim = openingClaimsByRole[role];
            if (!claim) return null;
            return (
              <div key={role} className="rounded border border-line bg-panel2 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="eyebrow text-[10px]">{ROLE_LABELS[role]}</span>
                  <span className="nums text-[11px] text-fg/70">{claim.confidence.toFixed(2)}</span>
                </div>
                <p className="text-[11px] leading-snug text-fg">{claim.conclusion}</p>
                <span className="font-mono text-[9px] uppercase text-mute">{claim.stance}</span>
              </div>
            );
          })}
          {Object.keys(openingClaimsByRole).length === 0 && (
            <p className="text-xs text-mute">awaiting openings...</p>
          )}
        </div>
      ) : stage === "deliberation" ? (
        <div className="space-y-3">
          <DebateArena
            claimsByQuestion={state.claimsByQuestion}
            evidenceByQuestion={state.evidenceByQuestion}
            questions={state.questions}
            activeNode={state.activeNode}
            activeQuestionId={questionId}
            onSelectQuestion={() => {}}
          />
          <AgentSwimlane
            openings={state.openingsByQuestion[questionId] ?? []}
            rounds={state.roundsByQuestion[questionId] ?? []}
            questionId={questionId}
            activeNode={state.activeNode}
          />
        </div>
      ) : (
        <GateDecisionPanel decisions={scopeGateDecisionsToQuestion(state.gateDecisions, questionId)} />
      )}
    </div>
  );
}

interface Props {
  state: ResearchUIState;
  done?: boolean;
}

/** The question-centric swimlane board — replaces `ResearchProgress` (question-board-spec.md). */
export function QuestionBoard({ state, done = false }: Props) {
  const elapsed = useElapsed(state.running, state.topic);
  const [drill, setDrill] = useState<DrillDown | null>(null);
  const traceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (traceRef.current) traceRef.current.scrollTop = traceRef.current.scrollHeight;
  }, [state.trace.length]);

  const lastGate = state.gateDecisions[state.gateDecisions.length - 1];
  const continueLoop = lastGate?.continueLoop ?? false;

  const toggle = (questionId: string, stage: Stage) => {
    setDrill((prev) => (prev && prev.questionId === questionId && prev.stage === stage ? null : { questionId, stage }));
  };

  return (
    <div className="relative mx-auto w-full max-w-6xl space-y-4">
      {!done && state.running && (
        <div className="pointer-events-none absolute inset-0 z-10 animate-sweep bg-gradient-to-b from-accent/5 via-accent/10 to-transparent" />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="eyebrow">Deep Research</div>
          <h2 className="text-lg font-semibold text-fg">{state.topic}</h2>
        </div>
        <div className="flex items-center gap-3">
          <CostCounter usage={state.usage} />
          <span className="nums text-sm text-mute">
            {fmtMs(elapsed)}
            {state.running && <span className="animate-blink">█</span>}
          </span>
        </div>
      </div>

      <PipelineMinimap
        activeNode={state.activeNode}
        completedNodes={state.completedNodes}
        loopIteration={state.loopIteration}
        continueLoop={continueLoop}
      />

      {/* Swimlanes */}
      {state.questions.length > 0 && (
        <div className="space-y-2 overflow-x-auto">
          <div
            className="grid gap-2 font-mono text-[10px] uppercase text-mute"
            style={{ gridTemplateColumns: "minmax(180px,1fr) repeat(5, minmax(120px,1fr))" }}
          >
            <div />
            <div>Recon</div>
            <div>Openings</div>
            <div>Deliberation</div>
            <div>Gate</div>
            <div>Loop</div>
          </div>

          {state.questions.map((q) => (
            <QuestionRow key={q.question.id} q={q} state={state} drill={drill} onToggle={toggle} />
          ))}
        </div>
      )}

      {drill && <DrillDownPanel drill={drill} state={state} onClose={() => setDrill(null)} />}

      {/* Activity feed */}
      <div className="space-y-1">
        <div className="eyebrow">Activity</div>
        <div ref={traceRef} className="panel max-h-48 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
          {state.trace.map((line, i) => (
            <div key={i} className="text-mute">
              <span className="text-accent">$</span> {line.replace(/^\$ /, "")}
            </div>
          ))}
          {state.running && state.activeNode && (
            <div className="text-mute animate-blink">
              <span className="text-accent">$</span> {state.activeNode}...
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {state.error && (
        <div className="panel border-danger bg-danger/10 p-4">
          <div className="eyebrow text-danger">Error</div>
          <p className="mt-1 text-sm text-fg">{state.error}</p>
        </div>
      )}
    </div>
  );
}
