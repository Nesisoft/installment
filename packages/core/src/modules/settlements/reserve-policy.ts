import { MODEL_CONFIG, type BusinessModel } from './model-config';

const MS_PER_DAY = 86_400_000;

/**
 * The lifecycle stamps a `held_reserves` row carries. Narrowed to what the
 * policy actually reads so the pure function stays testable without a database
 * row (and so both the release service and the merchant dashboard can call it).
 */
export interface ReserveTriggers {
  business_model: string;
  held_at: string;
  plan_completed_at: string | null;
  delivered_at: string | null;
  plan_defaulted_at: string | null;
}

/**
 * The earliest date the model's policy allows this reserve to be released, or
 * `null` when the trigger it waits on has not fired yet.
 *
 * `null` — not a far-future sentinel — is the honest answer for "waiting". The
 * previous sentinel was the year 275760, which read as a valid maturity date to
 * anything that did not know to check for it, and made an un-triggerable
 * reserve indistinguishable from one merely far from maturing.
 *
 * A defaulted plan can never complete and can never be delivered, so default is
 * the terminal event for both buffer policies: whatever reserve survives the
 * loss allocation matures on the same buffer, counted from the default.
 */
export function reserveReleaseDate(row: ReserveTriggers): Date | null {
  const policy = MODEL_CONFIG[row.business_model as BusinessModel]?.reserveReleasePolicy;
  if (!policy) return null;

  switch (policy.type) {
    case 'after_plan_completion':
      return afterBuffer(row.plan_completed_at ?? row.plan_defaulted_at, policy.bufferDays);
    case 'after_delivery':
      return afterBuffer(row.delivered_at ?? row.plan_defaulted_at, policy.bufferDays);
    case 'rolling_monthly':
      // Starts maturing immediately; the amount is gated month-by-month.
      return new Date(row.held_at);
  }
}

function afterBuffer(trigger: string | null, bufferDays: number): Date | null {
  return trigger ? new Date(new Date(trigger).getTime() + bufferDays * MS_PER_DAY) : null;
}
