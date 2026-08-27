import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, schema } from '@installment/db';
import { CardAuthorizationService } from './card-authorization.service';

const { db, pool } = createTestDb();
const cards = new CardAuthorizationService(db);

afterAll(async () => {
  await pool.end();
});

async function freshCustomer(): Promise<string> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      first_name: 'Card',
      last_name: 'Holder',
      email: `card-${randomUUID()}@example.com`,
      phone: `+2332${Math.floor(10000000 + Math.random() * 89999999)}`,
    })
    .returning({ id: schema.customers.id });
  return row!.id;
}

function auth(over: Record<string, unknown> = {}) {
  return {
    authorization_code: `AUTH_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    signature: `SIG_${randomUUID().slice(0, 8)}`,
    last4: '4081',
    brand: 'visa',
    card_type: 'visa',
    bank: 'TEST BANK',
    exp_month: '12',
    exp_year: String(new Date().getUTCFullYear() + 2),
    reusable: true,
    ...over,
  };
}

describe('CardAuthorizationService (integration)', () => {
  /**
   * The guard that matters most. Paystack marks some authorizations single-use,
   * and they look identical in the response. Storing one means the collector
   * picks it, the debit fails, and the customer is pushed toward default for a
   * card that was never chargeable.
   */
  it('refuses to store a non-reusable authorization', async () => {
    const customerId = await freshCustomer();

    const saved = await cards.record(customerId, auth({ reusable: false }));

    expect(saved).toBeNull();
    expect(await cards.findUsable(customerId)).toBeNull();
    expect(await cards.listForCustomer(customerId)).toHaveLength(0);
  });

  it('stores a reusable authorization and offers it for collection', async () => {
    const customerId = await freshCustomer();
    const a = auth();

    const saved = await cards.record(customerId, a);
    expect(saved?.authorization_code).toBe(a.authorization_code);
    expect(saved?.last4).toBe('4081');
    expect(saved?.reusable).toBe(true);

    const usable = await cards.findUsable(customerId);
    expect(usable?.authorization_code).toBe(a.authorization_code);
  });

  it('updates the same card rather than accumulating duplicates', async () => {
    const customerId = await freshCustomer();
    const a = auth({ last4: '1111' });

    await cards.record(customerId, a);
    await cards.record(customerId, { ...a, last4: '2222' });

    const all = await cards.listForCustomer(customerId);
    expect(all).toHaveLength(1);
    expect(all[0]!.last4).toBe('2222');
  });

  /**
   * Expiry is checked here rather than left to the provider: charging a card
   * everyone can see has expired burns an attempt, and attempts are what push a
   * schedule toward default.
   */
  it('will not offer an expired card', async () => {
    const customerId = await freshCustomer();
    await cards.record(customerId, auth({ exp_month: '01', exp_year: '2020' }));

    expect(await cards.findUsable(customerId)).toBeNull();
    // Still on file, just not chargeable — the customer can see what expired.
    expect(await cards.listForCustomer(customerId)).toHaveLength(1);
  });

  it('offers a card whose expiry the provider did not tell us', async () => {
    // Unknown expiry is not treated as expired: the provider is the authority,
    // and discarding it here would throw away a working card.
    const customerId = await freshCustomer();
    await cards.record(customerId, auth({ exp_month: undefined, exp_year: undefined }));

    expect(await cards.findUsable(customerId)).not.toBeNull();
  });

  it('stops offering a card once it is revoked', async () => {
    const customerId = await freshCustomer();
    const a = auth();
    await cards.record(customerId, a);

    await cards.revoke(a.authorization_code, 'card_declined_permanently');

    expect(await cards.findUsable(customerId)).toBeNull();
    const [row] = await cards.listForCustomer(customerId);
    expect(row!.status).toBe('revoked');
    expect(row!.revoked_reason).toBe('card_declined_permanently');
  });

  it('brings a revoked card back when it is presented working again', async () => {
    const customerId = await freshCustomer();
    const a = auth();
    await cards.record(customerId, a);
    await cards.revoke(a.authorization_code, 'temporary');

    await cards.record(customerId, a);

    expect(await cards.findUsable(customerId)).not.toBeNull();
  });

  it('shows the customer their cards without ever exposing the credential', async () => {
    const customerId = await freshCustomer();
    const a = auth({ last4: '9999', brand: 'mastercard' });
    await cards.record(customerId, a);

    const view = await cards.listViewForCustomer(customerId);

    expect(view).toHaveLength(1);
    expect(view[0]!.last4).toBe('9999');
    expect(view[0]!.brand).toBe('mastercard');
    expect(view[0]!.is_usable).toBe(true);
    // The authorization code can charge the card. It must not appear in
    // anything handed to a client.
    expect(JSON.stringify(view)).not.toContain(a.authorization_code);
    expect(Object.keys(view[0]!)).not.toContain('authorization_code');
  });

  it('removes a card, drops its credential, and stops offering it', async () => {
    const customerId = await freshCustomer();
    const a = auth();
    const saved = await cards.record(customerId, a);

    expect(await cards.removeForCustomer(customerId, saved!.id)).toBe(true);

    expect(await cards.findUsable(customerId)).toBeNull();
    // The row survives so a person can see what they removed; the part that
    // could charge them does not.
    const [row] = await cards.listForCustomer(customerId);
    expect(row!.status).toBe('removed');
    expect(row!.authorization_code).toBeNull();
    expect(row!.last4).toBe('4081');
    // And it is gone from what the customer is shown.
    expect(await cards.listViewForCustomer(customerId)).toHaveLength(0);
  });

  it('will not remove a card belonging to someone else', async () => {
    const mine = await freshCustomer();
    const theirs = await freshCustomer();
    const saved = await cards.record(mine, auth());

    expect(await cards.removeForCustomer(theirs, saved!.id)).toBe(false);

    // Still mine, still chargeable.
    expect(await cards.findUsable(mine)).not.toBeNull();
  });

  /**
   * The guard that makes removal mean something. record() deliberately brings a
   * PROVIDER-revoked card back when it works again; applying that to a card the
   * customer deleted would put a credential they removed back on file behind
   * their back.
   */
  it('never resurrects a card the customer removed', async () => {
    const customerId = await freshCustomer();
    const a = auth();
    const saved = await cards.record(customerId, a);
    await cards.removeForCustomer(customerId, saved!.id);

    // A late webhook for a charge started before the removal.
    await cards.record(customerId, a);

    const rows = await cards.listForCustomer(customerId);
    const removed = rows.find((r) => r.id === saved!.id);
    expect(removed!.status).toBe('removed');
    expect(removed!.authorization_code).toBeNull();
  });

  it('never offers one customer a card saved by another', async () => {
    const mine = await freshCustomer();
    const theirs = await freshCustomer();
    await cards.record(mine, auth());

    expect(await cards.findUsable(theirs)).toBeNull();
  });
});
