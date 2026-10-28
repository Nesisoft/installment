import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AdminCatalogService,
  CATALOG_PERMISSIONS,
  InventoryService,
  ProductTakenDownError,
  ProductsService,
} from '@installment/commerce';
import { CatalogueController } from './catalogue.controller';
import { ProductsController } from './products.controller';
import { PERMISSIONS_KEY } from '../auth/decorators';
import { DomainExceptionFilter } from '../common/domain-exception.filter';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

/**
 * The console's catalogue routes: the reads staff moderate by, and taking a
 * listing down. Asserts the wiring — each route reaches its service with the
 * caller as actor and carries the permission that gates it.
 */
describe('Catalogue moderation routes', () => {
  let app: INestApplication;
  const catalog = {
    listProducts: vi.fn(),
    productCounts: vi.fn(),
    productDetail: vi.fn(),
    listStores: vi.fn(),
    storeCounts: vi.fn(),
  };
  const takeDown = vi.fn();
  const liftTakedown = vi.fn();
  const update = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogueController, ProductsController],
      providers: [
        { provide: AdminCatalogService, useValue: catalog },
        { provide: ProductsService, useValue: { takeDown, liftTakedown, update } },
        { provide: InventoryService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new DomainExceptionFilter());
    // Stand in for the global JwtAuthGuard, which sets req.user in the real app.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'admin-1', userType: 'admin', permissions: ['catalog:write'] };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists listings with the query as given; the service parses it', async () => {
    catalog.listProducts.mockResolvedValueOnce({ rows: [], total: 0 });
    const res = await request(app.getHttpServer())
      .get('/admin/catalogue/products')
      .query({ taken_down: 'true', q: 'kente', limit: '20' });
    expect(res.status).toBe(200);
    expect(catalog.listProducts).toHaveBeenCalledWith({
      taken_down: 'true',
      q: 'kente',
      limit: '20',
    });
  });

  it('routes /products/counts to the counts, not to a listing called "counts"', async () => {
    catalog.productCounts.mockResolvedValueOnce({ all: 4, taken_down: 1 });
    const res = await request(app.getHttpServer()).get('/admin/catalogue/products/counts');
    expect(res.body).toEqual({ all: 4, taken_down: 1 });
    expect(catalog.productDetail).not.toHaveBeenCalled();
  });

  it('opens one listing', async () => {
    catalog.productDetail.mockResolvedValueOnce({ id: 'p-1' });
    const res = await request(app.getHttpServer()).get('/admin/catalogue/products/p-1');
    expect(res.status).toBe(200);
    expect(catalog.productDetail).toHaveBeenCalledWith('p-1');
  });

  it('lists shops and counts them', async () => {
    catalog.listStores.mockResolvedValueOnce({ rows: [], total: 0 });
    catalog.storeCounts.mockResolvedValueOnce({ all: 2 });
    await request(app.getHttpServer()).get('/admin/catalogue/stores').query({ status: 'draft' });
    expect(catalog.listStores).toHaveBeenCalledWith({ status: 'draft' });
    const res = await request(app.getHttpServer()).get('/admin/catalogue/stores/counts');
    expect(res.body).toEqual({ all: 2 });
  });

  it('gates every read on catalog:read', () => {
    for (const route of [
      'products',
      'productCounts',
      'product',
      'stores',
      'storeCounts',
    ] as const) {
      const perms = Reflect.getMetadata(
        PERMISSIONS_KEY,
        CatalogueController.prototype[route] as object,
      );
      expect(perms, route).toContain(CATALOG_PERMISSIONS.CATALOG_READ);
    }
  });

  it('takes a listing down with the reason, recording who did it', async () => {
    takeDown.mockResolvedValueOnce({ id: 'p-2', status: 'archived' });
    const res = await request(app.getHttpServer())
      .post('/admin/products/p-2/take-down')
      .send({ reason: 'Counterfeit brand' });
    expect(res.status).toBe(200);
    expect(takeDown).toHaveBeenCalledWith(
      'p-2',
      { reason: 'Counterfeit brand' },
      { actorId: 'admin-1', actorType: 'admin' },
    );
  });

  it('lifts a takedown, recording who did it', async () => {
    liftTakedown.mockResolvedValueOnce({ id: 'p-2', status: 'active' });
    const res = await request(app.getHttpServer()).post('/admin/products/p-2/lift-takedown');
    expect(res.status).toBe(200);
    expect(liftTakedown).toHaveBeenCalledWith('p-2', { actorId: 'admin-1', actorType: 'admin' });
  });

  it('gates both on catalog:write', () => {
    for (const route of ['takeDown', 'liftTakedown'] as const) {
      const perms = Reflect.getMetadata(
        PERMISSIONS_KEY,
        ProductsController.prototype[route] as object,
      );
      expect(perms, route).toContain(CATALOG_PERMISSIONS.CATALOG_WRITE);
    }
  });

  it('answers 409 when someone tries to put a taken-down listing back on sale', async () => {
    update.mockRejectedValueOnce(new ProductTakenDownError('p-2', 'Counterfeit brand'));
    const res = await request(app.getHttpServer())
      .patch('/admin/products/p-2')
      .send({ status: 'active' });
    expect(res.status).toBe(409);
  });
});
