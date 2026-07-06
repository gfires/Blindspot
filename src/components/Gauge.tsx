/**
 * Gauge — a 0–10 diagnostic sub-score rendered as a labeled bar with a brief rationale.
 */
import type { Score } from "@/lib/schema";

/** Pick color for a 0–10 sub-score. */
function scoreColor(v: number): string {
  if (v >= 7) return "bg-emerald-400";
  if (v >= 5) return "bg-yellow-400";
  if (v >= 3) return "bg-orange-400";
  return "bg-red-400";
}

/** For Existing Solution Maturity, high = bad (mature market = less opportunity). Flip the color. */
function invertedScoreColor(v: number): string {
  return scoreColor(10 - v);
}

export function Gauge({ name, score, scoreKey }: { name: string; score: Score; scoreKey?: string }) {
  const pct = Math.round((score.value / 10) * 100);
  const colorFn = scoreKey === "softwareMaturity" ? invertedScoreColor : scoreColor;
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{name}</span>
        <span className="nums text-lg text-fg">
          {score.value.toFixed(1)}
          <span className="text-mute text-xs">/10</span>
        </span>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
        <div className={`h-full rounded-full ${colorFn(score.value)}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-1 text-xs text-mute">{score.label}</div>

      {score.reason && (
        <p className="mt-2 text-[13px] leading-snug text-fg/70">{score.reason}</p>
      )}
    </div>
  );
}
