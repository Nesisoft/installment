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
  /** Where the signed mandate is, or why it was withdrawn. Kept on the audit row. */
  note: z.string().trim().min(3).max(500).optional(),
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

/**
 * How a job was confirmed. Verification raises what a first-time customer may
 * borrow (the starter policy's employer tier), so it records what was checked,
 * not just that somebody pressed a button.
 */
export const EMPLOYMENT_VERIFICATION_METHODS = [
  /** The employer's HR or payroll office confirmed it, by phone or in writing. */
  'employer_confirmed',
  /** The customer is on a staff list or payroll file the employer sent us. */
  'employer_list',
  /** A recent payslip in the customer's name, from this employer. */
  'payslip',
] as const;

export const verifyEmploymentSchema = z.object({
  method: z.enum(EMPLOYMENT_VERIFICATION_METHODS),
  /** What was checked, and with whom: "Ama, GES HR, by phone, 14 Oct". */
  note: z.string().trim().min(3).max(500),
});
export type VerifyEmploymentInput = z.infer<typeof verifyEmploymentSchema>;

export const unverifyEmploymentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type UnverifyEmploymentInput = z.infer<typeof unverifyEmploymentSchema>;

const flag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

/** The console's list of links: with names, filterable by whether they are verified. */
export const listEmploymentForConsoleSchema = z.object({
  customer_id: uuid.optional(),
  employer_id: uuid.optional(),
  status: z.enum(['active', 'left_employer', 'on_leave', 'suspended']).optional(),
  verified: flag.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListEmploymentForConsoleInput = z.input<typeof listEmploymentForConsoleSchema>;

export const listEmployersForConsoleSchema = z.object({
  status: z.enum(['pending', 'active', 'paused', 'terminated']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListEmployersForConsoleInput = z.input<typeof listEmployersForConsoleSchema>;
