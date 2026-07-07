"use client";

import { useEffect, useState } from "react";

interface Entry {
  industry: string;
  score: number;
  scanned_at: string;
}

function scoreColor(score: number): string {
  if (score >= 70) return "#34d399";
  if (score >= 50) return "#facc15";
  if (score >= 30) return "#fb923c";
  return "#f87171";
}

export function Leaderboard() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((data) => setEntries(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || entries.length === 0) return null;

  return (
    <div className="mx-auto mt-10 w-full max-w-md">
      <div className="eyebrow mb-3 text-center">Top scans</div>
      <div className="panel overflow-hidden">
        <table className="w-full text-left font-mono text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-mute">
              <th className="px-4 py-2 font-normal">#</th>
              <th className="px-4 py-2 font-normal">Industry</th>
              <th className="px-4 py-2 text-right font-normal">Score</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.industry} className="border-b border-line/50 last:border-0">
                <td className="px-4 py-2 text-mute">{i + 1}</td>
                <td className="px-4 py-2 text-fg">{e.industry}</td>
                <td className="nums px-4 py-2 text-right font-semibold" style={{ color: scoreColor(e.score) }}>
                  {e.score}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
