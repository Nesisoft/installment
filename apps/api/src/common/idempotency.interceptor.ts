import { createHash } from 'node:crypto';
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, Observable } from 'rxjs';
import { IdempotencyService } from '@installment/core';
import type { Request, Response } from 'express';
import { IDEMPOTENT_KEY, type IdempotentOptions } from './idempotent.decorator';

/** Max accepted key length — long enough for a UUID or ULID, bounded to stop abuse. */
const MAX_KEY_LENGTH = 255;

/**
 * Enforces `Idempotency-Key` on routes marked with `@Idempotent()`.
 *
 * The header was advertised in the CORS allowlist and implemented nowhere, so
 * every money-mutating POST was replay-unsafe: a retried request on a flaky
 * connection, or a double-tapped "Pay", produced a second real debit.
 *
 * The cached response is keyed on the key AND a hash of (method, path, user,
 * body). Reusing one key for a different request is a client bug and returns
 * 409 rather than silently replaying an unrelated response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  /**
   * Tokens are injected explicitly rather than by reflected parameter types.
   * The production build (tsc) emits `design:paramtypes`, but the test build
   * (esbuild) silently ignores `emitDecoratorMetadata`, so type-based DI
   * resolves to undefined under vitest. Being explicit makes this class
   * constructible in both, which is what allows it to be tested at all.
   */
  constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    const raw = req.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;

    if (!key) {
      if (!options.required) return next.handle();
      throw new BadRequestException({
        error: 'IdempotencyKeyRequired',
        message:
          'This endpoint moves money and requires an Idempotency-Key header. ' +
          'Send a unique value per logical request and reuse it when retrying.',
      });
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new BadRequestException({
        error: 'IdempotencyKeyInvalid',
        message: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
      });
    }

    const requestHash = this.hashRequest(req);
    const res = context.switchToHttp().getResponse<Response>();

    return from(
      this.idempotency
        .wrap(key, requestHash, async () => {
          const body = await lastValueFromHandler(next);
          // statusCode is only final once the handler has run (@HttpCode etc).
          return { body, status: res.statusCode };
        })
        .then((cached) => {
          // A replay must reproduce the original status, not the default for
          // the verb — a cached 201 replayed as 200 would mislead the client.
          res.status(cached.status);
          return cached.body;
        }),
    );
  }

  /**
   * Binds the key to the exact request it was used for. The user id is
   * included so one client's key can never collide with another's.
   */
  private hashRequest(req: Request & { user?: { id?: string } }): string {
    const payload = JSON.stringify({
      method: req.method,
      path: req.route?.path ?? req.path,
      params: req.params ?? {},
      user: req.user?.id ?? null,
      body: req.body ?? null,
    });
    return createHash('sha256').update(payload).digest('hex');
  }
}

/** Runs the Nest handler chain and resolves with its emitted value. */
function lastValueFromHandler(next: CallHandler): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let value: unknown;
    next.handle().subscribe({
      next: (v) => {
        value = v;
      },
      error: reject,
      complete: () => resolve(value),
    });
  });
}
