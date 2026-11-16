import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentPasswordIncorrectError } from '@installment/core';
import { AuthController } from './auth.controller';
import { PUBLIC_KEY } from './decorators';
import { DomainExceptionFilter } from '../common/domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/** Changing your own password: the one route a temporary-password login can use. */
describe('AuthController — POST /auth/password', () => {
  let app: INestApplication;
  const auth = { changePassword: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainExceptionFilter());
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'staff-1', userType: 'agent' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("changes the signed-in user's password and answers with the new session", async () => {
    const result = {
      userId: 'staff-1',
      userType: 'agent',
      tokens: { accessToken: 'a', refreshToken: 'r' },
      permissions: ['collections:act'],
      mustChangePassword: false,
    };
    auth.changePassword.mockResolvedValueOnce(result);
    const body = { current_password: 'old-one', new_password: 'new-one-1' };

    const res = await request(app.getHttpServer()).post('/auth/password').send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(auth.changePassword).toHaveBeenCalledWith('staff-1', body, {
      actorId: 'staff-1',
      actorType: 'admin',
    });
  });

  it('answers 400, not 401, for a wrong current password, so the client stays signed in', async () => {
    auth.changePassword.mockRejectedValueOnce(new CurrentPasswordIncorrectError());
    const res = await request(app.getHttpServer())
      .post('/auth/password')
      .send({ current_password: 'nope', new_password: 'new-one-1' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/current password is not right/);
  });

  it('needs a session: it is not a public route', () => {
    const isPublic = Reflect.getMetadata(
      PUBLIC_KEY,
      AuthController.prototype.changePassword as object,
    );
    expect(isPublic).toBeFalsy();
  });
});
