export function applyLedgerDelta(balance: number, delta: number) {
  if (!Number.isFinite(balance)) {
    throw new Error("balance must be a finite number");
  }

  if (!Number.isFinite(delta)) {
    throw new Error("delta must be a finite number");
  }

  return balance + delta;
}
