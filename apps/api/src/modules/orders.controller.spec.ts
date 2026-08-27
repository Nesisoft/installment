import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrdersService } from '@installment/commerce';
import { OrdersController } from './orders.controller';
import { IDEMPOTENT_KEY } from '../common/idempotent.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/**
 * `OrdersService.confirmPayment` was written, tested and then never called.
 * Its instalment sibling `activateFinancing` was wired from PlansController;
 * this one was not, so every pay-in-full order stopped at `pending_payment`
 * forever — nobody was recorded as paid, no merchant was credited, and the
 * stock reserved at checkout was never released or sold.
 *
 * The unit tests could not catch that, because the service worked perfectly in
 * isolation. What was missing was the wiring. So this asserts the wiring:
 * that the route exists, reaches the service with the caller as actor, and
 * carries the two decorators that make it safe to expose.
 */
describe('OrdersController', () => {
  let app: INestApplication;
  const confirmPayment = vi.fn();
  const cancel = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: OrdersService, useValue: { confirmPayment, cancel } }],
    })
      // The real app applies these globally; here we only care that the
      // controller delegates, so the request runs unguarded.
      .compile();

    app = moduleRef.createNestApplication();
    // Stand in for the global JwtAuthGuard, which populates req.user in the real
    // app. Without it @CurrentUser() is undefined and actorOf() throws.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin-1', userType: 'admin', permissions: ['settlements:run'] };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('settles an order through the service, passing the order id and body', async () => {
    confirmPayment.mockResolvedValueOnce({ id: 'order-1', status: 'paid' });

    const res = await request(app.getHttpServer())
      .post('/admin/orders/order-1/confirm-payment')
      .send({ provider_reference: 'BANK-TRF-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'order-1', status: 'paid' });
    expect(confirmPayment).toHaveBeenCalledWith(
      'order-1',
      { provider_reference: 'BANK-TRF-1' },
      // the caller, so the ledger and audit rows record who settled it
      { actorId: 'admin-1', actorType: 'admin' },
    );
  });

  it('cancels an order through the service, passing the caller as actor', async () => {
    cancel.mockResolvedValueOnce({ id: 'order-2', status: 'cancelled' });

    const res = await request(app.getHttpServer())
      .post('/admin/orders/order-2/cancel')
      .send({ reason: 'Merchant cannot fulfil' });

    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(
      'order-2',
      { reason: 'Merchant cannot fulfil' },
      { actorId: 'admin-1', actorType: 'admin' },
    );
  });

  it('gates cancel on plans:write — it moves no money, so it does not need settlements:run', () => {
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, OrdersController.prototype.cancel as object);
    expect(perms).toContain('plans:write');
    expect(perms).not.toContain('settlements:run');
  });

  it('requires an Idempotency-Key — it books a ledger transaction', () => {
    // Read the metadata rather than the HTTP behaviour: the interceptor that
    // enforces it is applied globally by AppModule, not by this test module.
    const meta = Reflect.getMetadata(
      IDEMPOTENT_KEY,
      OrdersController.prototype.confirmPayment as object,
    );
    expect(meta, 'confirm-payment must be marked @Idempotent()').toBeDefined();
    expect(meta.required).toBe(true);
  });

  it('is gated on settlements:run, the money-movement permission', () => {
    const perms = Reflect.getMetadata(
      PERMISSIONS_KEY,
      OrdersController.prototype.confirmPayment as object,
    );
    expect(perms, 'confirm-payment must require a permission').toBeDefined();
    expect(perms).toContain('settlements:run');
  });
});
