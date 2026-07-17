"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useScanStream } from "@/lib/useScanStream";
import { useResearchStream } from "@/lib/useResearchStream";
import { ScanInput, type RunMode } from "@/components/ScanInput";
import { ScanProgress } from "@/components/ScanProgress";
import { ReportView } from "@/components/ReportView";
import { QuestionBoard } from "@/components/research/QuestionBoard";
import { ResearchReportView } from "@/components/research/ResearchReportView";
import { Leaderboard } from "@/components/Leaderboard";
import type { ResearchReport } from "@/lib/orchestration/graph";

export default function Home() {
  const [mode, setMode] = useState<RunMode>("scan");
  const scan = useScanStream();
  const research = useResearchStream();

  const isIdle = scan.state.phase === "idle" && research.state.phase === "idle";

  const handleRun = (topic: string, budget?: number, usdBudget?: number) => {
    if (mode === "research") {
      scan.reset();
      research.start(topic, budget, usdBudget);
    } else {
      research.reset();
      scan.start(topic);
    }
  };

  const handleReset = () => {
    scan.reset();
    research.reset();
  };

  // Scan state derivation
  const scanShowReport = scan.state.report && !scan.state.running;
  const scanShowError = scan.state.error && !scan.state.running;
  const scanShowProgress = scan.state.running || (!scan.state.report && !scan.state.error && scan.state.phase !== "idle");

  // Research state derivation — the fullscreen board stays up through completion (it's already
  // showing the finished, all-resolved state); the report pops up on top of it rather than
  // replacing it with a different plain-page layout.
  const researchReport = research.state.report;
  const researchShowBoard = research.state.phase !== "idle" && !research.state.error;
  const researchShowError = research.state.error && !research.state.running;

  // Auto-open the report the moment a NEW run finishes. graph-stream.ts now `await`s saveRun()
  // BEFORE emitting recommend:done, so by the time this popup can possibly appear, the run is
  // already a durable row in research_runs.
  // A ref tracks which report we've already auto-opened for, so a user who closes the popup isn't
  // fought back into it on every re-render — only a genuinely new report (a new run) reopens it.
  const [showReportModal, setShowReportModal] = useState(false);
  const autoOpenedFor = useRef<typeof researchReport>(null);
  useEffect(() => {
    if (researchReport && researchReport !== autoOpenedFor.current) {
      autoOpenedFor.current = researchReport;
      setShowReportModal(true);
    } else if (!researchReport) {
      autoOpenedFor.current = null;
      setShowReportModal(false);
    }
  }, [researchReport]);

  const researchHeaderExtra =
    research.state.phase === "done" && researchReport ? (
      <div className="flex items-center gap-2 font-mono text-xs">
        {!showReportModal && (
          <button
            onClick={() => setShowReportModal(true)}
            className="rounded border border-line px-2 py-1 text-mute transition hover:border-accent hover:text-accent"
          >
            view report
          </button>
        )}
        <button
          onClick={handleReset}
          className="rounded border border-line px-2 py-1 text-mute transition hover:border-accent hover:text-accent"
        >
          new research →
        </button>
      </div>
    ) : undefined;

  return (
    <main className="min-h-screen px-4 py-10 sm:py-16">
      {/* Idle / landing */}
      {isIdle && (
        <div className="flex min-h-[70vh] flex-col items-center justify-center">
          <ScanInput onRun={handleRun} disabled={scan.state.running || research.state.running} mode={mode} onModeChange={setMode} />
          {mode === "scan" && <Leaderboard />}
          <Link
            href="/replay"
            className="mt-4 font-mono text-xs text-mute transition hover:text-accent"
          >
            past runs →
          </Link>
        </div>
      )}

      {/* Scan: live exploration */}
      {scanShowProgress && (
        <div className="pt-4">
          <ScanProgress state={scan.state} />
        </div>
      )}

      {/* Scan: report */}
      {scanShowReport && <ReportView report={scan.state.report!} scan={scan.state} onReset={handleReset} />}

      {/* Research: fullscreen board, live through completion */}
      {researchShowBoard && (
        <QuestionBoard state={research.state} done={!research.state.running} headerExtra={researchHeaderExtra} />
      )}

      {/* Research: final report — pops up over the board the moment a run finishes */}
      {showReportModal && researchReport && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm"
          onClick={() => setShowReportModal(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-6xl animate-rise overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex justify-end">
              <button onClick={() => setShowReportModal(false)} className="text-xs text-mute hover:text-fg">
                close ✕
              </button>
            </div>
            <ResearchReportView report={researchReport as ResearchReport} scan={research.state} onReset={handleReset} />
          </div>
        </div>
      )}

      {/* Scan error */}
      {scanShowError && (
        <div className="mx-auto mt-10 max-w-md panel p-6 text-center">
          <div className="eyebrow mb-2 text-danger">Scan failed</div>
          <p className="text-sm text-fg/85">{scan.state.error}</p>
          <button
            onClick={handleReset}
            className="mt-4 rounded-lg border border-line px-5 py-2 font-mono text-sm text-fg transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      )}

      {/* Research error */}
      {researchShowError && (
        <div className="mx-auto mt-10 max-w-md panel p-6 text-center">
          <div className="eyebrow mb-2 text-danger">Research failed</div>
          <p className="text-sm text-fg/85">{research.state.error}</p>
          <button
            onClick={handleReset}
            className="mt-4 rounded-lg border border-line px-5 py-2 font-mono text-sm text-fg transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      )}
    </main>
  );
}
