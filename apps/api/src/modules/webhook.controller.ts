import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookService } from '@installment/core';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';

/**
 * Paystack webhook sink. Public (no JWT) — authenticity comes from the
 * HMAC signature over the raw body, verified inside WebhookService. Always
 * answers 200 once accepted; a bad signature is a 403 (via the global filter).
 */
@ApiTags('webhooks')
@Controller('webhooks/paystack')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post()
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ): Promise<{ ok: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.webhooks.ingest(raw, signature ?? '');
    return { ok: true };
  }
}
