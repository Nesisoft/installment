import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // CORS allowlist for the Phase 10 browser apps. Comma-separated origins, or
  // "*" to reflect any origin (dev only). Empty = no cross-origin browser access.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5175'),
  // Auth — dev defaults keep `pnpm dev` friction-free; production MUST override
  // these with secrets from a real secret store (see DEVELOPMENT-PLAN.md §5).
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me!!'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me!!'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  SMS_SENDER_ID: z.string().default('Installmt'),
  // Which SMS provider actually dispatches. `console` logs and delivers
  // nothing — fine locally, catastrophic in production, where customer auth is
  // phone+OTP only and no customer could log in. See the refinement below.
  SMS_PROVIDER: z.enum(['console', 'hubtel', 'arkesel']).default('console'),
  HUBTEL_CLIENT_ID: z.string().default(''),
  HUBTEL_CLIENT_SECRET: z.string().default(''),
  HUBTEL_BASE_URL: z.string().default('https://smsc.hubtel.com'),
  ARKESEL_API_KEY: z.string().default(''),
  ARKESEL_BASE_URL: z.string().default('https://sms.arkesel.com'),
  /**
   * Print the full SMS body to the log. Off by default: the body carries login
   * OTPs, so a log with it in is a credential store. Local development only.
   */
  SMS_LOG_BODY: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  // Paystack — empty in dev keeps boot friction-free; charging/webhooks need a real key.
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.string().default('https://api.paystack.co'),
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Scheduled workers (settlement / reserve-release / reconciliation crons).
  // Keep OFF in tests and local single-instance dev; turn ON exactly once per
  // production deployment (a future leader-election step picks the runner).
  ENABLE_SCHEDULED_WORKERS: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
});

/**
 * Refusals that only make sense once the whole environment is known.
 *
 * Boot is the right place for these. A production deployment on the console
 * sender does not fail visibly — it fails silently, one customer at a time, at
 * the OTP screen, and the notifications table records every one of those
 * messages as `sent`.
 */
export const envSchemaChecked = envSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (env.SMS_PROVIDER === 'console') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_PROVIDER'],
        message:
          'refusing to start: SMS_PROVIDER=console delivers nothing, and customer login is phone+OTP only. Set hubtel or arkesel.',
      });
    }
    if (env.SMS_LOG_BODY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_LOG_BODY'],
        message: 'refusing to start: SMS_LOG_BODY writes login OTPs to the log.',
      });
    }
  }

  // Credentials are checked whatever the environment: a provider selected
  // without them fails on the first send, which is the worst time to find out.
  if (env.SMS_PROVIDER === 'hubtel' && !(env.HUBTEL_CLIENT_ID && env.HUBTEL_CLIENT_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HUBTEL_CLIENT_ID'],
      message: 'SMS_PROVIDER=hubtel requires HUBTEL_CLIENT_ID and HUBTEL_CLIENT_SECRET',
    });
  }
  if (env.SMS_PROVIDER === 'arkesel' && !env.ARKESEL_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ARKESEL_API_KEY'],
      message: 'SMS_PROVIDER=arkesel requires ARKESEL_API_KEY',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchemaChecked.safeParse(config);
  if (!parsed.success) {
    const details = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return parsed.data;
}
