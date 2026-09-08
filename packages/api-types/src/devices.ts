import { z } from 'zod';

// Mirrors packages/core/src/modules/notifications/devices.service.ts.
// Browser-safe copy: this package never imports the backend packages.

/** The handsets Expo will issue a push token for. */
export const DEVICE_PLATFORMS = ['android', 'ios', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * The two shapes Expo issues push tokens in.
 *
 * Kept here rather than only on the server because the client is where a wrong
 * token can still be caught cheaply. `getExpoPushTokenAsync` returns a device
 * token instead of an Expo one when the project is misconfigured, and posting
 * that gets a 400 the app has no way to explain — better to recognise it
 * before the request than to read it out of a server log later.
 */
export const EXPO_PUSH_TOKEN_RE = /^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/;

export const registerDeviceSchema = z.object({
  expo_token: z.string().trim().min(1).max(255).regex(EXPO_PUSH_TOKEN_RE, 'Not an Expo push token'),
  platform: z.enum(DEVICE_PLATFORMS),
  app_version: z.string().trim().max(40).optional(),
  device_name: z.string().trim().max(120).optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

/**
 * A registered handset, as `POST /me/devices` and `POST /merchant/devices`
 * return it.
 *
 * Exactly one of `customer_id` and `merchant_id` is set — `push_devices_one_owner`
 * is a CHECK, not a convention. A phone with both apps on it moves between the
 * two as its owner signs in, because the token is unique across the whole
 * table: one token is one handset, and two rows for one handset would deliver
 * somebody else's notifications to it.
 */
export interface PushDeviceView {
  id: string;
  customer_id: string | null;
  merchant_id: string | null;
  expo_token: string;
  platform: DevicePlatform;
  app_version: string | null;
  device_name: string | null;
  is_active: boolean;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}
