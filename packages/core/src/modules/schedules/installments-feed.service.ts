import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@installment/db';

const sched = schema.installment_schedule;
const cp = schema.customer_plans;
const merchants = schema.merchants;

export const INSTALLMENT_FEED_FILTERS = ['all', 'due', 'upcoming', 'paid', 'overdue'] as const;
export type InstallmentFeedFilter = (typeof INSTALLMENT_FEED_FILTERS)[number];

export const installmentsFeedSchema = z.object({
  status: z.enum(INSTALLMENT_FEED_FILTERS).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type InstallmentsFeedInput = z.infer<typeof installmentsFeedSchema>;

/**
 * One instalment, carrying enough context to render a row without a second call:
 * which plan it belongs to, where it sits in that plan, and what was bought.
 */
export interface FeedInstallment {
  id: string;
  customer_plan_id: string;
  sequence_number: number;
  /** Position among the plan's rows, deposit included — "instalment 2 of 4". */
  position: number;
  total_installments: number;
  amount_due_pesewas: number;
  amount_paid_pesewas: number;
  late_fee_pesewas: number;
  /** What a payment now would collect: the instalment plus any accrued fee. */
  payable_pesewas: number;
  due_date: string;
  grace_until_date: string;
  status: string;
  paid_at: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  /** True for the deposit row, which is never auto-debited. */
  is_down_payment: boolean;
  is_overdue: boolean;
  plan: {
    id: string;
    status: string;
    outstanding_pesewas: number;
    total_payable_pesewas: number;
    autopay_enabled: boolean;
    installment_frequency_days: number;
    grace_period_days: number;
    late_fee_bps_per_week: number;
    late_fee_cap_bps: number;
  };
  merchant_name: string | null;
  order_id: string | null;
  order_number: string | null;
  /** The first item on the order — what the design labels the row with. */
  item_title: string | null;
}

/** Statuses that mean "we are still expecting this money". */
const OPEN_STATUSES = [
  'pending',
  'due',
  'processing',
  'failed',
  'retry_scheduled',
  'overdue',
] as const;

/**
 * Every instalment a customer owes, across every plan, in one call.
 *
 * Three screens need exactly this — the home screen's "GHS 260 due Friday"
 * strip, the due strip on each order card, and the Installments screen itself —
 * and the engine only offered it per plan behind `GET /me/plans/:id/schedule`.
 * A phone assembling this client-side would have to fetch every plan and then a
 * schedule per plan, which is N+1 round trips on a mobile network for a strip
 * of one line.
 *
 * The joins to orders and order_items are LEFT joins on purpose: the engine
 * serves partner traffic whose `order_reference` is not one of our orders, and
 * such a plan must still appear in the customer's list, just without a product
 * name.
 */
export class InstallmentsFeedService {
  constructor(private readonly db: Database) {}

  async forCustomer(
    customerId: string,
    rawInput: unknown = {},
    now: Date = new Date(),
  ): Promise<FeedInstallment[]> {
    const input: InstallmentsFeedInput = installmentsFeedSchema.parse(rawInput);
    const today = now.toISOString().slice(0, 10);

    const where = [eq(cp.customer_id, customerId)];
    switch (input.status) {
      case 'due':
        where.push(inArray(sched.status, ['pending', 'due', 'failed', 'retry_scheduled']));
        where.push(sql`${sched.due_date} <= ${today}`);
        break;
      case 'upcoming':
        where.push(inArray(sched.status, ['pending', 'due']));
        where.push(sql`${sched.due_date} > ${today}`);
        break;
      case 'paid':
        where.push(eq(sched.status, 'paid'));
        break;
      case 'overdue':
        where.push(inArray(sched.status, ['overdue', 'in_collections']));
        break;
      case 'all':
      default:
        break;
    }

    const rows = await this.db
      .select({
        row: sched,
        plan: cp,
        merchant_name: merchants.business_name,
        position: sql<number>`ROW_NUMBER() OVER (
          PARTITION BY ${sched.customer_plan_id} ORDER BY ${sched.sequence_number}
        )::int`,
        total_installments: sql<number>`COUNT(*) OVER (
          PARTITION BY ${sched.customer_plan_id}
        )::int`,
        order_id: sql<string | null>`(SELECT o.id FROM orders o
          WHERE o.customer_plan_id = ${cp.id} LIMIT 1)`,
        order_number: sql<string | null>`(SELECT o.order_number FROM orders o
          WHERE o.customer_plan_id = ${cp.id} LIMIT 1)`,
        item_title: sql<string | null>`(SELECT oi.title FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.customer_plan_id = ${cp.id}
          ORDER BY oi.created_at LIMIT 1)`,
      })
      .from(sched)
      .innerJoin(cp, eq(cp.id, sched.customer_plan_id))
      .leftJoin(merchants, eq(merchants.id, cp.merchant_id))
      .where(and(...where))
      // Paid rows read as history (newest first); everything else is a to-do
      // list, so the next thing owed comes first.
      .orderBy(
        input.status === 'paid' ? desc(sched.due_date) : asc(sched.due_date),
        asc(sched.sequence_number),
      )
      .limit(input.limit)
      .offset(input.offset);

    return rows.map((r) => {
      const isDownPayment = r.row.sequence_number === 1 && r.plan.down_payment_pesewas > 0;
      return {
        id: r.row.id,
        customer_plan_id: r.row.customer_plan_id,
        sequence_number: r.row.sequence_number,
        position: r.position,
        total_installments: r.total_installments,
        amount_due_pesewas: r.row.amount_due_pesewas,
        amount_paid_pesewas: r.row.amount_paid_pesewas,
        late_fee_pesewas: r.row.late_fee_pesewas,
        payable_pesewas: r.row.amount_due_pesewas + r.row.late_fee_pesewas,
        due_date: r.row.due_date,
        grace_until_date: r.row.grace_until_date,
        status: r.row.status,
        paid_at: r.row.paid_at,
        attempt_count: r.row.attempt_count,
        next_retry_at: r.row.next_retry_at,
        is_down_payment: isDownPayment,
        // Past the grace date, not merely past the due date: inside grace the
        // instalment is late but costs nothing, and telling a customer they are
        // overdue while they still have days in hand is simply wrong.
        is_overdue:
          r.row.status !== 'paid' && r.row.status !== 'refunded' && r.row.grace_until_date < today,
        plan: {
          id: r.plan.id,
          status: r.plan.status,
          outstanding_pesewas: r.plan.outstanding_pesewas,
          total_payable_pesewas: r.plan.total_payable_pesewas,
          autopay_enabled: r.plan.autopay_enabled,
          installment_frequency_days: r.plan.installment_frequency_days,
          grace_period_days: r.plan.grace_period_days,
          late_fee_bps_per_week: r.plan.late_fee_bps_per_week,
          late_fee_cap_bps: r.plan.late_fee_cap_bps,
        },
        merchant_name: r.merchant_name,
        order_id: r.order_id,
        order_number: r.order_number,
        item_title: r.item_title,
      };
    });
  }

  /** The single next thing owed — the home screen's due strip. */
  async nextDue(customerId: string, now: Date = new Date()): Promise<FeedInstallment | null> {
    const rows = await this.forCustomer(customerId, { status: 'all', limit: 50 }, now);
    const open = rows.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status));
    // Anything already past its grace date outranks a merely upcoming one, and
    // within each group the earliest due date wins.
    open.sort((a, b) => {
      if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
      return a.due_date.localeCompare(b.due_date);
    });
    return open[0] ?? null;
  }
}
