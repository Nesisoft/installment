import * as Sentry from '@sentry/node';

/**
 * Thin Sentry wrappers for background work. The HTTP path already reports 5xx
 * via DomainExceptionFilter; workers run outside that path, so their failures
 * would otherwise only hit the logs. When Sentry has no DSN these are safe
 * no-ops (the SDK ignores capture calls before init).
 */

/** Reports a worker/cron failure, tagged so it's filterable in Sentry. */
export function captureWorkerError(err: unknown, worker: string): void {
  Sentry.withScope((scope) => {
    scope.setTag('worker', worker);
    scope.setLevel('error');
    Sentry.captureException(err);
  });
}

/** Reports an operational alert (e.g. a degraded telco) as a Sentry message. */
export function captureAlert(
  message: string,
  level: 'warning' | 'error',
  extra: Record<string, unknown> = {},
): void {
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    for (const [k, v] of Object.entries(extra)) scope.setExtra(k, v);
    Sentry.captureMessage(message, level);
  });
}
