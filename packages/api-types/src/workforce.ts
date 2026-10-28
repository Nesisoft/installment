import type {
  EmployerSector,
  EmployerStatus,
  EmploymentStatus,
  PayrollCycle,
  SalaryBand,
} from './enums';
import type { CustomerEmployment, Employer } from './domain';

// The admin console's employer, employment-verification and staff pages.

// --- Employers ----------------------------------------------------------------

/** An employer with how many of its staff are linked, verified and consenting. */
export interface EmployerSummary extends Employer {
  /** Links to customers who hold a job there now. */
  active_links: number;
  verified_links: number;
  consented_links: number;
}

export type EmployerCounts = Record<EmployerStatus | 'all', number>;

export interface ListEmployerSummaryParams {
  status?: EmployerStatus;
  /** Part of the name. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** Body of POST /admin/employers. */
export interface CreateEmployerInput {
  name: string;
  sector?: EmployerSector;
  payroll_cycle?: PayrollCycle;
  /** YYYY-MM-DD */
  partnership_start_date?: string;
  contact_email?: string;
  contact_phone?: string;
}
export type UpdateEmployerInput = Partial<CreateEmployerInput>;

export type EmployerEvent = 'activate' | 'pause' | 'resume' | 'terminate';
export interface TransitionEmployerInput {
  event: EmployerEvent;
  reason?: string;
}

// --- Employment links ---------------------------------------------------------

/** A link as the console shows it: the job, and whose job at which employer. */
export interface EmploymentRow extends CustomerEmployment {
  customer_name: string | null;
  customer_phone: string | null;
  employer_name: string;
  employer_status: EmployerStatus;
  created_at: string;
}

export interface ListEmploymentParams {
  customer_id?: string;
  employer_id?: string;
  status?: EmploymentStatus;
  /** `false` is the verification queue, oldest first. */
  verified?: boolean;
  limit?: number;
  offset?: number;
}

/** Body of POST /admin/employers/employment. */
export interface LinkEmploymentInput {
  customer_id: string;
  employer_id: string;
  employee_number?: string;
  salary_band?: SalaryBand;
  /** YYYY-MM-DD */
  employment_start_date?: string;
  payroll_deduction_consent?: boolean;
}

export type EmploymentEvent =
  | 'leave_employer'
  | 'take_leave'
  | 'return_from_leave'
  | 'suspend'
  | 'reinstate'
  | 'rejoin';
export interface TransitionEmploymentInput {
  event: EmploymentEvent;
  reason?: string;
}

/**
 * How a job was confirmed. Mirrors `EMPLOYMENT_VERIFICATION_METHODS` in
 * `packages/core/src/modules/employers/dto.ts` (checked by
 * `apps/api/src/common/api-types-mirror.spec.ts`).
 */
export const EMPLOYMENT_VERIFICATION_METHODS = [
  'employer_confirmed',
  'employer_list',
  'payslip',
] as const;
export type EmploymentVerificationMethod = (typeof EMPLOYMENT_VERIFICATION_METHODS)[number];

/** Body of POST /admin/employers/employment/:id/verify. */
export interface VerifyEmploymentInput {
  method: EmploymentVerificationMethod;
  /** What was checked, and with whom. 3–500 characters. */
  note: string;
}

/** Body of POST /admin/employers/employment/:id/unverify. */
export interface UnverifyEmploymentInput {
  reason: string;
}

/** Body of POST /admin/employers/employment/:id/consent. */
export interface RecordPayrollConsentInput {
  /** false withdraws consent. */
  granted: boolean;
  /** Where the signed mandate is, or why it was withdrawn. */
  note?: string;
}

// --- Staff --------------------------------------------------------------------

export type StaffUserType = 'admin' | 'agent';

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  user_type: StaffUserType;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: string[];
}

export interface StaffRole {
  name: string;
  description: string | null;
  permissions: string[];
  /** Active staff who hold it. */
  holders: number;
}

/** Body of POST /admin/users/staff. */
export interface CreateStaffInput {
  email: string;
  name: string;
  /** At least 8 characters. */
  password: string;
  user_type: StaffUserType;
  roleNames?: string[];
}

/** Body of POST /admin/users/:id/deactivate and /reactivate. */
export interface SetUserActiveInput {
  reason: string;
}
