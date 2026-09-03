import { and, eq, isNotNull } from 'drizzle-orm';
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
 * Whose handset this is. Exactly one of the two, which the
 * `push_devices_one_owner` CHECK also enforces in the schema.
 */
export type DeviceOwner =
  | { customerId: string; merchantId?: never }
  | {
      merchantId: string;
      customerId?: never;
    };

/** The owner columns as a WHERE fragment, so no caller writes them by hand. */
function ownerWhere(owner: DeviceOwner) {
  return 'customerId' in owner && owner.customerId !== undefined
    ? eq(dev.customer_id, owner.customerId)
    : eq(dev.merchant_id, owner.merchantId!);
}

function ownerColumns(owner: DeviceOwner) {
  return 'customerId' in owner && owner.customerId !== undefined
    ? { customer_id: owner.customerId, merchant_id: null }
    : { customer_id: null, merchant_id: owner.merchantId! };
}

/**
 * Expo push tokens — the addresses the push channel sends to.
 *
 * Moved here from `commerce/modules/shopper` with the transport (0017): a
 * merchant handset has nothing to do with the shopper module, and the notifier
 * that reads these rows lives in this one.
 *
 * A token is unique across the whole table, not per owner, and that is the
 * interesting rule. Expo reissues the same token to whoever holds a handset, so
 * one token is one phone. A shopkeeper who signs into the merchant app on the
 * phone they used to shop with moves the token across — and the important part
 * is that the old registration is *replaced*, because two rows for one handset
 * would deliver somebody else's notifications to it.
 */
export class DevicesService {
  constructor(private readonly db: Database) {}

  async register(owner: DeviceOwner, rawInput: unknown): Promise<PushDevice> {
    const input: RegisterDeviceInput = registerDeviceSchema.parse(rawInput);
    const rows = await this.db
      .insert(dev)
      .values({
        ...ownerColumns(owner),
        expo_token: input.expo_token,
        platform: input.platform,
        app_version: input.app_version ?? null,
        device_name: input.device_name ?? null,
      })
      .onConflictDoUpdate({
        target: dev.expo_token,
        set: {
          // Both columns, always: moving a handset from a customer to a
          // merchant has to clear the side it came from, or the CHECK fails
          // and — if it did not — the phone would be on two send lists.
          ...ownerColumns(owner),
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
  async deactivate(owner: DeviceOwner, expoToken: string): Promise<void> {
    await this.db
      .update(dev)
      .set({ is_active: false })
      .where(and(ownerWhere(owner), eq(dev.expo_token, expoToken)));
  }

  async listActive(owner: DeviceOwner): Promise<PushDevice[]> {
    return this.db
      .select()
      .from(dev)
      .where(and(ownerWhere(owner), eq(dev.is_active, true)));
  }

  /**
   * Stop sending to a token the provider has disowned.
   *
   * Called on `DeviceNotRegistered`, which means the app is gone from that
   * handset. Keyed on the token alone rather than on an owner: the point is
   * that this phone is unreachable, whoever it belongs to, and the alternative
   * is burning a request on it for every notification forever.
   */
  async deactivateToken(expoToken: string): Promise<void> {
    await this.db.update(dev).set({ is_active: false }).where(eq(dev.expo_token, expoToken));
  }

  /** Every active merchant handset, for a send-side sweep or an ops count. */
  async countActiveMerchantDevices(): Promise<number> {
    const rows = await this.db
      .select({ token: dev.expo_token })
      .from(dev)
      .where(and(isNotNull(dev.merchant_id), eq(dev.is_active, true)));
    return rows.length;
  }
}
