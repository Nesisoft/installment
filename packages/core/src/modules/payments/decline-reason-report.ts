import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import {
  classifyFailure,
  declineReasonSource,
  type DeclineReasonSource,
  type FailureClass,
} from './failure-classifier';

const pa = schema.payment_attempts;

export interface DeclineReasonRow {
  /** The text as stored — Paystack's `gateway_response`, or our placeholder. */
  reason: string;
  attempts: number;
  last_seen_at: string;
  /** What the retry ladder does with it today. */
  classified_as: FailureClass;
  source: DeclineReasonSource;
}

/**
 * The decline reasons real charges have come back with, and whether the
 * classifier knows them.
 *
 * Every failed attempt has stored `failure_reason` and the raw provider
 * response since the first migration; nothing read them. So the one question
 * the decline map turns on — does Paystack send the snake_case tokens it is
 * keyed on, or prose — could have been answered from production data, and
 * wasn't. This reads them.
 *
 * Only `failed` attempts count. An `unknown` one is a charge whose outcome is
 * not yet known, and its `failure_reason` is a verify error, not a decline.
 */
export class DeclineReasonReport {
  constructor(private readonly db: Database) {}

  async summarise(opts: { since: Date }): Promise<DeclineReasonRow[]> {
    const rows = await this.db
      .select({
        reason: pa.failure_reason,
        attempts: sql<number>`count(*)::int`,
        last_seen_at: sql<string>`max(${pa.failed_at})`,
      })
      .from(pa)
      .where(
        and(
          eq(pa.status, 'failed'),
          isNotNull(pa.failure_reason),
          gte(pa.failed_at, opts.since.toISOString()),
        ),
      )
      .groupBy(pa.failure_reason)
      // Reason as the tiebreak, so equal counts list the same way every time.
      .orderBy(desc(sql`count(*)`), pa.failure_reason);

    return rows.map((r) => {
      const reason = r.reason as string;
      return {
        reason,
        attempts: Number(r.attempts),
        last_seen_at: r.last_seen_at,
        classified_as: classifyFailure(reason),
        source: declineReasonSource(reason),
      };
    });
  }

  /** The reasons the map has no entry for — what the daily alert lists. */
  async unrecognised(opts: { since: Date }): Promise<DeclineReasonRow[]> {
    return (await this.summarise(opts)).filter((r) => r.source === 'unrecognised');
  }
}
