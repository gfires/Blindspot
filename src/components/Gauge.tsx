/**
 * Gauge — a 0–10 diagnostic sub-score rendered as a labeled bar with a brief rationale.
 * Color ramps from teal (low) → amber → danger (high) so "heat" reads at a glance.
 */
import type { Score } from "@/lib/schema";

/** Pick a heat color for a 0–10 value. */
function heatClass(v: number): string {
  if (v >= 7.5) return "bg-danger";
  if (v >= 5) return "bg-amber";
  return "bg-accent";
}

export function Gauge({ name, score }: { name: string; score: Score }) {
  const pct = Math.round((score.value / 10) * 100);
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
        <div className={`h-full rounded-full ${heatClass(score.value)}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-1 text-xs text-mute">{score.label}</div>

      {score.reason && (
        <p className="mt-2 text-[13px] leading-snug text-fg/70">{score.reason}</p>
      )}
    </div>
  );
}
