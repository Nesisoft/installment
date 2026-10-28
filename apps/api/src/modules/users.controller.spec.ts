import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, UserAccessChangeError, UsersService } from '@installment/core';
import { UsersController } from './users.controller';
import { PERMISSIONS_KEY } from '../auth/decorators';
import { DomainExceptionFilter } from '../common/domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/** Staff and their roles, as the console manages them. */
describe('UsersController', () => {
  let app: INestApplication;
  const users = {
    listStaff: vi.fn(),
    listStaffRoles: vi.fn(),
    assignRole: vi.fn(),
    revokeRole: vi.fn(),
    setActive: vi.fn(),
  };
  const ACTOR = { actorId: 'admin-1', actorType: 'admin' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: users }],
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

  it('lists staff and the roles they can hold', async () => {
    users.listStaff.mockResolvedValueOnce([{ id: 's-1' }]);
    users.listStaffRoles.mockResolvedValueOnce([{ name: 'ops' }]);
    expect((await request(app.getHttpServer()).get('/admin/users/staff')).body).toEqual([
      { id: 's-1' },
    ]);
    expect((await request(app.getHttpServer()).get('/admin/users/roles')).body).toEqual([
      { name: 'ops' },
    ]);
  });

  it('takes a role away, recording who did it', async () => {
    const res = await request(app.getHttpServer()).delete('/admin/users/s-2/roles/admin');
    expect(res.status).toBe(204);
    expect(users.revokeRole).toHaveBeenCalledWith('s-2', 'admin', ACTOR);
  });

  it('switches an account off and on with the reason', async () => {
    users.setActive.mockResolvedValue({ id: 's-3' });
    await request(app.getHttpServer())
      .post('/admin/users/s-3/deactivate')
      .send({ reason: 'Left the company' });
    expect(users.setActive).toHaveBeenCalledWith(
      's-3',
      false,
      { reason: 'Left the company' },
      ACTOR,
    );
    await request(app.getHttpServer()).post('/admin/users/s-3/reactivate').send({ reason: 'Back' });
    expect(users.setActive).toHaveBeenCalledWith('s-3', true, { reason: 'Back' }, ACTOR);
  });

  it('answers 409 for a change the rules refuse', async () => {
    users.revokeRole.mockRejectedValueOnce(
      new UserAccessChangeError('This is the last active administrator'),
    );
    const res = await request(app.getHttpServer()).delete('/admin/users/s-4/roles/admin');
    expect(res.status).toBe(409);
    expect(res.body.message ?? JSON.stringify(res.body)).toMatch(/last active administrator/);
  });

  it('gates every route on users:write', () => {
    for (const m of [
      'listStaff',
      'listRoles',
      'assignRole',
      'revokeRole',
      'deactivate',
      'reactivate',
    ] as const) {
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, UsersController.prototype[m] as object);
      expect(perms, m).toContain(PERMISSIONS.USERS_WRITE);
    }
  });
});
