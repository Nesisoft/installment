import { Body, Controller, HttpCode, INestApplication, Post } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IdempotencyService, type IdempotencyStore } from '@installment/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { Idempotent } from './idempotent.decorator';
import { DomainExceptionFilter } from './domain-exception.filter';

/** In-memory store with the same semantics as the Drizzle one. */
function memoryStore(): IdempotencyStore {
  const rows = new Map<
    string,
    { request_hash: string; response_body: unknown; response_status: number | null }
  >();
  return {
    async reserve(key, requestHash) {
      if (rows.has(key)) return false;
      rows.set(key, { request_hash: requestHash, response_body: null, response_status: null });
      return true;
    },
    async find(key) {
      const row = rows.get(key);
      return row ? { key, ...row } : undefined;
    },
    async storeResult(key, body, status) {
      const row = rows.get(key);
      if (row) {
        row.response_body = body;
        row.response_status = status;
      }
    },
    async releaseReservation(key) {
      rows.delete(key);
    },
  };
}

const charge = vi.fn();

@Controller('test')
class TestController {
  @Post('pay')
  @Idempotent()
  @HttpCode(201)
  pay(@Body() body: { amount: number }) {
    charge(body);
    return { charged: body.amount, id: charge.mock.calls.length };
  }

  @Post('free')
  free() {
    charge({ free: true });
    return { ok: true };
  }
}

describe('IdempotencyInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        Reflector,
        { provide: IdempotencyService, useFactory: () => new IdempotencyService(memoryStore()) },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a marked route with no Idempotency-Key', async () => {
    const res = await request(app.getHttpServer()).post('/test/pay').send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IdempotencyKeyRequired');
  });

  it('runs the handler once and replays the cached response on retry', async () => {
    charge.mockClear();
    const key = 'key-replay';
    const body = { amount: 500 };

    const first = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send(body);
    const second = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send(body);

    // The whole point: a retried request must not charge the customer twice.
    expect(charge).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual(first.body);
  });

  it('replays the original status code, not the default for the verb', async () => {
    charge.mockClear();
    const key = 'key-status';
    const first = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send({ amount: 1 });
    const second = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send({ amount: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('409s when the same key is reused with a different body', async () => {
    charge.mockClear();
    const key = 'key-conflict';
    await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send({ amount: 10 });

    const res = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', key)
      .send({ amount: 999 }); // different amount, same key

    expect(res.status).toBe(409);
    expect(charge).toHaveBeenCalledTimes(1); // the second amount was never charged
  });

  it('leaves unmarked routes alone', async () => {
    charge.mockClear();
    const a = await request(app.getHttpServer()).post('/test/free').send({});
    const b = await request(app.getHttpServer()).post('/test/free').send({});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(charge).toHaveBeenCalledTimes(2);
  });

  it('rejects an over-long key', async () => {
    const res = await request(app.getHttpServer())
      .post('/test/pay')
      .set('Idempotency-Key', 'x'.repeat(300))
      .send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IdempotencyKeyInvalid');
  });
});
