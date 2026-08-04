import { BadRequestException, Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ChargeAlreadyInFlightError,
  CustomerPlanNotFoundError,
  LedgerError,
  PermissionDeniedError,
} from '@installment/core';
import { DomainExceptionFilter } from './domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/**
 * S15 — the filter every error in the system passes through.
 *
 * `DomainExceptionFilter` is the single thing deciding what status code a
 * caller sees, and it had no test at all. `supertest` sat in
 * `apps/api/package.json` imported by nothing until S2, and the one spec that
 * used it exercised the idempotency interceptor.
 *
 * That matters because the mapping is a behavioural contract, not a formality.
 * A charge already in flight must be a 409 so the caller stops rather than
 * retrying into a double debit; a permission failure must be 403 and not leak a
 * reason; an unrecognised error must never spill an internal message to a
 * client. None of that was checked at the HTTP layer.
 */
@Controller('boom')
class BoomController {
  @Get('not-found')
  notFound(): never {
    throw new CustomerPlanNotFoundError('plan-1');
  }

  @Get('in-flight')
  inFlight(): never {
    throw new ChargeAlreadyInFlightError('sched-1', 'already processing');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new PermissionDeniedError('settlements:run');
  }

  @Get('unbalanced')
  unbalanced(): never {
    throw new LedgerError('debits 100 != credits 90');
  }

  @Get('zod')
  zod(): never {
    z.object({ amount: z.number().int().positive() }).parse({ amount: -5 });
    throw new Error('unreachable');
  }

  @Get('coded')
  coded(): never {
    throw new BadRequestException({ error: 'IdempotencyKeyRequired', message: 'header missing' });
  }

  @Get('unmapped')
  unmapped(): never {
    throw new Error('connection string is postgres://user:hunter2@db.internal');
  }
}

describe('DomainExceptionFilter (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [BoomController] }).compile();
    // `logger: false` only to keep the 5xx case from printing a stack trace
    // into the suite output — the filter is meant to log it.
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a missing plan to 404 with the error name', async () => {
    const res = await request(app.getHttpServer()).get('/boom/not-found').expect(404);
    expect(res.body).toMatchObject({ error: 'CustomerPlanNotFoundError' });
    expect(res.body.message).toContain('plan-1');
  });

  it('maps a charge already in flight to 409', async () => {
    // The status is the signal: a retry on 409 is a double debit, so a caller
    // that treats 5xx as retryable must never see this as a 500.
    const res = await request(app.getHttpServer()).get('/boom/in-flight').expect(409);
    expect(res.body.error).toBe('ChargeAlreadyInFlightError');
  });

  it('maps a permission denial to 403', async () => {
    const res = await request(app.getHttpServer()).get('/boom/forbidden').expect(403);
    expect(res.body.error).toBe('PermissionDeniedError');
  });

  it('maps an unbalanced ledger transaction to 422', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unbalanced').expect(422);
    expect(res.body.error).toBe('LedgerError');
  });

  it('turns a Zod failure into 400 with the issues attached', async () => {
    const res = await request(app.getHttpServer()).get('/boom/zod').expect(400);
    expect(res.body.error).toBe('ValidationError');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('honours an explicit error code on an HttpException', async () => {
    // Without this the filter overwrote the code with the exception's class
    // name, so every 400 looked alike and a client could not tell a missing
    // idempotency header from a malformed body.
    const res = await request(app.getHttpServer()).get('/boom/coded').expect(400);
    expect(res.body).toEqual({ error: 'IdempotencyKeyRequired', message: 'header missing' });
  });

  it('never leaks the message of an unrecognised error', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unmapped').expect(500);
    expect(res.body).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});
