import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, EmploymentSignals } from './types';
import { monthsBetween } from './time';

const ce = schema.customer_employment;
const emp = schema.employers;

/**
 * Employment + payroll signals, from the customer's active
 * `customer_employment` link (most recent if more than one).
 *
 * The join to `employers` is load-bearing, not decoration. `customer_employment
 * .status` says whether the customer still holds the job; the employer's own
 * status says whether the partnership still exists. Reading only the first
 * scored a link to a terminated employer exactly like a live one — worth up to
 * 150 points for a payroll relationship that had been wound up, on a row nobody
 * would think to go back and change.
 */
export class EmploymentCollector implements Collector<EmploymentSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<EmploymentSignals> {
    const rows = await this.db
      .select({
        salary_band: ce.salary_band,
        employment_start_date: ce.employment_start_date,
        payroll_deduction_consent: ce.payroll_deduction_consent,
        verified_at: ce.verified_at,
      })
      .from(ce)
      .innerJoin(emp, eq(emp.id, ce.employer_id))
      .where(and(eq(ce.customer_id, customerId), eq(ce.status, 'active'), eq(emp.status, 'active')))
      .orderBy(desc(ce.created_at))
      .limit(1);
    const row = rows[0];
    if (!row) return this.defaults();

    return {
      employerLinked: true,
      employerVerified: row.verified_at !== null,
      salaryBand: row.salary_band as EmploymentSignals['salaryBand'],
      employmentMonths: row.employment_start_date
        ? monthsBetween(new Date(row.employment_start_date), new Date())
        : null,
      payrollDeductionConsent: row.payroll_deduction_consent,
    };
  }

  defaults(): EmploymentSignals {
    return {
      employerLinked: false,
      employerVerified: false,
      salaryBand: 'unknown',
      employmentMonths: null,
      payrollDeductionConsent: false,
    };
  }
}
