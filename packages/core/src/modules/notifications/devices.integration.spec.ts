import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { MerchantsService } from '../merchants/merchants.service';
import { DevicesService } from './devices.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * Push device registration, now that a device can belong to either side.
 *
 * Against Postgres because the two rules worth having are in the schema, not in
 * the service: the `push_devices_one_owner` CHECK, and the global UNIQUE on
 * `expo_token` that makes one token mean one phone.
 */
describe.skipIf(!RUN_DB)('DevicesService (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const devices = new DevicesService(db);
  const merchants = new MerchantsService(db, audit);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const token = () => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

  async function newMerchant() {
    const s = randomUUID();
    return merchants.create(
      {
        business_name: `Adepa ${s}`,
        legal_name: `Adepa Ghana ${s}`,
        email: `ops+${s}@adepa.gh`,
        phone: '+233244123456',
      },
      ACTOR,
    );
  }

  async function newCustomer() {
    const s = randomUUID();
    return customers.register(
      {
        first_name: 'Ama',
        last_name: 'Mensah',
        email: `ama+${s}@fixture.local`,
        phone: `024${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        consents: { data_processing: true },
      },
      ACTOR,
    );
  }

  const handset = (t: string) => ({
    expo_token: t,
    platform: 'android' as const,
    device_name: 'Tecno Spark',
  });

  // ------------------------------------------------------------- both owners

  it('registers a merchant handset — the column that used to be NOT NULL', async () => {
    const merchant = await newMerchant();
    const t = token();

    const row = await devices.register({ merchantId: merchant.id }, handset(t));

    expect(row.merchant_id).toBe(merchant.id);
    expect(row.customer_id).toBeNull();
    expect(row.is_active).toBe(true);
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);
  });

  it('still registers a customer handset', async () => {
    const customer = await newCustomer();
    const row = await devices.register({ customerId: customer.id }, handset(token()));

    expect(row.customer_id).toBe(customer.id);
    expect(row.merchant_id).toBeNull();
  });

  it('keeps the two lists apart', async () => {
    const merchant = await newMerchant();
    const customer = await newCustomer();
    await devices.register({ merchantId: merchant.id }, handset(token()));
    await devices.register({ customerId: customer.id }, handset(token()));

    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);
    expect(await devices.listActive({ customerId: customer.id })).toHaveLength(1);
  });

  // ---------------------------------------------------------- one phone, one row

  it('moves a handset across owners rather than listing it twice', async () => {
    // A shopkeeper signing into the merchant app on the phone they shop with.
    // Expo reissues the same token to whoever holds the device, so two rows
    // would mean the phone gets somebody else's notifications.
    const customer = await newCustomer();
    const merchant = await newMerchant();
    const t = token();

    await devices.register({ customerId: customer.id }, handset(t));
    const moved = await devices.register({ merchantId: merchant.id }, handset(t));

    expect(moved.merchant_id).toBe(merchant.id);
    expect(moved.customer_id).toBeNull();
    expect(await devices.listActive({ customerId: customer.id })).toHaveLength(0);
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);

    const rows = await db
      .select()
      .from(schema.push_devices)
      .where(eq(schema.push_devices.expo_token, t));
    expect(rows).toHaveLength(1);
  });

  it('re-registering the same handset refreshes it instead of duplicating', async () => {
    const merchant = await newMerchant();
    const t = token();
    const first = await devices.register({ merchantId: merchant.id }, handset(t));
    const again = await devices.register(
      { merchantId: merchant.id },
      { ...handset(t), app_version: '1.4.0' },
    );

    expect(again.id).toBe(first.id);
    expect(again.app_version).toBe('1.4.0');
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);
  });

  it('reactivates a handset that had signed out', async () => {
    const merchant = await newMerchant();
    const t = token();
    await devices.register({ merchantId: merchant.id }, handset(t));
    await devices.deactivate({ merchantId: merchant.id }, t);
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(0);

    await devices.register({ merchantId: merchant.id }, handset(t));
    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(1);
  });

  // ------------------------------------------------------------------ schema

  it('refuses a device with two owners, or none', async () => {
    const merchant = await newMerchant();
    const customer = await newCustomer();

    await expect(
      db.insert(schema.push_devices).values({
        merchant_id: merchant.id,
        customer_id: customer.id,
        expo_token: token(),
        platform: 'android',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.push_devices).values({ expo_token: token(), platform: 'android' }),
    ).rejects.toThrow();
  });

  it('takes the handsets with the merchant when the merchant is deleted', async () => {
    const merchant = await newMerchant();
    const t = token();
    await devices.register({ merchantId: merchant.id }, handset(t));

    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.id));

    const rows = await db
      .select()
      .from(schema.push_devices)
      .where(eq(schema.push_devices.expo_token, t));
    expect(rows).toHaveLength(0);
  });

  // ------------------------------------------------------------ deactivation

  it('scopes sign-out to the owner, so one merchant cannot silence another', async () => {
    const mine = await newMerchant();
    const theirs = await newMerchant();
    const t = token();
    await devices.register({ merchantId: mine.id }, handset(t));

    await devices.deactivate({ merchantId: theirs.id }, t);

    expect(await devices.listActive({ merchantId: mine.id })).toHaveLength(1);
  });

  it('deactivates by token alone when the provider disowns it', async () => {
    // DeviceNotRegistered is about the phone, not the account, so this one is
    // deliberately unscoped.
    const merchant = await newMerchant();
    const t = token();
    await devices.register({ merchantId: merchant.id }, handset(t));

    await devices.deactivateToken(t);

    expect(await devices.listActive({ merchantId: merchant.id })).toHaveLength(0);
  });

  it('refuses a token that is not an Expo one', async () => {
    const merchant = await newMerchant();
    await expect(
      devices.register({ merchantId: merchant.id }, { expo_token: 'nope', platform: 'android' }),
    ).rejects.toThrow();
  });
});
