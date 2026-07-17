"use client";

import type { ResearcherPass } from "@/lib/useResearchStream";

function passLine(p: ResearcherPass): string {
  const parts: string[] = [];
  for (const s of p.searches) {
    parts.push(`🔍 "${s.query.slice(0, 40)}" (${s.hits} hits)`);
    if (s.capped) parts.push("🚫 capped");
  }
  for (const r of p.reads) {
    parts.push(`📄 read ${r.stored}/${r.requested}${r.hitCeiling ? " ⛔ceiling" : ""}`);
  }
  if (parts.length === 0) parts.push("… starting");
  return parts.join(" → ");
}

interface Props {
  passes: ResearcherPass[];
  /** "cell" — the Loop-cell mini-viz (latest pass, one line). "full" — the researcher drill-down. */
  variant?: "cell" | "full";
}

/** The Loop-cell window-shopping mini-viz + the researcher drill-down (question-board-spec.md §1/§3d). */
export function WindowShopStrip({ passes, variant = "full" }: Props) {
  if (passes.length === 0) return null;

  if (variant === "cell") {
    const latest = passes[passes.length - 1];
    return <div className="truncate font-mono text-[10px] text-mute">{passLine(latest)}</div>;
  }

  return (
    <div className="space-y-2 font-mono text-[11px]">
      {passes.map((p, i) => (
        <div key={i} className="space-y-0.5 rounded border border-line bg-panel2 p-2">
          <div className="flex items-center gap-2">
            <span className="text-accent">loop {p.loop}</span>
            <span className="truncate text-fg/70">{p.mission}</span>
          </div>
          <div className="text-mute">{passLine(p)}</div>
          {p.done && (
            <div className="text-fg/60">
              ✓ {p.done.evidenceCount} source{p.done.evidenceCount === 1 ? "" : "s"} · {p.done.searchCalls} search
              {p.done.searchCalls === 1 ? "" : "es"}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
