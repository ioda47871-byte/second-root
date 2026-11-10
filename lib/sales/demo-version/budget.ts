/**
 * DEV-196b review round 3: the operation budget of one validation (the finalize-level safety net).
 *
 * Every loop of the HTML/CSS check spends from one budget: parse5 tokens, created elements, open-stack pushes and
 * attributes (bounded-parse.ts), tree nodes walked and attributes checked (html-safety.ts), CSS tokens (css-scan.ts),
 * declarations, and every regex call weighted by the length of its input. Over the budget, the check stops with
 * `VALIDATION_BUDGET_EXCEEDED` (fail closed). It counts work, not wall-clock, so it is deterministic and cannot flake.
 *
 * The default budget is far above what the largest allowed page needs (384 KiB HTML + 256 KiB CSS spend well under
 * 2 million units even when every character is its own token), and far below what a quadratic path would need.
 *
 * Pure.
 */

export const DEFAULT_VALIDATION_BUDGET = 4_000_000;

export class BudgetExceeded extends Error {
  readonly code = "VALIDATION_BUDGET_EXCEEDED" as const;
  constructor() {
    super("VALIDATION_BUDGET_EXCEEDED");
    this.name = "BudgetExceeded";
  }
}

export class OpBudget {
  private left: number;
  constructor(readonly limit: number = DEFAULT_VALIDATION_BUDGET) {
    this.left = limit;
  }
  /** Spends `n` units (at least 1); throws BudgetExceeded when the budget is gone. */
  spend(n = 1): void {
    this.left -= Math.max(1, Math.ceil(n));
    if (this.left < 0) throw new BudgetExceeded();
  }
  /** Spends for a regex (or any linear string operation) over `s`: one unit per 16 characters, at least 1. */
  scan(s: string): void {
    this.spend(1 + s.length / 16);
  }
  get used(): number {
    return this.limit - this.left;
  }
}
