import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../common/rate-limit.decorator';
import type { Env } from '../config/env.validation';
import { metricsRegistry } from './metrics';

/**
 * Prometheus scrape endpoint.
 *
 * Bearer-token protected rather than staff-authenticated: Prometheus cannot
 * log in, and a staff token expires in fifteen minutes. With no
 * `METRICS_TOKEN` configured it answers 404, so a deployment that has not set
 * up scraping does not publish its payout and refund backlog to anyone who
 * asks. Kept out of the OpenAPI contract: it is for operators, not partners.
 */
@ApiExcludeController()
@Controller('metrics')
@SkipRateLimit()
export class MetricsController {
  private readonly token: Buffer | null;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    const token = config.get('METRICS_TOKEN', { infer: true });
    this.token = token ? Buffer.from(token) : null;
  }

  @Public()
  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (!this.token) throw new NotFoundException();
    const presented = Buffer.from(
      authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '',
    );
    if (presented.length !== this.token.length || !timingSafeEqual(presented, this.token)) {
      throw new UnauthorizedException();
    }
    res.setHeader('Content-Type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  }
}
