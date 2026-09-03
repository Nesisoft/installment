import { z } from 'zod';

/**
 * Only the `local` driver signs with this, and `local` is refused in production
 * below — so the published default is confined to development by construction,
 * and there is no separate refusal for it. Adding one would fail a production
 * boot over a variable that deployment never reads.
 */
const STORAGE_UPLOAD_SECRET_DEV_DEFAULT = 'dev-upload-secret-change-me!!';

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
  // Rate limiting (Phase 10). Defaults are generous enough that normal use never
  // notices; per-route overrides tighten the endpoints worth abusing.
  RATE_LIMIT_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v !== false && v !== 'false' && v !== '0')
    .default(true),
  RATE_LIMIT_LIMIT: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Behind a proxy/load balancer the client IP arrives in X-Forwarded-For. Set
  // this to the hop count (or 'true') so the limiter buckets real clients rather
  // than lumping the whole estate into the proxy's single address.
  TRUST_PROXY: z.string().default(''),
  // Auth — dev defaults keep `pnpm dev` friction-free; production MUST override
  // these with secrets from a real secret store (see DEVELOPMENT-PLAN.md §5).
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me!!'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me!!'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  /**
   * Public prefix product images, store logos and category art are served from,
   * e.g. `https://cdn.ejua.gh/media`. Object-storage keys are resolved against
   * it server-side so no client has to know the bucket layout, and swapping in
   * signed URLs later changes one function rather than every app.
   *
   * Empty (the default) means every image URL comes back null, which the apps
   * render as a placeholder tile — a deployment without storage configured
   * degrades quietly instead of showing broken images.
   */
  MEDIA_BASE_URL: z.string().default(''),
  /**
   * Which backend accepts new uploads.
   *
   * `none` (the default) keeps boot friction-free and existing images resolving
   * — MEDIA_BASE_URL is read directly and does not go through a driver — but
   * every upload request answers 503. `local` writes to disk through the API,
   * which is development only. `s3` covers every provider that verifies a SigV4
   * signature: S3, Cloudflare R2, DigitalOcean Spaces, MinIO.
   */
  STORAGE_DRIVER: z.enum(['none', 'local', 's3']).default('none'),
  STORAGE_BUCKET: z.string().default(''),
  STORAGE_REGION: z.string().default('eu-west-1'),
  /**
   * Provider endpoint for anything that is not AWS — `https://<account>.r2.cloudflarestorage.com`,
   * `https://fra1.digitaloceanspaces.com`, `http://localhost:9000`. Empty means AWS.
   */
  STORAGE_ENDPOINT: z.string().default(''),
  /** R2 and MinIO address the bucket in the path; Spaces and AWS do not. */
  STORAGE_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  STORAGE_ACCESS_KEY_ID: z.string().default(''),
  STORAGE_SECRET_ACCESS_KEY: z.string().default(''),
  /**
   * Public prefix `public/` objects are served from, e.g. a CDN hostname. When
   * MEDIA_BASE_URL is unset this becomes it, so configuring storage is one
   * variable rather than two that must agree.
   */
  STORAGE_PUBLIC_URL: z.string().default(''),
  /** Where the `local` driver writes. Relative paths resolve from the API's cwd. */
  STORAGE_LOCAL_DIR: z.string().default('.media'),
  /**
   * Origin the API is reachable at, which the `local` driver puts in the URLs it
   * hands out. A phone on the LAN cannot reach `localhost`, so an emulator or
   * device needs this set to the host machine's address.
   */
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  /**
   * Signs the `local` driver's upload tokens. Only that driver uses it — S3
   * signs with the provider credentials — but it is the entire protection on a
   * write endpoint, so it must not be guessable if the API is reachable.
   */
  STORAGE_UPLOAD_SECRET: z.string().default(STORAGE_UPLOAD_SECRET_DEV_DEFAULT),
  /** Largest single upload the API will issue a URL for. 10 MB covers a phone photo. */
  STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10_485_760),
  /** How long an upload URL stays valid. Short: it is a bearer token for a write. */
  STORAGE_UPLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * The credit line offered to a customer with no borrowing history, in cedis,
   * measured on what the plan FINANCES rather than what the order costs.
   *
   * It exists because without it nobody new can be approved at all: every rule
   * worth points needs a history to have points about, so a verified, blameless
   * first-time shopper scores 275 against a 350 floor. This is the deliberate
   * appetite for being wrong about someone we know nothing about, and it is an
   * environment variable rather than a constant so it can be tightened the
   * afternoon losses say so, without a deploy. `0` switches the policy off.
   */
  CREDIT_STARTER_MAX_FINANCED_GHS: z.coerce.number().int().min(0).default(250),
  /**
   * The same ceiling when a **verified** link to an **active** employer exists.
   *
   * The one thing about a first-time customer that somebody outside this
   * company has confirmed. Not the bare link — an operator types those and they
   * land active immediately — but a link that was checked, against an employer
   * whose partnership is still live.
   */
  CREDIT_STARTER_MAX_FINANCED_EMPLOYER_GHS: z.coerce.number().int().min(0).default(750),
  /**
   * And when that link also carries payroll-deduction consent.
   *
   * The largest step, because it is the only tier where repayment does not
   * depend on the customer choosing to pay: the employer remits from salary
   * before it reaches them.
   */
  CREDIT_STARTER_MAX_FINANCED_PAYROLL_GHS: z.coerce.number().int().min(0).default(2_000),
  SMS_SENDER_ID: z.string().default('Installmt'),
  // Which SMS provider actually dispatches. `console` logs and delivers
  // nothing — fine locally, catastrophic in production, where customer auth is
  // phone+OTP only and no customer could log in. See the refinement below.
  SMS_PROVIDER: z.enum(['console', 'hubtel', 'arkesel']).default('console'),
  HUBTEL_CLIENT_ID: z.string().default(''),
  HUBTEL_CLIENT_SECRET: z.string().default(''),
  HUBTEL_BASE_URL: z.string().default('https://sms.hubtel.com'),
  /**
   * Full send endpoint. Preferred over HUBTEL_BASE_URL: Hubtel documents one
   * absolute URL per operation, so carrying the whole thing avoids a service
   * that moves host or path silently falling back to a stale default.
   */
  HUBTEL_SMS_URL: z.string().default(''),
  /**
   * Sender ID registered with THIS Hubtel account. Sender IDs are approved per
   * provider account, so the account's own value has to win over the generic
   * SMS_SENDER_ID — sending an unregistered one gets the message rejected.
   */
  HUBTEL_SENDER_ID: z.string().default(''),
  ARKESEL_API_KEY: z.string().default(''),
  /** Sender ID registered with this Arkesel account; falls back to SMS_SENDER_ID. */
  ARKESEL_SENDER_ID: z.string().default(''),
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
  /**
   * How long an unpaid order may hold its stock reservation before the hourly
   * sweep cancels it and returns the units to sale. Matches the 24h an engine
   * application gets by default.
   */
  ORDER_PAYMENT_TTL_HOURS: z.coerce.number().int().positive().default(24),
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

  // Storage, same rule as the SMS credentials: a driver selected without what
  // it needs fails on the first upload, and the first upload is a merchant
  // listing a product, not a developer at a terminal.
  if (env.STORAGE_DRIVER === 's3') {
    const missing = (
      [
        ['STORAGE_BUCKET', env.STORAGE_BUCKET],
        ['STORAGE_ACCESS_KEY_ID', env.STORAGE_ACCESS_KEY_ID],
        ['STORAGE_SECRET_ACCESS_KEY', env.STORAGE_SECRET_ACCESS_KEY],
      ] as const
    ).filter(([, value]) => !value);
    for (const [name] of missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `STORAGE_DRIVER=s3 requires ${name}`,
      });
    }
  }

  if (env.NODE_ENV === 'production') {
    if (env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message:
          'refusing to start: STORAGE_DRIVER=local stores uploads on a container filesystem that a redeploy discards.',
      });
    }
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
