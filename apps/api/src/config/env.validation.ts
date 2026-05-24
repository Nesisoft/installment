import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Auth — dev defaults keep `pnpm dev` friction-free; production MUST override
  // these with secrets from a real secret store (see DEVELOPMENT-PLAN.md §5).
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me!!'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me!!'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  SMS_SENDER_ID: z.string().default('Installmt'),
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return parsed.data;
}
