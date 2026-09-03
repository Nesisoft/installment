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
export const NAME_STATUS: Record<string, number> = {
  // 400
  RoleNotFoundError: HttpStatus.BAD_REQUEST,
  // 401
  InvalidCredentialsError: HttpStatus.UNAUTHORIZED,
  InvalidOtpError: HttpStatus.UNAUTHORIZED,
  InvalidTokenError: HttpStatus.UNAUTHORIZED,
  // Raised by JwtService itself. Callers mostly translate these into
  // InvalidTokenError, but any path that does not must still answer 401 rather
  // than reporting a bad token as a server fault.
  JwtExpiredError: HttpStatus.UNAUTHORIZED,
  JwtInvalidError: HttpStatus.UNAUTHORIZED,
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
  PayoutNotFoundError: HttpStatus.NOT_FOUND,
  RefundNotFoundError: HttpStatus.NOT_FOUND,
  // Commerce. ProductNotFound and StoreNotFound are reachable by an anonymous
  // shopper on the public storefront — a stale link must not read as an outage.
  ProductNotFoundError: HttpStatus.NOT_FOUND,
  PickupHubNotFoundError: HttpStatus.NOT_FOUND,
  StoreNotFoundError: HttpStatus.NOT_FOUND,
  CategoryNotFoundError: HttpStatus.NOT_FOUND,
  VariantNotFoundError: HttpStatus.NOT_FOUND,
  OrderNotFoundError: HttpStatus.NOT_FOUND,
  AddressNotFoundError: HttpStatus.NOT_FOUND,
  CartItemNotFoundError: HttpStatus.NOT_FOUND,
  // 409
  UserConflictError: HttpStatus.CONFLICT,
  MerchantConflictError: HttpStatus.CONFLICT,
  MerchantKycDocumentNotFoundError: HttpStatus.NOT_FOUND,
  // Both are the caller's to fix: replace a document a reviewer has reopened,
  // or finish KYC before asking for activation.
  MerchantKycAlreadyApprovedError: HttpStatus.CONFLICT,
  MerchantKycIncompleteError: HttpStatus.UNPROCESSABLE_ENTITY,
  // A payout account nobody could confirm is a bad request, not a server
  // fault: the merchant can fix it by correcting the number or the bank.
  PayoutAccountUnresolvedError: HttpStatus.UNPROCESSABLE_ENTITY,
  UnknownBankError: HttpStatus.UNPROCESSABLE_ENTITY,
  // A category slug that names nothing is the caller's mistake, and the list of
  // valid ones is a public GET away.
  UnknownStoreCategoryError: HttpStatus.UNPROCESSABLE_ENTITY,
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
  // Same key, different request — a client bug. Replaying an unrelated cached
  // response would be worse than refusing.
  IdempotencyConflictError: HttpStatus.CONFLICT,
  // The first request with this key is still running; the client should retry.
  IdempotencyInProgressError: HttpStatus.CONFLICT,
  ReceiptNotAvailableError: HttpStatus.CONFLICT,
  LockAcquisitionError: HttpStatus.CONFLICT,
  CaseAlreadyClosedError: HttpStatus.CONFLICT,
  PhoneAlreadyRegisteredError: HttpStatus.CONFLICT,
  EmailAlreadyRegisteredError: HttpStatus.CONFLICT,
  IllegalScheduleTransitionError: HttpStatus.CONFLICT,
  ScheduleTerminalStateError: HttpStatus.CONFLICT,
  // Optimistic-lock miss: someone else moved the row. Retryable, like
  // LockAcquisitionError above.
  ScheduleConcurrencyError: HttpStatus.CONFLICT,
  PlanDefaultError: HttpStatus.CONFLICT,
  RefundNotSettleableError: HttpStatus.CONFLICT,
  // Commerce: uniqueness collisions and illegal state transitions.
  CategoryConflictError: HttpStatus.CONFLICT,
  ProductConflictError: HttpStatus.CONFLICT,
  StoreConflictError: HttpStatus.CONFLICT,
  StoreTransitionError: HttpStatus.CONFLICT,
  InvalidOrderTransitionError: HttpStatus.CONFLICT,
  OrderNotPayableError: HttpStatus.CONFLICT,
  OrderNotActivatableError: HttpStatus.CONFLICT,
  // The order is not in a state that allows this fulfilment step — including a
  // lost race with a concurrent writer, which is a retry, not a fault.
  OrderNotFulfillableError: HttpStatus.CONFLICT,
  // The order's own state refuses the cancel — it has already been paid or
  // financed, so unwinding it is a refund, not a status change.
  OrderNotCancellableError: HttpStatus.CONFLICT,
  // The stock moved under the request. A conflict with current state rather
  // than a bad request: the same call may succeed once stock returns.
  InsufficientStockError: HttpStatus.CONFLICT,
  // Already reviewed: the customer's own earlier review is the conflict.
  ReviewConflictError: HttpStatus.CONFLICT,
  // 422
  GhanaCardNotAttachedError: HttpStatus.UNPROCESSABLE_ENTITY,
  GhanaCardVerificationFailedError: HttpStatus.UNPROCESSABLE_ENTITY,
  PlanTemplateInactiveError: HttpStatus.UNPROCESSABLE_ENTITY,
  PlanActivationError: HttpStatus.UNPROCESSABLE_ENTITY,
  LedgerError: HttpStatus.UNPROCESSABLE_ENTITY,
  // Commerce. The addressed resource is fine; something it depends on is not.
  // 400 belongs to requests that did not parse — every service runs
  // schema.parse() before any domain check, so an error reaching this filter is
  // well-formed content whose instructions cannot be carried out, which is 422.
  // A body-supplied id that does not resolve lands here too: PlanActivationError
  // is already 422 for an unresolvable plan_template_id, which is exactly what
  // ProductValidationError throws.
  CategoryValidationError: HttpStatus.UNPROCESSABLE_ENTITY,
  ProductValidationError: HttpStatus.UNPROCESSABLE_ENTITY,
  NotPurchasableError: HttpStatus.UNPROCESSABLE_ENTITY,
  // Not a permission failure to be fixed by signing in differently — the item
  // simply is not in a state that can be reviewed yet (or is not theirs).
  ReviewNotAllowedError: HttpStatus.UNPROCESSABLE_ENTITY,
  // A push token the device supplied that we cannot store as given.
  DeviceRegistrationError: HttpStatus.UNPROCESSABLE_ENTITY,
  // The file, or the caller, is not one this surface issues upload URLs for —
  // wrong content type, over the size ceiling, or a purpose this token may not
  // request. Well-formed, and refused on its content.
  UploadNotAllowedError: HttpStatus.UNPROCESSABLE_ENTITY,
  EmptyCartError: HttpStatus.UNPROCESSABLE_ENTITY,
  // 502 — the SMS aggregator refused or was unreachable. Customer OTP login
  // sends synchronously, so this reaches a customer: it is an upstream fault,
  // not a bad request and not our bug, and a client may retry it.
  SmsError: HttpStatus.BAD_GATEWAY,
  // Same reasoning for the payment provider: Paystack refused or was
  // unreachable. Upstream fault, not our bug, and the client may retry.
  PaystackError: HttpStatus.BAD_GATEWAY,
  // 503 — the deployment has no object storage, so nothing can be uploaded
  // until someone configures it. Stays in the 5xx band deliberately: it is a
  // deployment gap and should keep alarming, but the client learns it is not
  // their request that was wrong and that retrying later may work.
  StorageNotConfiguredError: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * Errors we deliberately leave unmapped, so they keep falling through to 500 and
 * keep alarming. Every one fires on an invariant the code itself is supposed to
 * uphold — "entityType is required", "idempotency key is required", "unknown
 * template", "numberOfInstallments must be at least 1". Reaching any of them
 * means a bug upstream of the request, which is exactly what a 5xx and a Sentry
 * alert are for; mapping them to a 4xx would hide real defects behind a tidy
 * error message.
 *
 * This list is asserted against the source tree in the spec: a new domain error
 * must be classified here or in NAME_STATUS, never forgotten into a 500.
 */
export const INTENTIONALLY_UNMAPPED: readonly string[] = [
  // Config that ops removed. A 5xx is right: the alternative is quietly
  // charging nothing for delivery and absorbing it on every order.
  'DeliveryZoneNotConfiguredError',
  // A bucket or endpoint that cannot produce a working driver, or a key that
  // escapes the storage root. Both are our bug or our config, never the
  // caller's, and both should alarm rather than read as a rejected request.
  'StorageConfigurationError',
  'AuditError',
  'IdempotencyError',
  'NotificationTemplateError',
  'ScheduleGenerationError',
];

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
      // Honour an explicit `error` code when the thrower supplied one, so a
      // client can tell e.g. IdempotencyKeyRequired from any other 400 and
      // react correctly instead of guessing from prose.
      const code =
        typeof resp === 'object' && typeof (resp as { error?: unknown }).error === 'string'
          ? (resp as { error: string }).error
          : exception.name;
      return {
        status,
        body: {
          error: code,
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

    // A malformed identifier — `/me/orders/not-a-uuid` — reached Postgres and
    // came back as invalid_text_representation. Every route in the API answered
    // 500 to it: a client error reported as a server fault, and a Sentry alert
    // each time.
    //
    // The honest fix is to reject the value at the route boundary, but that
    // means a pipe on every :id in ~30 controllers, and the ones that are NOT
    // uuids (store slugs, references) make a blanket global pipe wrong. This
    // catches what gets through.
    //
    // The trade-off is worth stating: an invalid value we generated ourselves
    // is a bug and now answers 400 rather than alarming. That is the cost of
    // one line versus thirty pipes, and the message below is deliberately
    // generic — the driver's text carries the offending value and the whole
    // SQL statement, which must not go to a client.
    if (isInvalidTextRepresentation(exception)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          error: 'InvalidIdentifier',
          message: 'A value in the request is not a valid identifier',
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'InternalServerError', message: 'Internal server error' },
    };
  }
}

/** Postgres: the text could not be parsed as the column's type. */
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * Walks the cause chain looking for that code.
 *
 * Drizzle wraps driver errors — what reaches the filter is a `Failed query:
 * select ...` Error with the pg error underneath — so checking only the top
 * level finds nothing.
 */
function isInvalidTextRepresentation(exception: unknown): boolean {
  let current: unknown = exception;
  // Bounded: a cause chain should never be deep, and a cycle must not hang the
  // error handler.
  for (let depth = 0; current && depth < 5; depth++) {
    if (
      typeof current === 'object' &&
      (current as { code?: unknown }).code === PG_INVALID_TEXT_REPRESENTATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
