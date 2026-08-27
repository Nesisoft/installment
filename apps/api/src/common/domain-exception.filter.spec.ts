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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DomainExceptionFilter,
  INTENTIONALLY_UNMAPPED,
  NAME_STATUS,
} from './domain-exception.filter';

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

/**
 * The bug this guards against: every one of the 33 error classes in
 * @installment/commerce, @installment/core and @installment/paystack-client was
 * absent from NAME_STATUS, so all of them answered 500 "Internal server error"
 * and were reported to Sentry as server faults. A shopper opening a stale
 * product link got an outage page, and the alerting drowned in it.
 *
 * Nothing failed, which is why it survived: the filter has a default branch and
 * a forgotten error looks exactly like a handled one. So rather than testing the
 * mappings one at a time, this reads the source tree and insists every declared
 * domain error is CLASSIFIED — mapped to a status, or named in
 * INTENTIONALLY_UNMAPPED with the reasoning that keeps it a 500.
 */
describe('domain error coverage', () => {
  // Walk up to the workspace root rather than counting '..' from __dirname,
  // which vitest's transform does not reliably provide.
  function workspaceRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      try {
        if (statSync(join(dir, 'pnpm-workspace.yaml')).isFile()) return dir;
      } catch {
        /* keep walking */
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`could not locate the workspace root from ${process.cwd()}`);
  }

  const ROOT = workspaceRoot();
  const PACKAGES = ['core', 'commerce', 'paystack-client', 'sms-client', 'db'];

  function tsFiles(dir: string): string[] {
    let out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out = out.concat(tsFiles(full));
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
    }
    return out;
  }

  const declared = new Set<string>();
  for (const pkg of PACKAGES) {
    for (const file of tsFiles(join(ROOT, 'packages', pkg, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/export class ([A-Za-z0-9_]*Error)/g)) declared.add(m[1]!);
    }
  }

  it('found the domain error classes (guards against a bad path resolving to nothing)', () => {
    expect(declared.size).toBeGreaterThan(40);
    expect(declared.has('CustomerPlanNotFoundError')).toBe(true);
    expect(declared.has('ProductNotFoundError')).toBe(true);
  });

  it('classifies every declared domain error — mapped, or deliberately left at 500', () => {
    const unclassified = [...declared]
      .filter((name) => !(name in NAME_STATUS))
      .filter((name) => !INTENTIONALLY_UNMAPPED.includes(name))
      .sort();

    expect(
      unclassified,
      'These error classes fall through to 500 and will alarm Sentry. Add each to ' +
        'NAME_STATUS, or to INTENTIONALLY_UNMAPPED if a 5xx is genuinely right: ' +
        unclassified.join(', '),
    ).toEqual([]);
  });

  it('keeps the anonymous-reachable storefront errors off 5xx', () => {
    // A stale link is not an outage.
    for (const name of ['ProductNotFoundError', 'StoreNotFoundError', 'CategoryNotFoundError']) {
      expect(NAME_STATUS[name], name).toBeLessThan(500);
    }
  });

  it('leaves internal invariant failures alarming', () => {
    for (const name of INTENTIONALLY_UNMAPPED) {
      expect(name in NAME_STATUS, `${name} should stay unmapped`).toBe(false);
    }
  });
});

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
