import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CustomerEmploymentService,
  EmployersService,
  EmploymentNotAllowedError,
  PERMISSIONS,
} from '@installment/core';
import { EmployersController } from './employers.controller';
import { PERMISSIONS_KEY } from '../auth/decorators';
import { DomainExceptionFilter } from '../common/domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/**
 * The console's employer and employment routes. Verification raises what a
 * first-time customer may borrow, so the route has to carry how the job was
 * confirmed through to the service.
 */
describe('EmployersController', () => {
  let app: INestApplication;
  const employers = { listForConsole: vi.fn(), counts: vi.fn(), get: vi.fn() };
  const employment = { listForConsole: vi.fn(), markVerified: vi.fn(), unverify: vi.fn() };
  const ACTOR = { actorId: 'admin-1', actorType: 'admin' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmployersController],
      providers: [
        { provide: EmployersService, useValue: employers },
        { provide: CustomerEmploymentService, useValue: employment },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainExceptionFilter());
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin-1', userType: 'admin' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('routes /summary and /counts to themselves, not to an employer id', async () => {
    employers.listForConsole.mockResolvedValueOnce({ rows: [], total: 0 });
    employers.counts.mockResolvedValueOnce({ all: 2 });
    await request(app.getHttpServer()).get('/admin/employers/summary').query({ q: 'GES' });
    expect(employers.listForConsole).toHaveBeenCalledWith({ q: 'GES' });
    const res = await request(app.getHttpServer()).get('/admin/employers/counts');
    expect(res.body).toEqual({ all: 2 });
    expect(employers.get).not.toHaveBeenCalled();
  });

  it('lists the verification queue with the query as given', async () => {
    employment.listForConsole.mockResolvedValueOnce({ rows: [], total: 0 });
    const res = await request(app.getHttpServer())
      .get('/admin/employers/employment')
      .query({ verified: 'false', status: 'active' });
    expect(res.status).toBe(200);
    expect(employment.listForConsole).toHaveBeenCalledWith({ verified: 'false', status: 'active' });
  });

  it('verifies with how the job was confirmed, recording who did it', async () => {
    employment.markVerified.mockResolvedValueOnce({ id: 'l-1' });
    const body = { method: 'employer_confirmed', note: 'HR by phone' };
    const res = await request(app.getHttpServer())
      .post('/admin/employers/employment/l-1/verify')
      .send(body);
    expect(res.status).toBe(200);
    expect(employment.markVerified).toHaveBeenCalledWith('l-1', body, ACTOR);
  });

  it('answers 409 when the job cannot be verified', async () => {
    employment.markVerified.mockRejectedValueOnce(
      new EmploymentNotAllowedError('this link is left_employer'),
    );
    const res = await request(app.getHttpServer())
      .post('/admin/employers/employment/l-2/verify')
      .send({ method: 'payslip', note: 'old' });
    expect(res.status).toBe(409);
  });

  it('withdraws a verification with the reason', async () => {
    employment.unverify.mockResolvedValueOnce({ id: 'l-3' });
    await request(app.getHttpServer())
      .post('/admin/employers/employment/l-3/unverify')
      .send({ reason: 'Wrong person' });
    expect(employment.unverify).toHaveBeenCalledWith('l-3', { reason: 'Wrong person' }, ACTOR);
  });

  it('gates reads on employers:read and changes on employers:write', () => {
    const perms = (m: keyof EmployersController) =>
      Reflect.getMetadata(PERMISSIONS_KEY, EmployersController.prototype[m] as object);
    for (const m of ['summary', 'counts', 'listEmploymentForConsole'] as const) {
      expect(perms(m), m).toContain(PERMISSIONS.EMPLOYERS_READ);
    }
    for (const m of ['verifyEmployment', 'unverifyEmployment'] as const) {
      expect(perms(m), m).toContain(PERMISSIONS.EMPLOYERS_WRITE);
    }
  });
});
