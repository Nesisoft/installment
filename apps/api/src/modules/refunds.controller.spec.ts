import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefundService } from '@installment/core';
import { RefundsController } from './refunds.controller';
import { IDEMPOTENT_KEY } from '../common/idempotent.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators';
import { DomainExceptionFilter } from '../common/domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/**
 * The console's refunds page: the list, the queue totals, and paying a refund
 * back by hand with a note of how. The routes are thin; what is asserted is
 * that they parse what they are given and that "summary" is not taken for a
 * refund reference.
 */
describe('RefundsController', () => {
  let app: INestApplication;
  const svc = {
    list: vi.fn(),
    summary: vi.fn(),
    listForPlan: vi.fn(),
    findByReference: vi.fn(),
    disburse: vi.fn(),
    settleManual: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RefundsController],
      providers: [{ provide: RefundService, useValue: svc }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainExceptionFilter());
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin-1', userType: 'admin', permissions: ['refunds:act'] };
      next();
    });
    await app.init();
  });

  beforeEach(() => vi.clearAllMocks());

  afterAll(async () => {
    await app?.close();
  });

  it('lists one queue, with the paging numbers off the URL', async () => {
    svc.list.mockResolvedValueOnce({ rows: [], total: 0 });
    const res = await request(app.getHttpServer())
      .get('/admin/refunds')
      .query({ queue: 'failed', limit: '25', offset: '50' });
    expect(res.status).toBe(200);
    expect(svc.list).toHaveBeenCalledWith({ queue: 'failed', limit: 25, offset: 50 });
  });

  it('refuses a queue that does not exist', async () => {
    const res = await request(app.getHttpServer()).get('/admin/refunds').query({ queue: 'lost' });
    expect(res.status).toBe(400);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('answers /summary with the queue totals, not as a refund called "summary"', async () => {
    svc.summary.mockResolvedValueOnce([{ queue: 'failed', count: 1 }]);
    const res = await request(app.getHttpServer()).get('/admin/refunds/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ queue: 'failed', count: 1 }]);
    expect(svc.findByReference).not.toHaveBeenCalled();
  });

  it('marks a refund paid by hand with the note of how, as the caller', async () => {
    svc.settleManual.mockResolvedValueOnce({ reference: 'RFND-1', status: 'succeeded' });
    const res = await request(app.getHttpServer())
      .post('/admin/refunds/RFND-1/settle-manual')
      .send({ note: 'MoMo transfer 0244… ref 7781' });
    expect(res.status).toBe(200);
    expect(svc.settleManual).toHaveBeenCalledWith(
      'RFND-1',
      { actorId: 'admin-1', actorType: 'admin' },
      { note: 'MoMo transfer 0244… ref 7781', checkedPaystack: undefined },
    );
  });

  it('passes on that the caller checked Paystack, for an unresolved refund', async () => {
    svc.settleManual.mockResolvedValueOnce({ reference: 'RFND-3', status: 'succeeded' });
    await request(app.getHttpServer())
      .post('/admin/refunds/RFND-3/settle-manual')
      .send({ note: 'Bank transfer 5521', checked_paystack: true });
    expect(svc.settleManual).toHaveBeenCalledWith(
      'RFND-3',
      { actorId: 'admin-1', actorType: 'admin' },
      { note: 'Bank transfer 5521', checkedPaystack: true },
    );
  });

  it('still takes a settle with no body, as the console used to send', async () => {
    svc.settleManual.mockResolvedValueOnce({ reference: 'RFND-2', status: 'succeeded' });
    const res = await request(app.getHttpServer()).post('/admin/refunds/RFND-2/settle-manual');
    expect(res.status).toBe(200);
    expect(svc.settleManual).toHaveBeenCalledWith(
      'RFND-2',
      { actorId: 'admin-1', actorType: 'admin' },
      { note: undefined, checkedPaystack: undefined },
    );
  });

  it('moves money only behind refunds:act and an Idempotency-Key', () => {
    for (const handler of ['send', 'settleManual'] as const) {
      const fn = RefundsController.prototype[handler] as object;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, fn)).toContain('refunds:act');
      expect(Reflect.getMetadata(IDEMPOTENT_KEY, fn)?.required).toBe(true);
    }
  });
});
