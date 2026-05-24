import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.validation';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
          lazyConnect: false,
        }),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
