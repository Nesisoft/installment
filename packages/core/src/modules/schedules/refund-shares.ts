/**
 * How much of one instalment is the order, as opposed to the platform's
 * interest and fees.
 *
 * The seller is credited the order and nothing else, but an instalment carries
 * both: `ScheduleGenerator` bills the deposit as pure order money and splits
 * financed + interest + fees evenly across the remaining rows. A refund that
 * forgives an instalment hands the seller's share back from the seller and the
 * platform's share back from the platform; treating the whole instalment as
 * the seller's clawed them for interest they were never paid.
 *
 * Each row's share is cut from the running total — `financed × paidThrough /
 * total`, less the same for the rows before it — so the rows' shares add up to
 * exactly `financed`, and a plan forgiven row by row gives the seller back
 * exactly what they were credited.
 */
export interface ShareablePlan {
  down_payment_pesewas: number;
  financed_amount_pesewas: number;
}

export interface ShareableRow {
  id: string;
  sequence_number: number;
  amount_due_pesewas: number;
}

/**
 * The order share of `rowId`, one of the plan's original rows — the ones the
 * generator wrote, not a re-collected copy (trace a copy back to the row it
 * replaced first).
 */
export function orderShareOf(
  plan: ShareablePlan,
  originalRows: readonly ShareableRow[],
  rowId: string,
): number {
  const rows = [...originalRows].sort((a, b) => a.sequence_number - b.sequence_number);
  const index = rows.findIndex((r) => r.id === rowId);
  if (index < 0) throw new Error(`Row ${rowId} is not one of the plan's original instalments`);

  const hasDeposit = plan.down_payment_pesewas > 0;
  if (hasDeposit && index === 0) return rows[0]!.amount_due_pesewas;

  const instalments = hasDeposit ? rows.slice(1) : rows;
  const k = hasDeposit ? index - 1 : index;
  const total = instalments.reduce((sum, r) => sum + r.amount_due_pesewas, 0);
  if (total <= 0) return 0;

  const before = instalments.slice(0, k).reduce((sum, r) => sum + r.amount_due_pesewas, 0);
  const through = before + instalments[k]!.amount_due_pesewas;
  // BigInt: financed × running total overflows a double's exact range on large
  // orders long before either factor does.
  const financed = BigInt(Math.min(plan.financed_amount_pesewas, total));
  const cut = (paid: number) => (financed * BigInt(paid)) / BigInt(total);
  return Number(cut(through) - cut(before));
}
