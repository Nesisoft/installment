import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const isClientError = exception instanceof HttpException && exception.getStatus() < 500;

    if (!isClientError) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
