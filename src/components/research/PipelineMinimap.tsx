"use client";

const STAGES = [
  { id: "decompose", label: "decompose" },
  { id: "retrieve", label: "retrieve" },
  { id: "debate", label: "debate" },
  { id: "gate", label: "gate" },
];

interface Props {
  activeNode: string | null;
  completedNodes: string[];
  loopIteration: number;
  continueLoop: boolean;
}

/** Shrunk `PipelineGraph` — a one-line "you are here" strip in the board header. */
export function PipelineMinimap({ activeNode, completedNodes, loopIteration, continueLoop }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
      {STAGES.map((stage, i) => {
        const isActive = activeNode === stage.id;
        const isDone = completedNodes.includes(stage.id);
        return (
          <span key={stage.id} className="flex items-center gap-1">
            <span
              className={
                isActive
                  ? "text-accent animate-blink"
                  : isDone
                    ? "text-accent"
                    : "text-mute"
              }
            >
              {stage.label}
            </span>
            {i < STAGES.length - 1 && <span className="text-line">─▶</span>}
          </span>
        );
      })}
      {loopIteration > 0 && (
        <span className={continueLoop ? "text-amber" : "text-mute"}>
          {" "}─↻ loop {loopIteration}
        </span>
      )}
    </div>
  );
}
