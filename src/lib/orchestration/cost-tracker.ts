import { MAX_RUN_COST_USD } from "../params";
import { estimateCostUsd } from "./eval";
import type { TokenUsage } from "../events";

export class BudgetExceededError extends Error {
  constructor(spent: number, cap: number) {
    super(`LLM cost budget exceeded: $${spent.toFixed(3)} spent, cap is $${cap.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

class CostTracker {
  private spent = 0;
  private cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  check(): void {
    if (this.spent >= this.cap) {
      throw new BudgetExceededError(this.spent, this.cap);
    }
  }

  record(usage: TokenUsage): number {
    const cost = estimateCostUsd(usage);
    this.spent += cost;
    return cost;
  }

  getSpent(): number {
    return this.spent;
  }

  getRemaining(): number {
    return Math.max(0, this.cap - this.spent);
  }
}

let activeTracker: CostTracker | null = null;

export function startCostTracker(cap?: number): CostTracker {
  activeTracker = new CostTracker(cap ?? MAX_RUN_COST_USD);
  return activeTracker;
}

export function getActiveCostTracker(): CostTracker | null {
  return activeTracker;
}
