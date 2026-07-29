import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@installment/db';
import { AddressesService } from './addresses.service';
import { AddressNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB)('AddressesService (integration)', () => {
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL! });
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
});
