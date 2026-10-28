import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from './metrics';

/**
 * A pattern that is nothing but a wildcard (`/{*path}`, `/*path`). Middleware
 * mounted on every path, such as nestjs-pino's request logger, is registered
 * as a route like that, so a request no controller matched still carries one
 * as `req.route`. It is not a route of its own.
 */
const CATCH_ALL = /^\/?\{?\*\w+\}?$/;

/**
 * Times every HTTP request into `http_request_duration_seconds`.
 *
 * Middleware rather than an interceptor so that requests a guard turns away
 * (401, 403, 429) and requests that match no route (404) are counted too; an
 * interceptor only sees requests that got past the guards.
 *
 * Labelled by the route *pattern* (`/admin/orders/:id`), never the URL, so an
 * order id cannot become a label of its own; a request that matched no route
 * is `unmatched`. Route and status are read when the response finishes, after
 * routing and the exception filter, so a 409 from a domain error counts as a
 * 409 and not as the 200 the handler never returned.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const stop = httpRequestDuration.startTimer({ method: req.method });
    res.once('finish', () => {
      const path = (req.route as { path?: unknown } | undefined)?.path;
      const route = typeof path === 'string' && !CATCH_ALL.test(path) ? path : 'unmatched';
      if (route === '/metrics') return; // the scrape itself is not traffic
      stop({ route, status: String(res.statusCode) });
    });
    next();
  }
}
