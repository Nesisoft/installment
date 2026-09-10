import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { AddressesService } from './addresses.service';
import { AddressNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('AddressesService (integration)', () => {
  const { db, pool } = createTestDb();
  const addresses = new AddressesService(db);

  afterAll(async () => {
    await pool.end();
  });

  async function freshCustomer(): Promise<string> {
    const id = randomUUID();
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Owusu',
        email: `addr+${id}@example.gh`,
        phone: `+233${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  const addr = () => ({
    recipient: 'Ama Owusu',
    phone: '+233201234567',
    region: 'Greater Accra',
    city: 'Accra',
  });

  it('creates, lists, gets, updates and removes an address', async () => {
    const customerId = await freshCustomer();
    const created = await addresses.create(customerId, addr());
    expect(created.customer_id).toBe(customerId);
    expect(created.is_default).toBe(false);

    expect((await addresses.list(customerId)).map((a) => a.id)).toContain(created.id);
    expect((await addresses.get(customerId, created.id)).id).toBe(created.id);

    const updated = await addresses.update(customerId, created.id, { city: 'Kumasi' });
    expect(updated.city).toBe('Kumasi');

    await addresses.remove(customerId, created.id);
    await expect(addresses.get(customerId, created.id)).rejects.toBeInstanceOf(
      AddressNotFoundError,
    );
  });

  it('keeps at most one default and switches it', async () => {
    const customerId = await freshCustomer();
    const a1 = await addresses.create(customerId, { ...addr(), is_default: true });
    const a2 = await addresses.create(customerId, { ...addr(), is_default: true });

    // Creating a2 as default cleared a1.
    const defaults = (await addresses.list(customerId)).filter((a) => a.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(a2.id);

    await addresses.setDefault(customerId, a1.id);
    const defaults2 = (await addresses.list(customerId)).filter((a) => a.is_default);
    expect(defaults2.map((a) => a.id)).toEqual([a1.id]);
  });

  it("does not leak another customer's address", async () => {
    const c1 = await freshCustomer();
    const c2 = await freshCustomer();
    const a = await addresses.create(c1, addr());
    await expect(addresses.get(c2, a.id)).rejects.toBeInstanceOf(AddressNotFoundError);
  });

  // ------------------------------------------------- what a client actually sends

  it('accepts the body the shopper app actually sends', async () => {
    // The live one. The mobile address sheet sends null for the three fields a
    // shopper left blank — the columns are nullable and the `Address` type the
    // client holds declares them `string | null` — and the DTO said
    // `.optional()`, which in Zod refuses null outright. So EVERY attempt to
    // save an address from the phone answered 400, and a shopper with none on
    // file could not finish a courier checkout at all. No test sent a null, so
    // nothing caught it.
    const customerId = await freshCustomer();

    const created = await addresses.create(customerId, {
      ...addr(),
      area: null,
      landmark: null,
      ghanapost_gps: null,
      is_default: true,
    });

    expect(created.area).toBeNull();
    expect(created.landmark).toBeNull();
    expect(created.ghanapost_gps).toBeNull();
  });

  it('treats an absent field and a null one the same way', async () => {
    // Two clients, two habits: the web form spreads its optionals in
    // conditionally and the phone sends null. Neither is a mistake, and the
    // column must not be able to tell them apart.
    const customerId = await freshCustomer();

    const omitted = await addresses.create(customerId, addr());
    const nulled = await addresses.create(customerId, { ...addr(), area: null });

    expect(omitted.area).toBeNull();
    expect(nulled.area).toBeNull();
  });

  it('still keeps a GhanaPost code when one is given', async () => {
    // The field has always been accepted and no client has ever filled it, so
    // this pins that the write path is real rather than decorative.
    const customerId = await freshCustomer();

    const created = await addresses.create(customerId, { ...addr(), ghanapost_gps: 'GA-183-7192' });

    expect(created.ghanapost_gps).toBe('GA-183-7192');
  });

  it('refuses a patch that changes nothing, rather than 500ing', async () => {
    // `.partial()` accepted `{}`, which reached Drizzle with no columns to set
    // and threw a bare Error('No values to set') — a name the exception filter
    // does not classify, so a caller's mistake became a 500 and a Sentry alert.
    const customerId = await freshCustomer();
    const created = await addresses.create(customerId, addr());

    await expect(addresses.update(customerId, created.id, {})).rejects.toThrow(/Nothing to change/);
  });

  // ------------------------------------------------------------ the default

  it('promotes another address when the default is deleted', async () => {
    // `addresses_one_default_idx` enforces at MOST one default and nothing
    // enforced at least one. Deleting the default left a customer with several
    // addresses and none marked — and checkout's `shipping_address_id` is
    // optional, so the next order did not fail, it quietly fell through to the
    // national delivery price.
    const customerId = await freshCustomer();
    const first = await addresses.create(customerId, addr());
    const second = await addresses.create(customerId, { ...addr(), city: 'Kumasi' });
    await addresses.setDefault(customerId, first.id);

    await addresses.remove(customerId, first.id);

    const left = await addresses.list(customerId);
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(second.id);
    expect(left[0]?.is_default).toBe(true);
  });

  it('leaves a non-default deletion alone', async () => {
    const customerId = await freshCustomer();
    const keep = await addresses.create(customerId, addr());
    const drop = await addresses.create(customerId, { ...addr(), city: 'Kumasi' });
    await addresses.setDefault(customerId, keep.id);

    await addresses.remove(customerId, drop.id);

    const left = await addresses.list(customerId);
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(keep.id);
    expect(left[0]?.is_default).toBe(true);
  });

  it('is fine with deleting the last address there is', async () => {
    const customerId = await freshCustomer();
    const only = await addresses.create(customerId, { ...addr(), is_default: true });

    await addresses.remove(customerId, only.id);

    expect(await addresses.list(customerId)).toEqual([]);
  });

  it('does not promote across customers', async () => {
    // The promotion query is scoped by customer_id; without that a deletion
    // would hand somebody else's address a default flag.
    const mine = await freshCustomer();
    const theirs = await freshCustomer();
    const myOnly = await addresses.create(mine, { ...addr(), is_default: true });
    const theirOnly = await addresses.create(theirs, { ...addr(), is_default: false });

    await addresses.remove(mine, myOnly.id);

    const [still] = await addresses.list(theirs);
    expect(still?.id).toBe(theirOnly.id);
    expect(still?.is_default).toBe(false);
  });

  it('refuses to delete an address that is not yours', async () => {
    const mine = await freshCustomer();
    const theirs = await freshCustomer();
    const theirAddress = await addresses.create(theirs, addr());

    await expect(addresses.remove(mine, theirAddress.id)).rejects.toThrow(AddressNotFoundError);
    expect(await addresses.list(theirs)).toHaveLength(1);
  });
});
