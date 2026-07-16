"use client";

import { useEffect, useState } from "react";
import type { ResearchEvent } from "@/lib/research-events";
import { useResearchReplay } from "@/lib/useResearchReplay";
import { QuestionBoard } from "@/components/research/QuestionBoard";

const SPEEDS = [0.5, 1, 2, 4, 8];

export default function ReplayPage() {
  const [events, setEvents] = useState<ResearchEvent[] | null>(null);

  useEffect(() => {
    fetch("/api/research/replay")
      .then((res) => res.json())
      .then(setEvents)
      .catch(() => setEvents([]));
  }, []);

  const replay = useResearchReplay(events ?? []);

  if (!events) {
    return <main className="min-h-screen px-4 py-10 text-center text-mute">loading replay fixture...</main>;
  }

  return (
    <main className="min-h-screen space-y-4 px-4 py-10 sm:py-16">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 font-mono text-xs text-mute">
        <button
          onClick={replay.playing ? replay.pause : replay.play}
          className="rounded border border-line px-3 py-1 text-fg transition hover:border-accent hover:text-accent"
        >
          {replay.playing ? "pause" : "play"}
        </button>
        <input
          type="range"
          min={-1}
          max={Math.max(0, replay.total - 1)}
          value={replay.index}
          onChange={(e) => replay.scrub(Number(e.target.value))}
          className="flex-1"
        />
        <span className="nums">
          {replay.index + 1}/{replay.total}
        </span>
        <select
          value={replay.speed}
          onChange={(e) => replay.setSpeed(Number(e.target.value))}
          className="rounded border border-line bg-panel px-2 py-1"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>

      <QuestionBoard state={replay.state} done={!replay.state.running} />
    </main>
  );
}
