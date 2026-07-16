"use client";

import type { AgentRoleT, Claim, ClaimStanceT } from "@/lib/schemas/claim";
import { openingResolution } from "@/lib/research/board";

const ROLE_ORDER: AgentRoleT[] = ["historian", "operator", "investor", "skeptic"];

const ROLE_META: Record<AgentRoleT, { glyph: string; label: string }> = {
  historian: { glyph: "H", label: "Historian" },
  operator: { glyph: "O", label: "Operator" },
  investor: { glyph: "$", label: "Investor" },
  skeptic: { glyph: "?", label: "Skeptic" },
};

function stanceColor(stance: ClaimStanceT | undefined): string {
  if (stance === "supports") return "#2dd4bf"; // green
  if (stance === "opposes") return "#ff5c73"; // red
  if (stance === "insufficient") return "#5b6b80"; // grey — abstains
  return "transparent"; // no claim yet
}

interface Props {
  /** One (usually round-0) claim per role, whatever's available so far. */
  claimsByRole: Partial<Record<AgentRoleT, Claim>>;
}

/** The Openings-cell four-dot stance indicator, resolving to "agree" / "split" per §1/§2 of the spec. */
export function StanceDots({ claimsByRole }: Props) {
  const claims = ROLE_ORDER.map((r) => claimsByRole[r]).filter((c): c is Claim => c != null);
  const resolution = openingResolution(claims);

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-1">
        {ROLE_ORDER.map((role) => {
          const claim = claimsByRole[role];
          const color = stanceColor(claim?.stance);
          return (
            <span
              key={role}
              title={`${ROLE_META[role].label}${claim ? `: ${claim.stance}` : ""}`}
              className="inline-block h-2.5 w-2.5 rounded-full border"
              style={{
                backgroundColor: claim ? color : "transparent",
                borderColor: claim ? color : "#1c2634",
              }}
            />
          );
        })}
      </div>
      {resolution !== "pending" && (
        <span
          className={`font-mono text-[10px] ${resolution === "split" ? "text-amber" : "text-accent"}`}
        >
          → {resolution}
        </span>
      )}
    </div>
  );
}
