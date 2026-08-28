import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@installment/db';

const dev = schema.push_devices;

export const registerDeviceSchema = z.object({
  // Expo issues these in two shapes; accepting anything else means storing a
  // token the push service will reject at send time, when nobody is watching.
  expo_token: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/, 'Not an Expo push token'),
  platform: z.enum(['android', 'ios', 'web']),
  app_version: z.string().trim().max(40).optional(),
  device_name: z.string().trim().max(120).optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export type PushDevice = typeof schema.push_devices.$inferSelect;

/**
 * Expo push tokens, so the notification channel has somewhere to send.
 *
 * Registration only — `NotificationService` is still SMS-only, and adding a push
 * transport is its own slice. Shipping the registration first means that when
 * the transport lands there is already an installed base to reach.
 *
 * A token is unique across customers, not per customer: handsets get reset and
 * resold, and Expo reissues the same token to whoever holds the device. Binding
 * it to the newest customer is what stops one person's payment reminders from
 * arriving on another person's phone.
 */
export class DevicesService {
  constructor(private readonly db: Database) {}

  async register(customerId: string, rawInput: unknown): Promise<PushDevice> {
    const input: RegisterDeviceInput = registerDeviceSchema.parse(rawInput);
    const rows = await this.db
      .insert(dev)
      .values({
        customer_id: customerId,
        expo_token: input.expo_token,
        platform: input.platform,
        app_version: input.app_version ?? null,
        device_name: input.device_name ?? null,
      })
      .onConflictDoUpdate({
        target: dev.expo_token,
        set: {
          customer_id: customerId,
          platform: input.platform,
          app_version: input.app_version ?? null,
          device_name: input.device_name ?? null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        },
      })
      .returning();
    return rows[0]!;
  }

  /** Sign-out: stop sending to this handset without forgetting it existed. */
  async deactivate(customerId: string, expoToken: string): Promise<void> {
    await this.db
      .update(dev)
      .set({ is_active: false })
      .where(and(eq(dev.customer_id, customerId), eq(dev.expo_token, expoToken)));
  }

  async listActive(customerId: string): Promise<PushDevice[]> {
    return this.db
      .select()
      .from(dev)
      .where(and(eq(dev.customer_id, customerId), eq(dev.is_active, true)));
  }
}
