import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { Response } from 'express';
import { ZodError } from 'zod';

/** Maps a domain error's class name to an HTTP status. */
const NAME_STATUS: Record<string, number> = {
  // 400
  RoleNotFoundError: HttpStatus.BAD_REQUEST,
  // 401
  InvalidCredentialsError: HttpStatus.UNAUTHORIZED,
  InvalidOtpError: HttpStatus.UNAUTHORIZED,
  InvalidTokenError: HttpStatus.UNAUTHORIZED,
  // 403
  AccountInactiveError: HttpStatus.FORBIDDEN,
  PermissionDeniedError: HttpStatus.FORBIDDEN,
  WebhookSignatureError: HttpStatus.FORBIDDEN,
  // 404
  UserNotFoundError: HttpStatus.NOT_FOUND,
  MerchantNotFoundError: HttpStatus.NOT_FOUND,
  CustomerNotFoundError: HttpStatus.NOT_FOUND,
  EmployerNotFoundError: HttpStatus.NOT_FOUND,
  EmploymentNotFoundError: HttpStatus.NOT_FOUND,
  PlanTemplateNotFoundError: HttpStatus.NOT_FOUND,
  ApplicationNotFoundError: HttpStatus.NOT_FOUND,
  ScoringDecisionNotFoundError: HttpStatus.NOT_FOUND,
  CustomerPlanNotFoundError: HttpStatus.NOT_FOUND,
  ScheduleNotFoundError: HttpStatus.NOT_FOUND,
  PaymentAttemptNotFoundError: HttpStatus.NOT_FOUND,
  CollectionsCaseNotFoundError: HttpStatus.NOT_FOUND,
  // 409
  UserConflictError: HttpStatus.CONFLICT,
  MerchantConflictError: HttpStatus.CONFLICT,
  DuplicateEmploymentError: HttpStatus.CONFLICT,
  DuplicateApplicationError: HttpStatus.CONFLICT,
  IllegalMerchantTransitionError: HttpStatus.CONFLICT,
  IllegalEmployerTransitionError: HttpStatus.CONFLICT,
  IllegalEmploymentTransitionError: HttpStatus.CONFLICT,
  IllegalApplicationTransitionError: HttpStatus.CONFLICT,
  PlanAlreadyActiveError: HttpStatus.CONFLICT,
  InstallmentNotPayableError: HttpStatus.CONFLICT,
  InstallmentNotChargeableError: HttpStatus.CONFLICT,
  ChargeAlreadyInFlightError: HttpStatus.CONFLICT,
  ReceiptNotAvailableError: HttpStatus.CONFLICT,
  LockAcquisitionError: HttpStatus.CONFLICT,
  CaseAlreadyClosedError: HttpStatus.CONFLICT,
  // 422
  GhanaCardNotAttachedError: HttpStatus.UNPROCESSABLE_ENTITY,
  GhanaCardVerificationFailedError: HttpStatus.UNPROCESSABLE_ENTITY,
  PlanTemplateInactiveError: HttpStatus.UNPROCESSABLE_ENTITY,
  PlanActivationError: HttpStatus.UNPROCESSABLE_ENTITY,
  LedgerError: HttpStatus.UNPROCESSABLE_ENTITY,
};

interface ErrorBody {
  error: string;
  message: string;
  issues?: unknown;
}

/**
 * Single global filter: maps Zod validation errors and known domain errors to
 * the right HTTP status, passes through HttpExceptions, and reports anything
 * that resolves to 5xx to Sentry (without leaking internals to the client).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DomainExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);

    if (status >= 500) {
      Sentry.captureException(exception);
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const message =
        typeof resp === 'string'
          ? resp
          : ((resp as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          error: exception.name,
          message: Array.isArray(message) ? message.join('; ') : message,
        },
      };
    }

    if (exception instanceof ZodError || (exception as Error)?.name === 'ZodError') {
      const zerr = exception as ZodError;
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: 'ValidationError',
          message: 'Request validation failed',
          issues: zerr.issues,
        },
      };
    }

    if (exception instanceof Error && NAME_STATUS[exception.name]) {
      return {
        status: NAME_STATUS[exception.name]!,
        body: { error: exception.name, message: exception.message },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'InternalServerError', message: 'Internal server error' },
    };
  }
}
