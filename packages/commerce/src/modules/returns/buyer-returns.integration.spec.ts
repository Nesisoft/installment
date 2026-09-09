import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import {
  ApplicationsService,
  AuditLogger,
  CustomerPlansService,
  LedgerService,
  MerchantsService,
  PayoutRecorder,
  RefundService,
  ReserveReleaseService,
  SYSTEM_ACTORS,
  approveRequiredMerchantKyc,
} from '@installment/core';
import { StoresService } from '../stores/stores.service';
import { ProductsService } from '../catalog/products.service';
import { InventoryService } from '../catalog/inventory.service';
import { CartService } from '../orders/cart.service';
import { OrdersService } from '../orders/orders.service';
import { FulfilmentService } from '../fulfilment/fulfilment.service';
import { ReturnsService } from './returns.service';
import { CustomerReturnsService } from './customer-returns.service';
import { ReturnAlreadyDecidedError, ReturnNotFoundError } from './errors';

const RUN_DB = Boolean(process.env.DATABASE_URL);

/**
 * The buyer's own side of a return: withdrawing one, and reading the list.
 *
 * Two holes, closed together because they are the same hole from two angles.
 *
 * `order_returns.status` has permitted `'cancelled'` since 0020. `RETURN_STATUSES`
 * declares it, `listReturnsSchema` accepts it as a filter, the seller's queue
 * ships a `WITHDRAWN` label and an empty state reading "A buyer can withdraw a
 * request before you decide on it" — and no code path in this repository had
 * ever written it. The seller's copy was not a promise the system was slow to
 * keep; it was a promise nothing could keep.
 *
 * And `listForCustomer` returned bare `order_returns` rows: an order id, a
 * customer id and two amounts. Nothing a buyer could recognise a purchase from,
 * for a screen whose whole job is "which of my orders was this?".
 */
describe.skipIf(!RUN_DB)('the buyer’s own returns (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const ledger = new LedgerService(db);
  const merchants = new MerchantsService(db, audit);
  const stores = new StoresService(db, audit);
  const products = new ProductsService(db, audit);
  const inventory = new InventoryService(db);
  const applications = new ApplicationsService(db, audit);
  const payouts = new PayoutRecorder(db, ledger);
  const reserves = new ReserveReleaseService(db, ledger);
  const plans = new CustomerPlansService(db, audit, undefined, payouts, reserves);
  const cart = new CartService(db);
  const refunds = new RefundService(db, ledger, audit);
  const fulfilment = new FulfilmentService(db, audit, plans);
  const returns = new ReturnsService(db, ledger, audit, inventory, refunds);
  const buyer = new CustomerReturnsService(db);
  const orders = new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment);
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  async function shopper(): Promise<string> {
    const rows = await db
      .insert(schema.customers)
      .values({
        first_name: 'Ama',
        last_name: 'Boateng',
        email: `buyret-${randomUUID()}@fixture.local`,
        phone: `+2332${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
      })
      .returning({ id: schema.customers.id });
    return rows[0]!.id;
  }

  async function shop() {
    const id = randomUUID();
    const merchant = await merchants.create(
      {
        business_name: `Shop ${id}`,
        legal_name: `Shop Ltd ${id}`,
        email: `shop+${id}@example.gh`,
        phone: '+233244555555',
      },
      ACTOR,
    );
    const store = await stores.create(
      { merchant_id: merchant.id, slug: `shop-${id.slice(0, 8)}`, display_name: 'Shop' },
      ACTOR,
    );
    await approveRequiredMerchantKyc(db, merchant.id, ACTOR);
    await merchants.transition(merchant.id, { event: 'activate' }, ACTOR);
    await stores.transition(store.id, { event: 'activate' }, ACTOR);
    return { merchantId: merchant.id, storeId: store.id };
  }

  /** A paid, outright order. `titles` becomes one order line each. */
  async function paidOrder(titles: string[] = ['Ankara Wrap Dress'], price = 32_000) {
    const customerId = await shopper();
    const { merchantId, storeId } = await shop();
    for (const title of titles) {
      const product = await products.create(
        {
          store_id: storeId,
          title,
          base_price_pesewas: price,
          status: 'active',
          variants: [
            { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 10 },
          ],
        },
        ACTOR,
      );
      await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
    }
    const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
    const paid = await orders.confirmPayment(
      raised!.id,
      { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
      ACTOR,
    );
    return { order: paid, customerId, merchantId };
  }

  // ----------------------------------------------------------------- withdraw

  it('moves a request to cancelled, which nothing in this system could do before', async () => {
    const { order, customerId } = await paidOrder();
    const asked = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const withdrawn = await returns.withdraw(customerId, asked.id);

    expect(withdrawn.status).toBe('cancelled');
    // `order_returns_decided_together` requires exactly this: a withdrawal is
    // the request going away, not the seller answering it. Setting decided_at
    // here would violate the CHECK and the write would fail outright.
    expect(withdrawn.decided_at).toBeNull();
    expect(withdrawn.decided_by).toBeNull();
    expect(withdrawn.decision_note).toBeNull();
  });

  it('leaves the order exactly as it found it', async () => {
    const { order, customerId } = await paidOrder();
    const asked = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await returns.withdraw(customerId, asked.id);

    const [still] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    // Asking moved no money and touched no stock, so taking the ask back has
    // nothing to unwind. If `request` ever stops being inert, `withdraw` has to
    // grow the reversal and this assertion is what will notice.
    expect(still?.status).toBe('paid');
    const entries = await db.select().from(schema.ledger_entries);
    const balance = entries.reduce(
      (sum, r) =>
        sum + (r.direction === 'credit' ? Number(r.amount_pesewas) : -Number(r.amount_pesewas)),
      0,
    );
    expect(balance).toBe(0);
  });

  it('lets the buyer ask again afterwards', async () => {
    // The reason `order_returns_one_open_idx` is partial on 'requested'. A
    // withdrawal that permanently barred the order would be a worse outcome
    // than not offering the control at all.
    const { order, customerId } = await paidOrder();
    const first = await returns.request(customerId, order.id, { reason: 'Wrong size' });
    await returns.withdraw(customerId, first.id);

    const second = await returns.request(customerId, order.id, { reason: 'Actually, damaged' });

    expect(second.status).toBe('requested');
    expect(second.id).not.toBe(first.id);
  });

  it('puts it on the buyer’s own timeline', async () => {
    const { order, customerId } = await paidOrder();
    const asked = await returns.request(customerId, order.id, { reason: 'Wrong size' });

    await returns.withdraw(customerId, asked.id);

    const events = await db
      .select()
      .from(schema.order_events)
      .where(
        and(
          eq(schema.order_events.order_id, order.id),
          eq(schema.order_events.event_type, 'order.return_cancelled'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.label).toBe('Return withdrawn');
  });

  it('refuses once the seller has already decided', async () => {
    const { order, customerId, merchantId } = await paidOrder();
    const asked = await returns.request(customerId, order.id, { reason: 'Wrong size' });
    await returns.reject(asked.id, { decision_note: 'Outside the window' }, ACTOR, { merchantId });

    await expect(returns.withdraw(customerId, asked.id)).rejects.toThrow(ReturnAlreadyDecidedError);
  });

  it('answers "not found" for somebody else’s return, whatever its state', async () => {
    // The interesting half. `lockOpenReturn` checked the status BEFORE any
    // ownership scope, so a stranger probing an id would have been told
    // "already approved" — a 409 that confirms the row exists. Both a pending
    // and a decided return must read the same to somebody who does not own it.
    const mine = await paidOrder();
    const theirs = await paidOrder();
    const pending = await returns.request(theirs.customerId, theirs.order.id, { reason: 'Nope' });

    await expect(returns.withdraw(mine.customerId, pending.id)).rejects.toThrow(
      ReturnNotFoundError,
    );

    await returns.approve(pending.id, ACTOR, { merchantId: theirs.merchantId });
    await expect(returns.withdraw(mine.customerId, pending.id)).rejects.toThrow(
      ReturnNotFoundError,
    );
  });

  // --------------------------------------------------------------- projection

  it('gives the buyer an order number and an item summary, not a uuid', async () => {
    const { order, customerId } = await paidOrder(['Ankara Wrap Dress', 'Kente Scarf']);
    await returns.request(customerId, order.id, { reason: 'Wrong size' });

    const [row] = await buyer.list(customerId);

    expect(row?.orderNumber).toBe(order.order_number);
    expect(row?.refundPesewas).toBe(order.total_pesewas);
    expect(row?.reason).toBe('Wrong size');
    // Two lines on the order, so the summary names one and counts the rest.
    // Which one it names is not asserted: `order_items` has no position column
    // and the id tiebreak is `gen_random_uuid()`, so insertion order is not a
    // promise. Recorded in merchant-app.md as needing a `position`.
    expect(row?.itemSummary).toMatch(/^(Ankara Wrap Dress|Kente Scarf) \+ 1 more$/);
  });

  it('says whether the buyer can still take it back', async () => {
    const { order, customerId, merchantId } = await paidOrder();
    const asked = await returns.request(customerId, order.id, { reason: 'Wrong size' });
    expect((await buyer.list(customerId))[0]?.canWithdraw).toBe(true);

    await returns.reject(asked.id, { decision_note: 'No' }, ACTOR, { merchantId });

    expect((await buyer.list(customerId))[0]?.canWithdraw).toBe(false);
  });

  it('never shows one buyer another buyer’s returns', async () => {
    const mine = await paidOrder();
    const theirs = await paidOrder();
    await returns.request(mine.customerId, mine.order.id, { reason: 'Mine' });
    await returns.request(theirs.customerId, theirs.order.id, { reason: 'Theirs' });

    const rows = await buyer.list(mine.customerId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Mine');
  });

  it('counts the chips the way the list filters them', async () => {
    // The counts and the rows come from two separate queries, so the thing
    // worth pinning is that they agree — a chip reading "Refused 1" over an
    // empty list is the failure this catches.
    const customerId = await shopper();
    const made: string[] = [];
    for (const reason of ['One', 'Two', 'Three']) {
      const { merchantId, storeId } = await shop();
      const product = await products.create(
        {
          store_id: storeId,
          title: 'Ankara Wrap Dress',
          base_price_pesewas: 32_000,
          status: 'active',
          variants: [
            { sku: `SKU-${randomUUID().slice(0, 8)}`, price_pesewas: null, quantity_available: 10 },
          ],
        },
        ACTOR,
      );
      await cart.addItem(customerId, { variant_id: product.variants[0]!.id, quantity: 1 });
      const [raised] = await orders.checkout(customerId, { payment_type: 'full' }, ACTOR);
      const paid = await orders.confirmPayment(
        raised!.id,
        { provider_reference: `ps_${randomUUID().slice(0, 8)}` },
        ACTOR,
      );
      const asked = await returns.request(customerId, paid.id, { reason });
      made.push(asked.id);
      if (reason === 'Two') await returns.withdraw(customerId, asked.id);
      if (reason === 'Three') {
        await returns.reject(asked.id, { decision_note: 'No' }, ACTOR, { merchantId });
      }
    }
    expect(made).toHaveLength(3);

    const counts = await buyer.counts(customerId);

    expect(counts).toEqual({ requested: 1, approved: 0, rejected: 1, cancelled: 1, all: 3 });
    expect(await buyer.list(customerId, { status: 'cancelled' })).toHaveLength(counts.cancelled);
    expect(await buyer.list(customerId, { status: 'requested' })).toHaveLength(counts.requested);
    expect(await buyer.list(customerId)).toHaveLength(counts.all);
  });
});
