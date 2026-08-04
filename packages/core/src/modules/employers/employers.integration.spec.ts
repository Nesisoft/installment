import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { EmployersService } from './employers.service';
import { CustomerEmploymentService } from './customer-employment.service';
import { DuplicateEmploymentError, EmployerNotFoundError, EmploymentNotFoundError } from './errors';
import { IllegalEmployerTransitionError, IllegalEmploymentTransitionError } from './state-machine';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('Employers + CustomerEmployment (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const employers = new EmployersService(db, audit);
  const employment = new CustomerEmploymentService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const SYSTEM_ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function lastAuditEventType(entityId: string): Promise<string | undefined> {
    const rows = await db
      .select({ event_type: schema.audit_events.event_type })
      .from(schema.audit_events)
      .where(eq(schema.audit_events.entity_id, entityId))
      .orderBy(desc(schema.audit_events.occurred_at))
      .limit(1);
    return rows[0]?.event_type;
  }

  async function makeCustomer(): Promise<string> {
    const suffix = randomUUID();
    const created = await customers.register(
      {
        first_name: 'Ama',
        last_name: 'Mensah',
        email: `ama+${suffix}@example.com`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      },
      SYSTEM_ACTOR,
    );
    return created.id;
  }

  function employerInput() {
    return {
      name: `Govt of Ghana ${randomUUID()}`,
      sector: 'public' as const,
      payroll_cycle: 'monthly' as const,
      contact_email: `hr+${randomUUID()}@gov.gh`,
    };
  }

  it('walks the employer lifecycle: pending → active → paused → active → terminated', async () => {
    const created = await employers.create(employerInput(), SYSTEM_ACTOR);
    expect(created.status).toBe('pending');
    expect(await lastAuditEventType(created.id)).toBe('employer.created');

    const activated = await employers.transition(created.id, { event: 'activate' }, SYSTEM_ACTOR);
    expect(activated.status).toBe('active');
    expect(activated.partnership_start_date).not.toBeNull();
    expect(await lastAuditEventType(created.id)).toBe('employer.activate');

    const paused = await employers.transition(created.id, { event: 'pause' }, SYSTEM_ACTOR);
    expect(paused.status).toBe('paused');

    const resumed = await employers.transition(created.id, { event: 'resume' }, SYSTEM_ACTOR);
    expect(resumed.status).toBe('active');

    const terminated = await employers.transition(
      created.id,
      { event: 'terminate', reason: 'Policy change' },
      SYSTEM_ACTOR,
    );
    expect(terminated.status).toBe('terminated');
    expect(await lastAuditEventType(created.id)).toBe('employer.terminate');
  });

  it('rejects illegal employer transitions', async () => {
    const created = await employers.create(employerInput(), SYSTEM_ACTOR);
    await expect(
      employers.transition(created.id, { event: 'pause' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(IllegalEmployerTransitionError);
  });

  it('links a customer to an employer with consent stamped', async () => {
    const customerId = await makeCustomer();
    const employer = await employers.create(employerInput(), SYSTEM_ACTOR);

    const link = await employment.link(
      {
        customer_id: customerId,
        employer_id: employer.id,
        employee_number: 'GSS-12345',
        salary_band: 'mid',
        payroll_deduction_consent: true,
      },
      SYSTEM_ACTOR,
    );
    expect(link.status).toBe('active');
    expect(link.payroll_deduction_consent).toBe(true);
    expect(link.consent_signed_at).not.toBeNull();
    expect(await lastAuditEventType(link.id)).toBe('customer_employment.linked');
  });

  it('detects a duplicate (customer_id, employer_id) link', async () => {
    const customerId = await makeCustomer();
    const employer = await employers.create(employerInput(), SYSTEM_ACTOR);
    const input = {
      customer_id: customerId,
      employer_id: employer.id,
      salary_band: 'low' as const,
    };
    await employment.link(input, SYSTEM_ACTOR);
    await expect(employment.link(input, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      DuplicateEmploymentError,
    );
  });

  it('walks employment lifecycle: active → on_leave → active → suspended → active → left → rejoin', async () => {
    const customerId = await makeCustomer();
    const employer = await employers.create(employerInput(), SYSTEM_ACTOR);
    const link = await employment.link(
      { customer_id: customerId, employer_id: employer.id, salary_band: 'mid' },
      SYSTEM_ACTOR,
    );

    const onLeave = await employment.transition(link.id, { event: 'take_leave' }, SYSTEM_ACTOR);
    expect(onLeave.status).toBe('on_leave');
    const back = await employment.transition(link.id, { event: 'return_from_leave' }, SYSTEM_ACTOR);
    expect(back.status).toBe('active');

    const suspended = await employment.transition(
      link.id,
      { event: 'suspend', reason: 'Pending HR review' },
      SYSTEM_ACTOR,
    );
    expect(suspended.status).toBe('suspended');
    const reinstated = await employment.transition(link.id, { event: 'reinstate' }, SYSTEM_ACTOR);
    expect(reinstated.status).toBe('active');

    const left = await employment.transition(link.id, { event: 'leave_employer' }, SYSTEM_ACTOR);
    expect(left.status).toBe('left_employer');
    const rejoined = await employment.transition(link.id, { event: 'rejoin' }, SYSTEM_ACTOR);
    expect(rejoined.status).toBe('active');
  });

  it('rejects illegal employment transitions', async () => {
    const customerId = await makeCustomer();
    const employer = await employers.create(employerInput(), SYSTEM_ACTOR);
    const link = await employment.link(
      { customer_id: customerId, employer_id: employer.id, salary_band: 'unknown' },
      SYSTEM_ACTOR,
    );
    await expect(
      employment.transition(link.id, { event: 'reinstate' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(IllegalEmploymentTransitionError);
  });

  it('records and revokes payroll consent and marks verified', async () => {
    const customerId = await makeCustomer();
    const employer = await employers.create(employerInput(), SYSTEM_ACTOR);
    const link = await employment.link(
      { customer_id: customerId, employer_id: employer.id, salary_band: 'mid' },
      SYSTEM_ACTOR,
    );

    const granted = await employment.recordPayrollConsent(link.id, { granted: true }, SYSTEM_ACTOR);
    expect(granted.payroll_deduction_consent).toBe(true);
    expect(granted.consent_signed_at).not.toBeNull();

    const revoked = await employment.recordPayrollConsent(
      link.id,
      { granted: false },
      SYSTEM_ACTOR,
    );
    expect(revoked.payroll_deduction_consent).toBe(false);
    expect(revoked.consent_signed_at).toBeNull();

    const verified = await employment.markVerified(link.id, SYSTEM_ACTOR);
    expect(verified.verified_at).not.toBeNull();
    expect(await lastAuditEventType(link.id)).toBe('customer_employment.verified');
  });

  it('lists employment by customer / employer / status', async () => {
    const customerId = await makeCustomer();
    const emp = await employers.create(employerInput(), SYSTEM_ACTOR);
    const link = await employment.link(
      { customer_id: customerId, employer_id: emp.id, salary_band: 'low' },
      SYSTEM_ACTOR,
    );

    const byCustomer = await employment.list({ customer_id: customerId });
    expect(byCustomer.map((r) => r.id)).toContain(link.id);

    const byEmployer = await employment.list({ employer_id: emp.id });
    expect(byEmployer.map((r) => r.id)).toContain(link.id);

    const byStatus = await employment.list({ status: 'active', limit: 200 });
    expect(byStatus.map((r) => r.id)).toContain(link.id);
  });

  it('throws not-found for unknown ids', async () => {
    await expect(employers.get(randomUUID())).rejects.toBeInstanceOf(EmployerNotFoundError);
    await expect(employment.get(randomUUID())).rejects.toBeInstanceOf(EmploymentNotFoundError);
    // Silence unused-imports.
    void and;
  });
});
