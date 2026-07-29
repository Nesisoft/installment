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
