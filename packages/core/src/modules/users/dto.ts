import { z } from 'zod';
import { ghPhoneNumber } from '../../shared/validators/ghana';

const password = z.string().min(8).max(200);
const roleNames = z.array(z.string().min(1)).optional();

export const createStaffSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password,
  user_type: z.enum(['admin', 'agent']),
  roleNames,
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const createMerchantUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password,
  /** The merchant this login belongs to — scopes the merchant portal to it. */
  merchant_id: z.string().uuid().optional(),
  roleNames,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateMerchantUserInput = z.infer<typeof createMerchantUserSchema>;

export const createCustomerUserSchema = z.object({
  phone: ghPhoneNumber,
  name: z.string().trim().min(1).max(120),
  email: z.string().email().optional(),
  roleNames,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateCustomerUserInput = z.infer<typeof createCustomerUserSchema>;

/**
 * An administrator gives a member of staff a temporary password. The reason is
 * kept on the audit row; the password never is.
 */
export const resetStaffPasswordSchema = z.object({
  temporary_password: password,
  reason: z.string().trim().min(3).max(500),
});
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordSchema>;

export const setUserActiveSchema = z.object({
  /** Why the account is being switched off or back on. Kept on the audit row. */
  reason: z.string().trim().min(3).max(500),
});
export type SetUserActiveInput = z.infer<typeof setUserActiveSchema>;
