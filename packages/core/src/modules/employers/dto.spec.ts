import { describe, expect, it } from 'vitest';
import {
  createEmployerSchema,
  linkEmploymentSchema,
  listEmployersSchema,
  recordPayrollConsentSchema,
  transitionEmployerSchema,
  transitionEmploymentSchema,
} from './dto';

describe('createEmployerSchema', () => {
  it('accepts a minimal employer with defaults', () => {
    expect(createEmployerSchema.parse({ name: 'Govt of Ghana' })).toMatchObject({
      name: 'Govt of Ghana',
      payroll_cycle: 'monthly',
    });
  });

  it('rejects unknown sector or invalid payroll_cycle', () => {
    expect(createEmployerSchema.safeParse({ name: 'X', sector: 'crypto' }).success).toBe(false);
    expect(createEmployerSchema.safeParse({ name: 'X', payroll_cycle: 'daily' }).success).toBe(
      false,
    );
  });
});

describe('transitionEmployerSchema', () => {
  it('accepts each legal event', () => {
    for (const event of ['activate', 'pause', 'resume', 'terminate'] as const) {
      expect(transitionEmployerSchema.parse({ event })).toEqual({ event });
    }
  });
  it('rejects unknown events', () => {
    expect(transitionEmployerSchema.safeParse({ event: 'fire' }).success).toBe(false);
  });
});

describe('listEmployersSchema', () => {
  it('defaults limit + offset and accepts a status filter', () => {
    expect(listEmployersSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(listEmployersSchema.parse({ status: 'active' }).status).toBe('active');
  });
});

describe('linkEmploymentSchema', () => {
  const ids = {
    customer_id: '11111111-1111-1111-1111-111111111111',
    employer_id: '22222222-2222-2222-2222-222222222222',
  };

  it('defaults salary_band=unknown and payroll_deduction_consent=false', () => {
    const parsed = linkEmploymentSchema.parse(ids);
    expect(parsed.salary_band).toBe('unknown');
    expect(parsed.payroll_deduction_consent).toBe(false);
  });

  it('rejects non-UUID ids and bad salary_band', () => {
    expect(linkEmploymentSchema.safeParse({ ...ids, customer_id: 'nope' }).success).toBe(false);
    expect(linkEmploymentSchema.safeParse({ ...ids, salary_band: 'huge' }).success).toBe(false);
  });
});

describe('transitionEmploymentSchema + recordPayrollConsentSchema', () => {
  it('accepts each legal employment event', () => {
    for (const event of [
      'leave_employer',
      'take_leave',
      'return_from_leave',
      'suspend',
      'reinstate',
      'rejoin',
    ] as const) {
      expect(transitionEmploymentSchema.parse({ event })).toEqual({ event });
    }
  });

  it('defaults payroll consent to granted=true', () => {
    expect(recordPayrollConsentSchema.parse({})).toEqual({ granted: true });
    expect(recordPayrollConsentSchema.parse({ granted: false })).toEqual({ granted: false });
  });
});
