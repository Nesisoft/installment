import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuid = z.string().uuid();
const SECTORS = ['public', 'private', 'ngo', 'university'] as const;
const PAYROLL_CYCLES = ['weekly', 'biweekly', 'monthly'] as const;
const SALARY_BANDS = ['unknown', 'low', 'mid', 'high'] as const;

// -------------------------------------------------------------- employers

export const createEmployerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sector: z.enum(SECTORS).optional(),
  payroll_cycle: z.enum(PAYROLL_CYCLES).default('monthly'),
  partnership_start_date: isoDate.optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().trim().min(7).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateEmployerInput = z.infer<typeof createEmployerSchema>;

export const updateEmployerSchema = createEmployerSchema.partial();
export type UpdateEmployerInput = z.infer<typeof updateEmployerSchema>;

export const transitionEmployerSchema = z.object({
  event: z.enum(['activate', 'pause', 'resume', 'terminate']),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionEmployerInput = z.infer<typeof transitionEmployerSchema>;

export const listEmployersSchema = z.object({
  status: z.enum(['pending', 'active', 'paused', 'terminated']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListEmployersInput = z.infer<typeof listEmployersSchema>;

// -------------------------------------------------- customer_employment

export const linkEmploymentSchema = z.object({
  customer_id: uuid,
  employer_id: uuid,
  employee_number: z.string().trim().min(1).max(50).optional(),
  salary_band: z.enum(SALARY_BANDS).default('unknown'),
  employment_start_date: isoDate.optional(),
  payroll_deduction_consent: z.boolean().default(false),
});
export type LinkEmploymentInput = z.infer<typeof linkEmploymentSchema>;

export const updateEmploymentSchema = z
  .object({
    employee_number: z.string().trim().min(1).max(50).nullable(),
    salary_band: z.enum(SALARY_BANDS),
    employment_start_date: isoDate.nullable(),
  })
  .partial();
export type UpdateEmploymentInput = z.infer<typeof updateEmploymentSchema>;

export const transitionEmploymentSchema = z.object({
  event: z.enum([
    'leave_employer',
    'take_leave',
    'return_from_leave',
    'suspend',
    'reinstate',
    'rejoin',
  ]),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransitionEmploymentInput = z.infer<typeof transitionEmploymentSchema>;

export const recordPayrollConsentSchema = z.object({
  /** Set to false to revoke a previously-granted consent. */
  granted: z.boolean().default(true),
});
export type RecordPayrollConsentInput = z.infer<typeof recordPayrollConsentSchema>;

export const listEmploymentSchema = z.object({
  customer_id: uuid.optional(),
  employer_id: uuid.optional(),
  status: z.enum(['active', 'left_employer', 'on_leave', 'suspended']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListEmploymentInput = z.infer<typeof listEmploymentSchema>;
