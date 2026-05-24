import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import type { Collector, EmploymentSignals } from './types';
import { monthsBetween } from './time';

const ce = schema.customer_employment;

/**
 * Employment + payroll signals — sourced from the customer's active
 * `customer_employment` link (most recent if more than one).
 */
export class EmploymentCollector implements Collector<EmploymentSignals> {
  constructor(private readonly db: Database) {}

  async collect(customerId: string): Promise<EmploymentSignals> {
    const rows = await this.db
      .select({
        salary_band: ce.salary_band,
        employment_start_date: ce.employment_start_date,
        payroll_deduction_consent: ce.payroll_deduction_consent,
      })
      .from(ce)
      .where(and(eq(ce.customer_id, customerId), eq(ce.status, 'active')))
      .orderBy(desc(ce.created_at))
      .limit(1);
    const row = rows[0];
    if (!row) return this.defaults();

    return {
      employerLinked: true,
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
      salaryBand: 'unknown',
      employmentMonths: null,
      payrollDeductionConsent: false,
    };
  }
}
